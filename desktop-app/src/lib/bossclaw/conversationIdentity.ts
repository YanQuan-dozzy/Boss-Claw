// 移植自 F:\job-claw-main\source\src\lib\conversation-identity.js
// 用于自动辅助时核对「当前沟通对象」与「岗位/HR」是否一致，防止发错人。

export function normalizeConversationIdentity(value: string): string {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/有限责任公司|股份有限公司|有限公司|招聘者|招聘方|人事行政|人事|hr|在线|刚刚活跃|活跃/gi, '')
    .replace(/[()（）【】\[\]<>《》,，。.:：;；_\-—·•｜|]/g, '')
    .trim()
    .toLowerCase();
}

export function deriveConversationReservationKey(
  context: Record<string, unknown> = {},
  expected: Record<string, unknown> = {},
  pendingId = ''
): string {
  const recruiterName = String(context.recruiterName || expected.recruiterName || '').trim();
  const company = String(context.companyName || expected.company || '').trim();
  const recruiterKey = normalizeConversationIdentity(recruiterName).slice(0, 80);
  const companyKey = normalizeConversationIdentity(company).slice(0, 100);
  if (recruiterKey) return `hr:${recruiterKey}${companyKey ? `|company:${companyKey}` : ''}`;

  const token = String(context.urlToken || '').trim();
  if (/conversationid=|chatid=|relationid=|bossid=|uid=/i.test(token)) return `chat:${token}`;
  const observed = normalizeConversationIdentity(`${context.headerText || ''} ${context.selectedText || ''}`).slice(0, 160);
  if (observed) return `observed:${observed}`;
  return pendingId ? `task:${String(pendingId)}` : '';
}

export function sameRecruiterReservation(
  entry: Record<string, unknown> = {},
  recruiterName = '',
  company = ''
): boolean {
  const leftRecruiter = normalizeConversationIdentity(String(entry.recruiterName || ''));
  const rightRecruiter = normalizeConversationIdentity(recruiterName);
  if (!leftRecruiter || !rightRecruiter || leftRecruiter !== rightRecruiter) return false;
  const leftCompany = normalizeConversationIdentity(String(entry.company || ''));
  const rightCompany = normalizeConversationIdentity(company);
  return !(leftCompany && rightCompany && leftCompany !== rightCompany);
}
