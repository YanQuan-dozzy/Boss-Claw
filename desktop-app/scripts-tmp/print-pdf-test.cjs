// 临时验证：Electron 隐藏窗口 printToPDF 渲染 sample-resume.html → sample-resume.pdf（跑完即删）
// 运行：env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/electron/dist/electron.exe scripts-tmp/print-pdf-test.cjs
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const htmlPath = path.join(__dirname, 'sample-resume.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const win = new BrowserWindow({
      show: false,
      width: 842,
      height: 1191,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 600)); // 等字体/布局稳定
    const pdf = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { marginType: 'none' },
    });
    const out = path.join(__dirname, 'sample-tailored-resume.pdf');
    fs.writeFileSync(out, pdf);
    const head = pdf.slice(0, 5).toString();
    console.log('PDF bytes:', pdf.length, '| header:', head, '| A4 ok:', head === '%PDF-');
    // 用无头检查 PDF 页数（简单统计 /Type /Page 非 /Pages）
    const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    console.log('page count ~', pageCount);
    win.destroy();
    app.exit(0);
  } catch (e) {
    console.error('PRINT_PDF_FAILED:', e && e.message);
    app.exit(1);
  }
});
