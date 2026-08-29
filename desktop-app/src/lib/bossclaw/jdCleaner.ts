// lib/bossclaw/jdCleaner.ts —— 岗位 JD 噪声清洗（渲染层版）
//
// 背景：webview.cjs DOM 兜底采集（detailRoot 匹配到过大容器）或用户从 BOSS 页面整页复制时，
// 文本会混入页面级噪音——「去App 与BOSS随时沟通」「求职工具 升级VIP」「热门职位/热门城市/
// 热门企业/附近城市」推荐区、标题行操作按钮「收藏/立即沟通/举报/微信扫码分享」。
// 此工具与 electron/preload/webview.cjs 的 cleanJobDescription 规则保持一致（改动须同步两边），
// 供定制简历等页面在「导入岗位 JD / 手动粘贴」时清洗历史脏数据与复制噪声。

const JD_NOISE_TERMINATORS = [
  '去App', '前往App', '与BOSS随时沟通', '求职工具', '升级VIP', '去升级',
  '热门职位', '热门城市', '热门企业', '附近城市',
  '点击查看地图', '查看更多信息', '查看地图', '工作地址',
  '下载BOSS直聘', '下载App', '打开App', '扫码下载',
];

const JD_NOISE_BUTTON_WORDS = ['收藏', '立即沟通', '举报', '微信扫码分享'];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TERMINATOR_RE = new RegExp(JD_NOISE_TERMINATORS.map(escapeRegExp).join('|'));
const BUTTON_WORDS_RE = new RegExp(JD_NOISE_BUTTON_WORDS.map(escapeRegExp).join('|'));

/**
 * 清洗岗位 JD 文本：终止锚点之后的页面级内容全部截断，标题行操作按钮词删除。
 * 保留结构：banner 标签行（公司/薪资/地点）→ 标题行 → 职位描述正文 → HR 信息。
 */
export function cleanJobDescription(raw: string): string {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const cutAt = text.search(TERMINATOR_RE);
  let cleaned = cutAt >= 0 ? text.slice(0, cutAt) : text;
  cleaned = cleaned
    .replace(/\s*收藏\s*/g, ' ')
    .replace(/\s*立即沟通\s*/g, ' ')
    .replace(/\s*举报\s*/g, ' ')
    .replace(/\s*微信扫码分享\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned;
}

/** 判断 JD 文本是否疑似混入页面噪声（用于提示「一键清理」入口） */
export function jdLooksNoisy(text: string): boolean {
  const t = String(text || '');
  return TERMINATOR_RE.test(t) || BUTTON_WORDS_RE.test(t);
}
