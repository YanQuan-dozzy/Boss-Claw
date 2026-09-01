// 多模板 PDF 渲染验证：读 scripts-tmp/resume-<id>.html → printToPDF → resume-<id>.pdf
// 运行：env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/electron/dist/electron.exe scripts-tmp/print-all-pdf.cjs [tplId...]
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const rawIds = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const ids = rawIds.length ? rawIds : ['classic', 'minimal', 'sidebar', 'warm', 'green'];
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    for (const id of ids) {
      const htmlPath = path.join(__dirname, `resume-${id}.html`);
      const out = path.join(__dirname, `sample-${id}.pdf`);
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
        const win = new BrowserWindow({
          show: false,
          width: 842,
          height: 1191,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        try {
          await win.loadFile(htmlPath);
          await new Promise((r) => setTimeout(r, 2500));
          const pdf = await win.webContents.printToPDF({
            pageSize: 'A4',
            printBackground: true,
            margins: { marginType: 'none' },
          });
          fs.writeFileSync(out, pdf);
          const head = pdf.slice(0, 5).toString();
          const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
          console.log(`${id.padEnd(8)} ${String(pdf.length).padStart(7)} bytes  %PDF=${head === '%PDF-'}  pages~${pageCount}`);
          ok = true;
        } catch (e) {
          console.log(`${id} attempt ${attempt + 1} failed: ${e && e.message}`);
        } finally {
          try { win.destroy(); } catch {}
        }
        if (!ok) await new Promise((r) => setTimeout(r, 400));
      }
      if (!ok) console.log(`${id} FAILED after retries`);
    }
    app.exit(0);
  } catch (e) {
    console.error('PRINT_FAILED:', e && e.message);
    app.exit(1);
  }
});
