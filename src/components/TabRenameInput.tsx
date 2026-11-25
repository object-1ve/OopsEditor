import { useEffect, useRef } from "react";
import { getRenameSelectionEnd } from "@/utils/path";

interface TabRenameInputProps {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

/**
 * 标签栏上的原地重命名输入框：挂载即聚焦并选中文件名主干（保留扩展名），
 * 回车提交、Esc 取消，失焦按提交处理。
 */
export default function TabRenameInput({ value, onChange, onCommit, onCancel }: TabRenameInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, getRenameSelectionEnd(el.value, false));
  }, []);

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      spellCheck={false}
      className="tab-name w-28 min-w-0 rounded border border-accent/50 bg-surface px-1 py-0 text-xs text-text-primary focus:outline-none"
    />
  );
}
