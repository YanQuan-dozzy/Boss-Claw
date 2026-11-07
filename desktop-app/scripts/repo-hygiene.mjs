// repo-hygiene.mjs —— 共用文件的「口径守卫」
//
// 背景：公开仓库（origin）与私有仓库（private）共用同一份 `README.md` 与 `.gitignore`，
// 但私有仓库里有一批只应存在于内部的东西（内部文档、隐藏内容的源数据、维护者说明）。
// 一旦把「私有仓库 / private / .local/ / 隐藏内容」这类内部口径写进上面两个文件，
// 就会随任何一次 cherry-pick 泄漏到公开仓库 —— 这类串味不报错、不影响构建，只能靠人眼发现。
//
// 断言：目标为 public 时，两个共用文件不得命中内部词表。
// 私有仓库自己不需要检查（它本来就该出现这些词）。
//
// 用法：
//   node scripts/repo-hygiene.mjs                 # 默认按 public 口径检查
//   node scripts/repo-hygiene.mjs --target private
//   （EXIT 0 = 通过，1 = 有命中）
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url))); // desktop-app/
const repoRoot = dirname(root);

const argv = process.argv.slice(2);
const targetIdx = argv.indexOf('--target');
const target = targetIdx >= 0 ? String(argv[targetIdx + 1] || 'public') : 'public';

/** 共用文件：两个仓库都会拿到，必须写公开口径 */
const SHARED_FILES = ['README.md', '.gitignore'];

/**
 * 内部词表：出现即代表「私有口径串进了共用文件」。
 * 每条给理由，便于判断命中是误报还是真泄漏。
 */
const FORBIDDEN = [
  { re: /私有仓库|私有分发|私有\/?公开/, why: '提到仓库形态（公开仓库读者不该看到「私有仓库」）' },
  { re: /Boss-Claw-private/i, why: '暴露私有仓库地址' },
  { re: /(^|[^a-z/])\.local\//, why: '暴露隐藏内容的源数据目录' },
  { re: /隐藏彩蛋|隐藏内容|内部注入/, why: '暴露隐藏内容的存在' },
  { re: /git config core\.hooksPath/, why: '只对私有仓库成立的配置步骤' },
  // docs/ 是私有仓库独有的目录；注意不要误伤 desktop-app/resources/docs/
  { re: /(^|[^a-z/])docs\//, why: 'internal docs 只随私有仓库分发，公开仓库没有该目录' },
];

/** 逐行扫描，返回命中列表 */
function scan(file) {
  const text = readFileSync(join(repoRoot, file), 'utf8');
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const rule of FORBIDDEN) {
      if (rule.re.test(line)) hits.push({ file, line: i + 1, text: line.trim().slice(0, 90), why: rule.why });
    }
  });
  return hits;
}

if (target !== 'public') {
  console.log(`[共用文件口径] 目标为 ${target}，无需检查（内部口径在该仓库属正常）`);
  process.exit(0);
}

const hits = SHARED_FILES.flatMap(scan);
if (hits.length === 0) {
  console.log(`[共用文件口径] 通过：${SHARED_FILES.join(' / ')} 无内部口径字样（目标 public）`);
  process.exit(0);
}

console.error(`[共用文件口径] 失败：${hits.length} 处内部口径出现在共用文件里（目标 public）`);
for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.text}\n      ↳ ${h.why}`);
console.error('\n  处理：把这段说明移到 README.private.md 或 docs/ 下，共用文件只写公开口径。');
process.exit(1);
