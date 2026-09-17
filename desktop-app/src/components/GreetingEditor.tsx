// 招呼语编辑器：本地草稿承载输入，失焦时才一次性写持久化 store。
// 背景（审查 P5-02）：此前 value 直连 store，每敲一个字符都触发 updatePending →
// pending 数组整体重建 + 全树重渲染 + persist 落盘。此处改为「本地输入 + blur 提交」。
// 注意：点击外部按钮（如「确认沟通」）时序为 mousedown → blur（提交草稿）→ click，
// 因此按钮回调读 store 时已包含最新草稿，无需额外冲刷。
import { memo, useEffect, useRef, useState } from 'react';
import { Input } from 'antd';

interface GreetingEditorProps {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  minRows?: number;
  maxRows?: number;
  disabled?: boolean;
  fontSize?: number;
}

const GreetingEditorBase = ({ value, onCommit, placeholder, minRows, maxRows, disabled, fontSize }: GreetingEditorProps) => {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  // 外部更新（重新分析生成招呼语 / 初始化）且本地未编辑时同步草稿
  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);
  const commit = () => {
    if (!dirty.current) return;
    dirty.current = false;
    const v = draft.trim();
    if (v !== value) onCommit(v);
  };
  return (
    <Input.TextArea
      value={draft}
      onChange={(e) => {
        dirty.current = true;
        setDraft(e.target.value);
      }}
      onBlur={commit}
      autoSize={{ minRows: minRows ?? 3, maxRows: maxRows ?? 8 }}
      placeholder={placeholder ?? '请输入你希望发送给招聘方的求职招呼语'}
      disabled={disabled}
      style={{ fontSize: fontSize ?? 12, lineHeight: 1.65, borderRadius: 8 }}
    />
  );
};

export default memo(GreetingEditorBase);