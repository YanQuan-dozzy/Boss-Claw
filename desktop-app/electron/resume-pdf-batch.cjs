'use strict';
const fs = require('node:fs');
const path = require('node:path');

function validatePdfItem(item) {
  const fileName = String(item?.fileName || '').trim();
  const html = String(item?.html || '');
  if (!/^[\w\u4e00-\u9fa5()（）\-· ]{1,120}\.pdf$/i.test(fileName)) throw new Error('PDF 文件名不合法');
  if (html.length < 200 || !/<!DOCTYPE html>/i.test(html)) throw new Error('HTML 内容不完整，无法生成 PDF');
  return { fileName, html };
}

/** wx 以排他方式创建文件；旧文件及本批同名输出均保留，避免先检查再写的竞态。 */
async function writeUniquePdf(directory, fileName, pdf) {
  const root = path.resolve(directory);
  const stem = fileName.replace(/\.pdf$/i, '');
  for (let suffix = 0; suffix < 10000; suffix++) {
    const name = suffix ? `${stem} (${suffix + 1}).pdf` : fileName;
    const filePath = path.resolve(root, name);
    if (path.dirname(filePath) !== root) throw new Error('PDF 路径必须位于所选目录内');
    try {
      await fs.promises.writeFile(filePath, pdf, { flag: 'wx' });
      return filePath;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('同名文件过多，请选择其他目录');
}

module.exports = { validatePdfItem, writeUniquePdf };
