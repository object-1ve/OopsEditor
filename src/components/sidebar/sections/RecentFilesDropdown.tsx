/**
 * RecentFilesDropdown - Dropdown showing recently opened files
 * Rendered via portal to body so it floats above the editor area,
 * unaffected by the sidebar's overflow clipping.
 */
import { createPortal } from "react-dom";
import { FileText } from "lucide-react";

interface RecentFilesDropdownProps {
  position: { x: number; y: number } | null;
  recentFiles: string[];
  onClose: () => void;
  onSelect: (path: string) => void;
  onHover: (path: string | null) => void;
}

export default function RecentFilesDropdown({
  position,
  recentFiles,
  onClose,
  onSelect,
  onHover,
}: RecentFilesDropdownProps) {
  if (!position) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[1000]" onClick={onClose} />
      <div
        className="fixed z-[1000] w-64 max-w-[220px] max-h-80 overflow-y-auto rounded-lg border border-border bg-secondary shadow-2xl animate-in fade-in slide-in-from-top-1 duration-150"
        style={{ left: position.x, top: position.y + 4 }}
      >
        <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted/60 border-b border-border">
          最近打开的文件
        </div>
        {recentFiles.length > 0 ? (
          <div className="py-1">
            {recentFiles.map((path) => {
              const name = path.split(/[/\\]/).filter(Boolean).pop() || path;
              return (
                <button
                  key={path}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface/30 hover:text-text transition-colors text-left"
                  onClick={() => onSelect(path)}
                  onMouseEnter={() => onHover(path)}
                  onMouseLeave={() => onHover(null)}
                  title={path}
                >
                  <FileText size={13} className="shrink-0 text-text-muted/50" />
                  <span className="truncate mr-2">{name}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="px-3 py-4 text-xs text-text-muted/50 text-center italic">
            暂无最近打开的文件
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}
