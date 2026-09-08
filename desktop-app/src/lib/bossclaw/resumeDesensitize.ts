// 原简历「解析文字 → 渲染层 Canvas 直接排布 → 导出无敏感信息图片」。
//
// 输入为简历中心解析出的纯文本 resumeText。流程：
//   - desensitizeResumeText：剔除「电话:/邮箱:/微信:/身份证:…」这类「标签:值」整行（标签一并消失），
//     并在剩余正文里把散落的手机号/邮箱/身份证 全部替换为同等长度的 *（不留任何明文）；可选再隐藏姓名。
//   - 实际成图由 resumeToImage.ts 用 <canvas> 在渲染层直接绘制（不依赖 Electron 截屏，稳定不出错）。
//
// 安全不变量（对齐 AGENTS.md 2.1）：结果为脱敏后的投递/展示用副本，不改本地原始简历；无 AI、无缓存依赖。

export interface DesensitizeOptions {
  /** 是否同时隐藏姓名（默认 false：投递保留姓名，仅剔除联系方式等敏感项） */
  hideName?: boolean;
}

const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IDCARD_RE = /(?<!\d)\d{17}[\dXx](?!\d)/g;
// 「标签:值」整行标签（命中即剔除整行，连同标签一起消失）
const STRIP_LEAD_RE =
  /^\s*(姓名|电话|联系电话|手机|手机号|邮箱|E-mail|Email|微信|WeChat|VX|vx|WX|wx|QQ|扣扣|钉钉|地址|住址|现居|现居住地|所在城市|所在|户籍|家庭住址|身份证|身份证号)\s*[:：]/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 整行仅由手机号/邮箱/身份证组成 → 整行删除（避免残留） */
function isBareContactLine(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  return (
    /^(?<!\d)1[3-9]\d{9}(?!\d)$/.test(s) ||
    EMAIL_RE.test(s) ||
    /^(?<!\d)\d{17}[\dXx](?!\d)$/.test(s) ||
    /^(?:微|微信)[A-Za-z0-9_-]{2,32}$/i.test(s)
  );
}

/** 任意位置把联系方式全打成 *（同长度，不留明文） */
function fullMaskLine(line: string): string {
  return line
    .replace(PHONE_RE, (m) => '*'.repeat(m.length))
    .replace(EMAIL_RE, (m) => '*'.repeat(m.length))
    .replace(IDCARD_RE, (m) => '*'.repeat(m.length));
}

/** 脱敏纯文本：剔除敏感「标签:值」整行 + 全打码散落号码；可选隐藏姓名 */
export function desensitizeResumeText(raw: string, opts: DesensitizeOptions = {}): string {
  const hideName = Boolean(opts.hideName);
  const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (STRIP_LEAD_RE.test(s)) continue; // 电话:/邮箱:… 整行剔除（标签一起消失）
    if (hideName && /^姓\s*名\s*[:：]/.test(s)) continue;
    if (s && isBareContactLine(s)) continue; // 单独一行的号码/邮箱也删
    kept.push(fullMaskLine(line)); // 剩余正文全打码散落号码
  }
  let out = kept.join('\n');

  if (hideName) {
    // 首行孤立 2-4 汉字姓名，整词替换
    const firstLine = out.split('\n').map((l) => l.trim()).find(Boolean);
    if (firstLine && /^[\u4e00-\u9fa5·]{2,4}$/.test(firstLine)) {
      const re = new RegExp(`(?<![\\u4e00-\\u9fa5])${escapeRegExp(firstLine)}(?![\\u4e00-\\u9fa5])`, 'g');
      out = out.replace(re, '**');
    }
  }
  return out;
}