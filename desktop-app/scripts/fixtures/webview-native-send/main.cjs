'use strict';
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const output = path.resolve(__dirname, '../../..');
const localPrefix = pathToFileURL(__dirname + path.sep).href;
const evidence = { electron: process.versions.electron, chromium: process.versions.chrome,
  results: [], requests: [], nonLocalRequests: [], diagnostics: [] };
app.setPath('userData', path.join(output, 'profile'));
app.setPath('sessionData', path.join(output, 'profile/session'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const inputWindows = new Map();
const inputWindowFor = id => { if (!inputWindows.has(id)) inputWindows.set(id, []); return inputWindows.get(id); };
let host, other, guest, activeConfig, nextResolve;
function save() { fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(evidence, null, 2)); }
ipcMain.on('jc:webview-input', (event, payload) => {
  evidence.requests.push({ name: activeConfig?.name, action: payload.action, x: payload.x, y: payload.y,
    path: payload.path?.length, windowFocused: host.isFocused(), guestFocused: event.sender.isFocused(),
    guestZoom: event.sender.getZoomFactor(), hostZoom: host.webContents.getZoomFactor() });
});
require('./handler.cjs')({ ipcMain, BrowserWindow, inputWindows, inputWindowFor,
  dlog: (...args) => evidence.diagnostics.push(args) });
ipcMain.on('fixture-result', (_event, result) => {
  evidence.results.push(result); save(); nextResolve?.(); nextResolve = null;
});
function protect(guestSession) {
  guestSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(localPrefix);
    if (!allowed) evidence.nonLocalRequests.push(details.url);
    callback({ cancel: !allowed });
  });
}
app.on('web-contents-created', (_event, contents) => {
  contents.setMaxListeners(0);
  contents.on('will-navigate', (event, url) => { if (!url.startsWith(localPrefix)) event.preventDefault(); });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('preload-error', (_event, _file, error) => { evidence.error = 'Preload failed: ' + error.stack; save(); app.exit(1); });
});
app.whenReady().then(async () => {
  protect(session.defaultSession); protect(session.fromPartition('native-send-regression'));
  host = new BrowserWindow({ width: 1120, height: 820, show: true,
    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: false, nodeIntegration: false } });
  other = new BrowserWindow({ width: 320, height: 160, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await other.loadFile(path.join(__dirname, 'other.html'));
  const ready = new Promise(resolve => ipcMain.once('fixture-guest-ready', event => { guest = event.sender; resolve(); }));
  await host.loadFile(path.join(__dirname, 'host.html'));
  await Promise.race([ready, wait(12_000).then(() => { throw new Error('Guest preload did not become ready'); })]);
  const cases = [
    { name: 'focused-zoom1', focus: true },
    { name: 'unfocused-zoom1', focus: false },
    { name: 'unfocused-guest125', focus: false, guestZoom: 1.25 },
    { name: 'host125-guest1', focus: true, hostZoom: 1.25 },
    { name: 'guest125', focus: true, guestZoom: 1.25 },
    { name: 'host125-guest125', focus: true, hostZoom: 1.25, guestZoom: 1.25 },
    { name: 'guest80', focus: true, guestZoom: 0.8 },
    { name: 'nested-svg125', focus: true, guestZoom: 1.25, nested: true },
    { name: 'scrolled-fixed125', focus: true, guestZoom: 1.25, layout: 'fixed', nested: true },
    { name: 'guard-mutation125', focus: true, guestZoom: 1.25, guardFailure: true },
    { name: 'click-without-bubble125', focus: true, guestZoom: 1.25, noBubble: true },
    { name: 'center-overlay125', focus: true, guestZoom: 1.25, overlay: 'center' },
    { name: 'partly-clipped125', focus: true, guestZoom: 1.25, clipped: true },
    { name: 'fully-covered125', focus: true, guestZoom: 1.25, overlay: 'full', expectBlocked: true },
    { name: 'overlay-moves-after-hover125', focus: true, guestZoom: 1.25, overlay: 'moving' },
  ];
  evidence.expectedCases = cases.map(cfg => cfg.name);
  for (const cfg of cases) {
    activeConfig = cfg; inputWindows.clear();
    host.webContents.setZoomFactor(cfg.hostZoom || 1); guest.setZoomFactor(cfg.guestZoom || 1);
    if (cfg.focus) { other.hide(); host.show(); host.focus(); guest.focus(); }
    else { other.show(); other.focus(); }
    await wait(180);
    const finished = new Promise(resolve => { nextResolve = resolve; });
    guest.send('fixture-run', cfg);
    await Promise.race([finished, wait(20_000).then(() => { throw new Error('Native case timed out: ' + cfg.name); })]);
  }
  app.quit();
}).catch(error => { evidence.error = error.stack; save(); app.exit(1); });
setTimeout(() => { evidence.error = 'Native fixture global timeout'; save(); app.exit(1); }, 100_000);
