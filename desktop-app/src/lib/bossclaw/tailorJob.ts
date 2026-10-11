import type { JobMeta, PendingItem } from './types';
import { cleanJobDescription } from './jdCleaner';
import { decodeSalaryDigits } from './jobDisplay';

const STATUS_LABELS: Record<PendingItem['status'], string> = {
  pending: '待确认',
  approved: '待投递',
  approved_queue: '投递中',
  sent: '已投递',
  failed: '失败',
  opened: '已打开沟通',
  skipped: '已跳过',
  rejected: '不推荐',
  ignored: '已忽略',
};

/** 未批准的采集岗位也可定制；已忽略/跳过的岗位仅在用户明确选择后显示。 */
export function listTailorJobs(pending: PendingItem[], selectedIds?: string | string[]): PendingItem[] {
  const selected = new Set(Array.isArray(selectedIds) ? selectedIds : selectedIds ? [selectedIds] : []);
  return pending
    .filter((p) => selected.has(p.id) || (p.status !== 'ignored' && p.status !== 'skipped'))
    .sort((a, b) => {
      const sentOrder = Number(a.status === 'sent') - Number(b.status === 'sent');
      if (sentOrder) return sentOrder;
      const time = (p: PendingItem) => (p.status === 'sent' ? p.sentAt : p.approvedAt) || p.createdAt || 0;
      return time(b) - time(a);
    });
}

export function tailorJobTitle(job: JobMeta): string {
  return decodeSalaryDigits(job.title).replace(/\s*\d+(?:\.\d+)?\s*[-–—]\s*\d+(?:\.\d+)?K.*$/i, '').trim();
}

export function tailorJobLabel(p: PendingItem): string {
  return `${tailorJobTitle(p.job) || '未命名岗位'} · ${p.job.company || '未知公司'}（${STATUS_LABELS[p.status] || p.status}）`;
}

/** 统一工作台跳转和下拉选择的输入，保留公司/薪资/地点等结构化岗位信息。 */
export function buildTailorJobInput(job: JobMeta) {
  const description = cleanJobDescription(decodeSalaryDigits(job.description));
  const cardText = description ? '' : cleanJobDescription(decodeSalaryDigits(job.cardText));
  const content = description || cardText;
  const parts: string[] = [];
  const metadata = [
    ['公司', job.company],
    ['薪资', decodeSalaryDigits(job.salary)],
    ['地点', job.location],
    ['福利', job.welfare?.join('、')],
  ];
  for (const [label, value] of metadata) {
    if (value && !new RegExp(`(^|\\s)${label}[:：]`).test(content)) parts.push(`${label}：${value}`);
  }
  if (content) parts.push(content);
  const jobTitle = tailorJobTitle(job);
  const jobDesc = parts.join('\n');
  return {
    jobTitle,
    jobDesc,
    job: { ...job, title: jobTitle, salary: decodeSalaryDigits(job.salary), description: jobDesc },
    source: description ? 'description' as const : cardText ? 'card' as const : 'metadata' as const,
  };
}
