const EventEmitter = require('events');
const InteractiveBrowserManager = require('../InteractiveBrowserManager');

class FakeWebContents extends EventEmitter {

    constructor(id) {
        super();
        this.id = id;
        this.setUserAgent = jest.fn();
        this.setWindowOpenHandler = jest.fn(handler => {
            this.windowOpenHandler = handler;
        });
    }
}

class FakeBrowserWindow extends EventEmitter {

    constructor(options) {
        super();
        this.options = options;
        this.webContents = new FakeWebContents(FakeBrowserWindow.instances.length + 1);
        this.loadURL = jest.fn(() => Promise.resolve());
        FakeBrowserWindow.instances.push(this);
    }
}

describe('InteractiveBrowserManager', function() {

    let browserSession;
    let parentWindow;
    let testee;

    beforeEach(() => {
        FakeBrowserWindow.instances = [];
        browserSession = { name: 'defaultSession' };
        parentWindow = { name: 'mainWindow' };
        testee = new InteractiveBrowserManager(
            FakeBrowserWindow,
            browserSession,
            () => parentWindow,
            { warn: jest.fn() },
            'darwin',
            '150.0.7871.114'
        );
    });

    it('uses the actual Chromium version without Electron in the user agent', () => {
        let userAgent = InteractiveBrowserManager.createUserAgent('darwin', '150.0.7871.114');

        expect(userAgent).toContain('Chrome/150.0.7871.114');
        expect(userAgent).toContain('Macintosh; Intel Mac OS X 10_15_7');
        expect(userAgent).not.toContain('Electron');
        expect(userAgent).not.toContain('HakuNeko');
    });

    it('only accepts web URLs and an explicitly allowed blank popup', () => {
        expect(InteractiveBrowserManager.isAllowedURL('https://www.cmoa.jp/auth/login/')).toBe(true);
        expect(InteractiveBrowserManager.isAllowedURL('http://localhost/login')).toBe(true);
        expect(InteractiveBrowserManager.isAllowedURL('about:blank', true)).toBe(true);
        expect(InteractiveBrowserManager.isAllowedURL('about:blank')).toBe(false);
        expect(InteractiveBrowserManager.isAllowedURL('file:///tmp/passwords')).toBe(false);
        expect(InteractiveBrowserManager.isAllowedURL('javascript:alert(1)')).toBe(false);
        expect(InteractiveBrowserManager.isAllowedURL(undefined)).toBe(false);
    });

    it('keeps first-party OAuth cookies valid when making them cross-site', () => {
        let headers = {
            'set-cookie': [
                'prod_member_db_session=session; Path=/; HttpOnly',
                'RETURN_TO_URL=return; Path=/; Secure; SameSite=Lax'
            ]
        };

        expect(InteractiveBrowserManager.prepareFirstPartyResponseHeaders('https://member.cmoa.jp/apple/login/', headers)).toEqual({
            'set-cookie': [
                'prod_member_db_session=session; Path=/; HttpOnly; Secure; SameSite=None',
                'RETURN_TO_URL=return; Path=/; Secure; SameSite=None'
            ]
        });
    });

    it('does not create invalid SameSite=None cookies on HTTP responses', () => {
        let headers = { 'Set-Cookie': 'session=value; Path=/' };

        expect(InteractiveBrowserManager.prepareFirstPartyResponseHeaders('http://example.com/login', headers)).toBe(headers);
        expect(headers['Set-Cookie']).toBe('session=value; Path=/');
    });

    it('never weakens SameSite for domains other than cmoa.jp', () => {
        let headers = { 'set-cookie': 'session=value; Path=/; Secure; SameSite=Lax' };

        expect(InteractiveBrowserManager.prepareFirstPartyResponseHeaders('https://accounts.google.com/oauth/callback', headers)).toBe(headers);
        expect(headers['set-cookie']).toBe('session=value; Path=/; Secure; SameSite=Lax');
    });

    it('opens an isolated window on the shared session', () => {
        let window = testee.open('https://www.cmoa.jp/auth/login/', 'Cmoa', 'cmoa.jp');

        expect(window.options.parent).toBe(parentWindow);
        expect(window.options.webPreferences).toMatchObject({
            session: browserSession,
            nodeIntegration: false,
            nodeIntegrationInWorker: false,
            nodeIntegrationInSubFrames: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false
        });
        expect(window.webContents.setUserAgent).toHaveBeenCalledWith(expect.stringContaining('Chrome/150.0.7871.114'));
        expect(window.loadURL).toHaveBeenCalledWith('https://www.cmoa.jp/auth/login/', {
            userAgent: expect.stringContaining('Chrome/150.0.7871.114')
        });
        expect(testee.hasWebContentsID(window.webContents.id)).toBe(true);
        expect(testee.isFirstPartyURL(window.webContents.id, 'https://member.cmoa.jp/openid/provider/')).toBe(true);
        expect(testee.isFirstPartyURL(window.webContents.id, 'https://accounts.google.com/')).toBe(false);
    });

    it('creates secure child windows before provider navigation', () => {
        let parent = testee.open('https://www.cmoa.jp/auth/login/', 'Cmoa', 'cmoa.jp');
        let allow = parent.webContents.windowOpenHandler({ url: 'https://appleid.apple.com/auth/authorize' });
        let childContents = allow.createWindow({
            width: 480,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                sandbox: false,
                webSecurity: false,
                session: { name: 'untrustedSession' }
            }
        });
        let child = FakeBrowserWindow.instances[1];

        expect(allow.action).toBe('allow');
        expect(childContents).toBe(child.webContents);
        expect(child.options.parent).toBe(parent);
        expect(child.options.width).toBe(480);
        expect(child.options.webPreferences).toMatchObject({
            session: browserSession,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true
        });
        expect(child.webContents.setUserAgent).toHaveBeenCalledWith(expect.stringContaining('Chrome/150.0.7871.114'));
        expect(testee.hasWebContentsID(child.webContents.id)).toBe(true);
        expect(testee.isFirstPartyURL(child.webContents.id, 'https://www.cmoa.jp/auth/resp/')).toBe(true);
        expect(child.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    });

    it('blocks unsafe popups and navigations', () => {
        let window = testee.open('https://www.cmoa.jp/auth/login/', 'Cmoa', 'cmoa.jp');
        let event = { preventDefault: jest.fn() };

        expect(window.webContents.windowOpenHandler({ url: 'file:///tmp/passwords' })).toEqual({ action: 'deny' });
        window.webContents.emit('will-navigate', event, 'javascript:alert(1)');
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('forgets web contents after they are destroyed', () => {
        let window = testee.open('https://www.cmoa.jp/auth/login/', 'Cmoa', 'cmoa.jp');

        window.webContents.emit('destroyed');

        expect(testee.hasWebContentsID(window.webContents.id)).toBe(false);
        expect(testee.isFirstPartyURL(window.webContents.id, 'https://www.cmoa.jp/')).toBe(false);
    });

    it('rejects unsupported top-level URLs', () => {
        expect(() => testee.open('file:///tmp/passwords', 'Unsafe')).toThrow('unsupported browser URL');
        expect(FakeBrowserWindow.instances).toHaveLength(0);
    });
});
