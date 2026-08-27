/**
 * RecentFilesDropdown - Dropdown showing recently opened files
 */
import { FileText } from "lucide-react";
import type { RefObject } from "react";

interface RecentFilesDropdownProps {
  isOpen: boolean;
  recentFiles: string[];
  dropdownRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onSelect: (path: string) => void;
  onHover: (path: string | null) => void;
}

export default function RecentFilesDropdown({
  isOpen,
  recentFiles,
  dropdownRef,
  onClose,
  onSelect,
  onHover,
}: RecentFilesDropdownProps) {
  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={dropdownRef}
        className="absolute left-0 top-full mt-1 w-64 max-w-[200px] max-h-80 overflow-y-auto rounded-lg border border-border bg-secondary shadow-2xl z-50 animate-in fade-in slide-in-from-top-1 duration-150"
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
    </>
  );
}
