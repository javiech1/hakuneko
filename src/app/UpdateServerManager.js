const url = require('url');
const http = require('http');
const https = require('https');
const { ConsoleLogger } = require('@logtrine/logtrine');
const UpdatePackageInfo = require('./UpdatePackageInfo');

module.exports = class UpdateServerManager {

    // Timeout for the initial version check / redirect requests (small payload, should be quick).
    static get REQUEST_TIMEOUT() {
        return 15000;
    }

    // Timeout for downloading the update archive itself (larger payload, may legitimately take longer).
    static get ARCHIVE_REQUEST_TIMEOUT() {
        return 60000;
    }

    constructor(applicationUpdateURL, logger) {
        try {
            this._logger = logger || new ConsoleLogger(ConsoleLogger.LEVEL.Warn);
            // NOTE: simple hack to check if URL is valid (must not throw error)
            url.parse(applicationUpdateURL, true).hostname.length;
            this._applicationUpdateURL = applicationUpdateURL;
        } catch(error) {
            this._logger.warn('Initialization of "UpdateServerManager" failed!', error);
            this._applicationUpdateURL = undefined;
        }
    }

    /**
     *
     * @param {string | URL | RequestOptions} options
     */
    _getClient(options) {
        let uri = '';
        if(typeof options === 'string') {
            uri = options;
        }
        if(typeof options['href'] === 'string') {
            uri = options['href'];
        }
        if(typeof options['url'] === 'string') {
            uri = options['url'];
        }
        return uri.startsWith('https:') ? https : http;
    }

    /**
     * Download content via HTTP(S).
     * @param {string | URL | RequestOptions} options
     * @param {number} timeout Milliseconds to wait for the request to complete before aborting it.
     * @param {number} redirectsLeft Maximum number of "location" redirects left to follow.
     */
    _request(options, timeout = UpdateServerManager.REQUEST_TIMEOUT, redirectsLeft = 5) {
        return new Promise((resolve, reject) => {
            if(!options) {
                throw new Error('Invalid request for connection to the update server!');
            }
            let settled = false;
            let resolveOnce = data => {
                if(!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(data);
                }
            };
            let rejectOnce = error => {
                if(!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(error);
                }
            };
            let request = this._getClient(options).request(options, response => {
                if(response.headers.location && response.headers.location.startsWith('http')) {
                    if(redirectsLeft <= 0) {
                        rejectOnce(new Error('Too many redirects while connecting to the update server!'));
                        return;
                    }
                    this._request(response.headers.location, timeout, redirectsLeft - 1)
                        .then(data => resolveOnce(data))
                        .catch(error => rejectOnce(error));
                    return;
                }
                if(response.statusCode !== 200) {
                    rejectOnce(new Error('Status: ' + response.statusCode));
                    return;
                }
                let data = [];
                //response.setEncoding('utf8');
                response.on('data', chunk => data.push(chunk));
                response.on('end', () => resolveOnce(Buffer.concat(data)));
            } );
            request.on('error', error => rejectOnce(error));
            /*
             * NOTE: request.setTimeout() only arms once the socket is connected, so it never fires
             * while stuck resolving DNS or waiting on a TCP handshake that never completes. A plain
             * timer guards the whole request lifecycle regardless of connection state.
             */
            let timer = setTimeout(() => {
                request.destroy();
                rejectOnce(new Error('Update server request timed out after ' + timeout + 'ms'));
            }, timeout);
            //request.write(/* REQUEST BODY */);
            request.end();
        });
    }

    /**
     * @returns {Promise<UpdatePackageInfo>}
     */
    getUpdateInfo() {
        return this._request(this._applicationUpdateURL)
            .then(data => {
                let link = data.toString('utf8').trim();
                let info = new UpdatePackageInfo(link.split('.')[0], url.parse(link, true).query.signature, url.resolve(this._applicationUpdateURL, link));
                return Promise.resolve(info);
            });
    }

    /**
     *
     * @param {UpdatePackageInfo} info The update package information received with getUpdateInfo()
     * @returns {Promise<Uint8Array>} A promise that resolves with the received bytes
     */
    getUpdateArchive(info) {
        return this._request(info.link, UpdateServerManager.ARCHIVE_REQUEST_TIMEOUT);
    }
};