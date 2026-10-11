// material-path-regression.mjs —— 补充材料「按路径读取」防护回归
//
// 背景（2026-10-11 代码审查 H-6 / M-3）：
//   报告原建议 `jc:material-read` 只允许 `materialPick` 选过的路径。实测该口径有 UX 回归——
//   用户历史素材只记在渲染层 localStorage（experienceMaterials），主进程无从知晓 → 升级后必须逐个重选。
//   最终采用「不做路径预授权 + 敏感文件名/目录黑名单 + 扩展名白名单 + 20MB 上限」。
//
// 本脚本的职责：锁住该口径，并防止未来有人再把它「优化」成路径白名单（会重演重选回归）。
//
// 取证方式：从 electron/main.cjs **真实代码切片**里取出 isSensitiveMaterialPath 与扩展名白名单，
// 在 vm 沙箱里执行后断言——不是复制一遍逻辑（那样只能证明副本自洽）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import path from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const MAIN = join(root, 'electron', 'main.cjs');
const src = readFileSync(MAIN, 'utf8');

const START = '// 素材扩展名白名单（P4-10';
const END = "safeHandle('jc:material-pick'";
const start = src.indexOf(START);
const end = src.indexOf(END);
if (start < 0 || end < 0 || end <= start) {
  console.error('❌ 无法定位 main.cjs 中「补充材料防护」代码段（标记被改动？请同步更新本脚本）');
  process.exit(1);
}

const sandbox = { path, console };
createContext(sandbox);
runInContext(`${src.slice(start, end)}\nthis.__check = isSensitiveMaterialPath;\nthis.__ext = MATERIAL_EXT_WHITELIST;`, sandbox, {
  filename: 'main.cjs#material-guard',
});
const isSensitive = sandbox.__check;
const EXT_WHITELIST = sandbox.__ext;

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  if (Object.is(actual, expected)) pass += 1;
  else failures.push(`${name}\n      期望：${JSON.stringify(expected)}\n      实际：${JSON.stringify(actual)}`);
}

// ===== 一、敏感路径黑名单：正常素材必须放行（不得产生重选回归）=====
const W = (...segs) => ['C:', 'Users', 'DELL', ...segs].join('\\');
check('桌面素材放行', isSensitive(W('Desktop', '我的简历补充.txt')), false);
check('文档素材放行', isSensitive(W('Documents', '实习证明.pdf')), false);
check('下载素材放行', isSensitive(W('Downloads', '项目经历.md')), false);
check('非系统盘素材放行', isSensitive('D:\\求职\\项目经历.md'), false);
check('中文目录素材放行', isSensitive('E:\\我的资料\\补充材料\\经历.txt'), false);
check('POSIX 桌面素材放行', isSensitive('/home/u/Desktop/notes.md'), false);

// ===== 二、敏感文件名（凭据类）=====
check('passwords.txt 拒绝', isSensitive(W('Desktop', 'passwords.txt')), true);
check('my_secret_notes.md 拒绝', isSensitive(W('Desktop', 'my_secret_notes.md')), true);
check('api_key.md 拒绝', isSensitive(W('Desktop', 'api_key.md')), true);
check('账号密码.txt 拒绝', isSensitive(W('Desktop', '账号密码.txt')), true);
check('id_rsa.txt 拒绝', isSensitive(W('.ssh', 'id_rsa.txt')), true);
check('简历.txt 放行（不含敏感词）', isSensitive(W('Desktop', '简历.txt')), false);

// ===== 三、敏感目录 =====
check('.ssh 目录拒绝', isSensitive(W('.ssh', 'config.txt')), true);
check('.gnupg 目录拒绝', isSensitive(W('.gnupg', 'x.txt')), true);
check('.aws 目录拒绝', isSensitive(W('.aws', 'credentials.txt')), true);
check('.config/gcloud 拒绝', isSensitive(W('.config', 'gcloud', 'creds.txt')), true);
check('.config/gh 拒绝', isSensitive(W('.config', 'gh', 'hosts.txt')), true);
check('Windows 系统目录拒绝', isSensitive('C:\\Windows\\System32\\drivers\\etc\\hosts.txt'), true);
check('Program Files 拒绝', isSensitive('C:\\Program Files\\App\\data.txt'), true);
check('AppData\\\\Roaming\\\\Microsoft 拒绝', isSensitive(W('AppData', 'Roaming', 'Microsoft', 'Templates', 'a.txt')), true);
check('浏览器配置目录拒绝', isSensitive(W('AppData', 'Roaming', 'Mozilla', 'x', 'logins.txt')), true);
check('POSIX /etc 拒绝', isSensitive('/etc/hosts.txt'), true);
check('POSIX /System 拒绝', isSensitive('/System/Library/x.txt'), true);

// ===== 四、扩展名白名单（与 jc:material-pick 的 filters 同源）=====
check('扩展名白名单内容', EXT_WHITELIST.join('/'), 'pdf/docx/doc/md/markdown/txt/text');
check('凭据类扩展名天然不在白名单', EXT_WHITELIST.includes('env') || EXT_WHITELIST.includes('pem') || EXT_WHITELIST.includes('key') || EXT_WHITELIST.includes('sqlite'), false);

// ===== 五、防回归：不得再引入「路径预授权白名单」=====
check('main.cjs 不再写 userData 路径白名单文件',
  /materialAllowlistFile|rememberMaterialPaths|loadMaterialAllowlist|\.material-paths\.json/.test(src), false);

console.log(`\n[补充材料路径防护回归] 通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过：正常素材零回归放行，凭据类文件/系统目录拒绝，且未回退为路径预授权白名单');
