const mockElectron = {
    launch: jest.fn(() => Promise.resolve()),
    loadHTML: jest.fn(() => Promise.resolve()),
    loadURL: jest.fn(() => Promise.resolve())
};
const mockUpdater = {
    updateCache: jest.fn(() => Promise.resolve())
};

jest.mock('fs-extra');
jest.mock('electron', () => ({
    app: {
        getAppPath: jest.fn(() => '/usr/bin'),
        getPath: jest.fn(type => {
            switch(type) {
                case 'exe': return '/usr/bin/hakuneko';
                case 'appData': return 'data';
                case 'userData': return 'data/hakuneko';
                case 'userCache': return 'cache/hakuneko';
                default: return undefined;
            }
        }),
        name: 'HakuNeko'
    }
}));
jest.mock('../UpdateServerManager');
jest.mock('../CacheDirectoryManager');
jest.mock('../Updater', () => jest.fn(() => mockUpdater));
jest.mock('../ElectronBootstrap', () => jest.fn(() => mockElectron));

const fs = require('fs-extra');
const App = require('../App');
const UpdateServerManager = require('../UpdateServerManager');
const CacheDirectoryManager = require('../CacheDirectoryManager');
const Updater = require('../Updater');

describe('App update configuration', function() {
    let argv;
    let environmentPath;
    let consoleLog;

    beforeEach(() => {
        argv = process.argv;
        environmentPath = process.env.PATH;
        consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
        fs.existsSync.mockReturnValue(false);
        jest.clearAllMocks();
    });

    afterEach(() => {
        process.argv = argv;
        process.env.PATH = environmentPath;
        consoleLog.mockRestore();
    });

    it('skips update setup and loads the application when updates are disabled', async () => {
        process.argv = ['electron', '.', '--update-url=DISABLED', '--cache-directory=./src/web'];
        const testee = new App({ error: jest.fn() });

        await testee.run();

        expect(UpdateServerManager).not.toHaveBeenCalled();
        expect(CacheDirectoryManager).not.toHaveBeenCalled();
        expect(Updater).not.toHaveBeenCalled();
        expect(mockElectron.launch).toHaveBeenCalledTimes(1);
        expect(mockElectron.loadHTML).not.toHaveBeenCalled();
        expect(mockUpdater.updateCache).not.toHaveBeenCalled();
        expect(mockElectron.loadURL).toHaveBeenCalledWith('hakuneko://cache/index.html');
    });

    it('keeps the update flow for a valid update URL', async () => {
        process.argv = ['electron', '.', '--update-url=https://example.test/latest', '--cache-directory=./src/web'];
        const testee = new App({ error: jest.fn() });

        await testee.run();

        expect(UpdateServerManager).toHaveBeenCalledWith('https://example.test/latest', expect.anything());
        expect(CacheDirectoryManager).toHaveBeenCalledTimes(1);
        expect(Updater).toHaveBeenCalledTimes(1);
        expect(mockElectron.loadHTML).toHaveBeenCalledTimes(1);
        expect(mockUpdater.updateCache).toHaveBeenCalledTimes(1);
        expect(mockElectron.loadURL).toHaveBeenCalledWith('hakuneko://cache/index.html');
    });
});
