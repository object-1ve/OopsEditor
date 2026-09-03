/**
 * OutlinePanel - Markdown heading outline panel in right sidebar
 */
import { useMemo } from "react";
import { ListTree } from "lucide-react";
import { useEditorStore } from "@/store/editor";
import { parseMarkdownHeadings } from "@/utils/markdown";

interface OutlinePanelProps {
  content?: string;
  tabId?: string;
  onNavigate?: (headingId: string, line: number) => void;
}

export default function OutlinePanel({ content, tabId, onNavigate }: OutlinePanelProps) {
  const navigateToMarkdownHeading = useEditorStore((s) => s.navigateToMarkdownHeading);

  const handleClick = useMemo(() => {
    return onNavigate || ((headingId: string, line: number) => {
      navigateToMarkdownHeading({ tabId: tabId || "", headingId, line });
    });
  }, [onNavigate, navigateToMarkdownHeading, tabId]);

  const headings = useMemo(() => {
    if (!content) return [];
    try {
      return parseMarkdownHeadings(content);
    } catch {
      return [];
    }
  }, [content]);

  if (!tabId) {
    return (
      <div className="p-4 text-xs text-text-muted italic">
        未选择文件
      </div>
    );
  }

  if (headings.length === 0) {
    return (
      <div className="p-4 text-xs text-text-muted italic text-center">
        <div className="flex flex-col items-center gap-2 py-6">
          <ListTree size={20} className="opacity-20" />
          <span>当前文件无标题结构</span>
          <span className="text-[10px] text-text-muted/70">仅支持 Markdown 文件</span>
        </div>
      </div>
    );
  }

  return (
    <div className="py-2">
      {headings.map((h, i) => (
        <button
          key={`${h.level}-${h.text}-${i}`}
          onClick={() => handleClick(h.id, h.line)}
          className="w-full flex items-center gap-2 px-3 py-1 text-xs text-left hover:bg-surface/30 hover:text-text transition-colors"
          style={{ paddingLeft: `${12 + (h.level - 1) * 16}px` }}
          title={h.text}
        >
          <div
            className="shrink-0 rounded-full"
            style={{
              width: `${Math.max(6, 10 - h.level)}px`,
              height: `${Math.max(6, 10 - h.level)}px`,
              backgroundColor: `var(--level-${h.level}-color, hsl(${h.level * 40 + 200}, 40%, 55%))`,
            }}
          />
          <span className="truncate">{h.text}</span>
        </button>
      ))}
    </div>
  );
}
