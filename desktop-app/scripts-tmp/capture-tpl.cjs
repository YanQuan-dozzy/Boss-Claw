// 模板视觉截图：加载 resume-<id>.html → capturePage → scripts-tmp/shot-<id>.png
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const id = (process.argv.slice(2).find((a) => !a.startsWith('-')) || 'classic');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const htmlPath = path.join(__dirname, `resume-${id}.html`);
    const win = new BrowserWindow({
      show: true,
      x: -10000,
      y: 0,
      width: 842,
      height: 1191,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await win.loadFile(htmlPath);
    await new Promise((r) => setTimeout(r, 800)); // 等字体/布局
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 842, height: 1191 });
    fs.writeFileSync(path.join(__dirname, `shot-${id}.png`), img.toPNG());
    console.log('shot written:', `shot-${id}.png`, img.getSize());
    win.destroy();
    app.exit(0);
  } catch (e) {
    console.error('SHOT_FAILED:', e && e.message);
    app.exit(1);
  }
});
