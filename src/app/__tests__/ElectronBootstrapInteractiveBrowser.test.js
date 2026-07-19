const mockBeforeSendHeaders = jest.fn();
const mockHeadersReceived = jest.fn();
const mockDefaultSession = {
    webRequest: {
        onBeforeSendHeaders: mockBeforeSendHeaders,
        onHeadersReceived: mockHeadersReceived
    }
};

jest.mock('electron', () => ({
    BrowserWindow: jest.fn(),
    session: { defaultSession: mockDefaultSession },
    app: { on: jest.fn(), setPath: jest.fn() },
    ipcMain: { on: jest.fn(), once: jest.fn() },
    protocol: { registerSchemesAsPrivileged: jest.fn() }
}));
jest.mock('@electron/remote/main', () => ({ initialize: jest.fn(), enable: jest.fn() }));

const ElectronBootstrap = require('../ElectronBootstrap');

describe('ElectronBootstrap interactive browser integration', function() {

    let testee;
    let logger;

    beforeEach(() => {
        jest.clearAllMocks();
        logger = { warn: jest.fn() };
        testee = new ElectronBootstrap({
            applicationProtocol: 'hakuneko',
            connectorProtocol: 'connector'
        }, logger);
        testee._interactiveBrowser = {
            hasWebContentsID: jest.fn(),
            isFirstPartyURL: jest.fn(),
            open: jest.fn()
        };
        testee._ipcSend = jest.fn();
    });

    it('does not rewrite request headers from an interactive window', async () => {
        testee._interactiveBrowser.hasWebContentsID.mockReturnValue(true);
        testee._setupBeforeSendHeaders();
        let handler = mockBeforeSendHeaders.mock.calls[0][1];
        let callback = jest.fn();
        let details = { webContentsId: 7, url: 'https://accounts.google.com/', requestHeaders: { Test: 'original' } };

        await handler(details, callback);

        expect(testee._ipcSend).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({ cancel: false, requestHeaders: details.requestHeaders });
    });

    it('preserves provider response headers and prepares valid first-party cookies locally', async () => {
        testee._interactiveBrowser.hasWebContentsID.mockReturnValue(true);
        testee._interactiveBrowser.isFirstPartyURL.mockReturnValueOnce(false).mockReturnValueOnce(true);
        testee._setupHeadersReceived();
        let handler = mockHeadersReceived.mock.calls[0][1];
        let providerCallback = jest.fn();
        let cmoaCallback = jest.fn();
        let provider = { webContentsId: 7, url: 'https://accounts.google.com/', responseHeaders: { 'Set-Cookie': ['provider=original'] } };
        let cmoa = { webContentsId: 7, url: 'https://member.cmoa.jp/apple/login/', responseHeaders: { 'Set-Cookie': ['session=value; Path=/; HttpOnly'] } };

        await handler(provider, providerCallback);
        await handler(cmoa, cmoaCallback);

        expect(providerCallback).toHaveBeenCalledWith({ cancel: false, responseHeaders: provider.responseHeaders });
        expect(testee._ipcSend).not.toHaveBeenCalled();
        expect(cmoaCallback).toHaveBeenCalledWith({
            cancel: false,
            responseHeaders: { 'Set-Cookie': ['session=value; Path=/; HttpOnly; Secure; SameSite=None'] }
        });
    });

    it('rejects certificate errors inside the interactive browser', () => {
        let event = { preventDefault: jest.fn() };
        let callback = jest.fn();
        testee._interactiveBrowser.hasWebContentsID.mockReturnValue(true);

        testee._certificateErrorHandler(event, { id: 7 }, 'https://www.cmoa.jp', 'error', {}, callback);

        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(false);
    });

    it('only accepts open requests from the main renderer', () => {
        let sender = {};
        testee._window = { webContents: sender };

        testee._openInteractiveBrowserHandler({ sender }, {
            url: 'https://www.cmoa.jp/auth/login/',
            title: 'Cmoa',
            cookieDomain: 'cmoa.jp'
        });
        testee._openInteractiveBrowserHandler({ sender: {} }, { url: 'https://example.com' });

        expect(testee._interactiveBrowser.open).toHaveBeenCalledTimes(1);
        expect(testee._interactiveBrowser.open).toHaveBeenCalledWith(
            'https://www.cmoa.jp/auth/login/',
            'Cmoa',
            'cmoa.jp'
        );
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });
});
