// 求职进展手动标记（P1-6）
// 与投递状态正交：只写 progressStage / progressUpdatedAt，不改 status、不影响投递成功率。
// 「已约面 / HR 已拒绝」由 AI 跟聊自动写入，这里用于人工修正与「已回复 / 已面试 / 已获 Offer」。
import { Select } from 'antd';
import {
  PROGRESS_STAGE_META,
  normalizeProgressStage,
  progressStagePatch,
  type ProgressStagePatch,
} from '@/lib/bossclaw/progressStage';

export default function ProgressStageSelect({
  value,
  onChange,
  width = 132,
}: {
  value: unknown;
  onChange: (patch: ProgressStagePatch) => void;
  width?: number;
}) {
  const current = normalizeProgressStage(value);
  return (
    <span title="记录 HR 侧进展：不改投递状态、不影响投递成功率，只用于流程跟踪与统计「进展分布」">
      <Select
        size="small"
        value={current ?? undefined}
        placeholder="求职进展"
        allowClear
        style={{ width }}
        popupMatchSelectWidth={false}
        options={PROGRESS_STAGE_META.map((m) => ({ value: m.key, label: m.label }))}
        onChange={(v) => onChange(progressStagePatch(normalizeProgressStage(v)))}
      />
    </span>
  );
}
