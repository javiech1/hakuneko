const allowedProtocols = new Set(['http:', 'https:']);

module.exports = class InteractiveBrowserManager {

    constructor(BrowserWindow, browserSession, getParentWindow, logger, platform = process.platform, chromeVersion = process.versions.chrome) {
        this._BrowserWindow = BrowserWindow;
        this._session = browserSession;
        this._getParentWindow = getParentWindow;
        this._logger = logger;
        this._windows = new Set();
        this._webContentsIDs = new Set();
        this._cookieDomains = new Map();
        this._userAgent = InteractiveBrowserManager.createUserAgent(platform, chromeVersion);
    }

    static createUserAgent(platform, chromeVersion) {
        let operatingSystem;
        switch(platform) {
            case 'darwin':
                operatingSystem = 'Macintosh; Intel Mac OS X 10_15_7';
                break;
            case 'win32':
                operatingSystem = 'Windows NT 10.0; Win64; x64';
                break;
            default:
                operatingSystem = 'X11; Linux x86_64';
                break;
        }
        return `Mozilla/5.0 (${operatingSystem}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    }

    static isAllowedURL(uri, allowBlank = false) {
        if(allowBlank && uri === 'about:blank') {
            return true;
        }
        try {
            return allowedProtocols.has(new URL(uri).protocol);
        } catch(error) {
            return false;
        }
    }

    // Weakening SameSite is only reviewed/authorized for cmoa.jp's own login flow.
    // Keep this list narrow so no other connector can widen cookie exposure by
    // simply opening the interactive browser against a different domain.
    static get SAME_SITE_REWRITE_DOMAINS() {
        return ['cmoa.jp'];
    }

    static _isSameSiteRewriteAllowed(hostname) {
        let normalized = hostname.toLowerCase();
        return InteractiveBrowserManager.SAME_SITE_REWRITE_DOMAINS.some(domain => normalized === domain || normalized.endsWith('.' + domain));
    }

    static prepareFirstPartyResponseHeaders(uri, headers) {
        let url;
        try {
            url = new URL(uri);
        } catch(error) {
            return headers;
        }
        if(url.protocol !== 'https:' || !InteractiveBrowserManager._isSameSiteRewriteAllowed(url.hostname)) {
            return headers;
        }

        let cookieHeader = headers['set-cookie'] ? 'set-cookie' : 'Set-Cookie';
        let cookies = headers[cookieHeader];
        if(!cookies) {
            return headers;
        }

        let prepareCookie = cookie => {
            let parts = cookie.split(';').map(part => part.trim()).filter(Boolean);
            parts = parts.filter(part => !/^SameSite=/i.test(part));
            if(!parts.some(part => /^Secure$/i.test(part))) {
                parts.push('Secure');
            }
            parts.push('SameSite=None');
            return parts.join('; ');
        };
        headers[cookieHeader] = Array.isArray(cookies) ? cookies.map(prepareCookie) : prepareCookie(cookies);
        return headers;
    }

    hasWebContentsID(id) {
        return this._webContentsIDs.has(id);
    }

    isFirstPartyURL(id, uri) {
        let cookieDomain = this._cookieDomains.get(id);
        if(!cookieDomain) {
            return false;
        }
        try {
            let hostname = new URL(uri).hostname;
            return hostname === cookieDomain || hostname.endsWith('.' + cookieDomain);
        } catch(error) {
            return false;
        }
    }

    open(uri, title, cookieDomain) {
        if(!InteractiveBrowserManager.isAllowedURL(uri)) {
            throw new Error(`Refusing to open unsupported browser URL: ${uri}`);
        }

        let normalizedDomain = (cookieDomain || new URL(uri).hostname).replace(/^\./, '').toLowerCase();
        let window = this._createWindow(this._getParentWindow(), { title }, normalizedDomain);
        window.loadURL(uri, { userAgent: this._userAgent }).catch(error => this._logger && this._logger.warn(error));
        return window;
    }

    _createWindow(parent, inheritedOptions = {}, cookieDomain) {
        let inheritedPreferences = inheritedOptions.webPreferences || {};
        let window = new this._BrowserWindow({
            ...inheritedOptions,
            width: inheritedOptions.width || 1024,
            height: inheritedOptions.height || 760,
            minWidth: 640,
            minHeight: 480,
            parent,
            show: true,
            autoHideMenuBar: true,
            webPreferences: {
                ...inheritedPreferences,
                session: this._session,
                nodeIntegration: false,
                nodeIntegrationInWorker: false,
                nodeIntegrationInSubFrames: false,
                contextIsolation: true,
                sandbox: true,
                webSecurity: true,
                allowRunningInsecureContent: false
            }
        });
        this._configureWindow(window, cookieDomain);
        return window;
    }

    _configureWindow(window, cookieDomain) {
        let webContentsID = window.webContents.id;
        this._windows.add(window);
        this._webContentsIDs.add(webContentsID);
        this._cookieDomains.set(webContentsID, cookieDomain);
        window.webContents.setUserAgent(this._userAgent);

        window.webContents.on('destroyed', () => {
            this._webContentsIDs.delete(webContentsID);
            this._cookieDomains.delete(webContentsID);
        });
        window.on('closed', () => this._windows.delete(window));
        let navigationHandler = (event, uri) => {
            if(!InteractiveBrowserManager.isAllowedURL(uri, true)) {
                event.preventDefault();
            }
        };
        window.webContents.on('will-navigate', navigationHandler);
        window.webContents.on('will-redirect', navigationHandler);
        window.webContents.setWindowOpenHandler(details => {
            if(!InteractiveBrowserManager.isAllowedURL(details.url, true)) {
                return { action: 'deny' };
            }
            return {
                action: 'allow',
                createWindow: options => this._createWindow(window, options, cookieDomain).webContents
            };
        });
    }
};
