/**
 * RecentDropdown - Dropdown showing recently opened folders
 */
import { FolderOpen } from "lucide-react";
import type { RefObject } from "react";

interface RecentDropdownProps {
  isRecentOpen: boolean;
  recentFolders: string[];
  recentDropdownRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onSelect: (path: string) => void;
  onHover: (path: string | null) => void;
}

export default function RecentDropdown({
  isRecentOpen,
  recentFolders,
  recentDropdownRef,
  onClose,
  onSelect,
  onHover,
}: RecentDropdownProps) {
  if (!isRecentOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={recentDropdownRef}
        className="absolute left-0 top-full mt-1 w-64 max-w-[200px] max-h-80 overflow-y-auto rounded-lg border border-border bg-secondary shadow-2xl z-50 animate-in fade-in slide-in-from-top-1 duration-150"
      >
        <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted/60 border-b border-border">
          最近打开的文件夹
        </div>
        {recentFolders.length > 0 ? (
          <div className="py-1">
            {recentFolders.map((path) => {
              const name = path.split("/").filter(Boolean).pop() || path;
              return (
                <button
                  key={path}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface/30 hover:text-text transition-colors text-left"
                  onClick={() => onSelect(path)}
                  onMouseEnter={() => onHover(path)}
                  onMouseLeave={() => onHover(null)}
                  title={path}
                >
                  <FolderOpen size={13} className="shrink-0 text-text-muted/50" />
                  <span className="truncate mr-2">{name}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="px-3 py-4 text-xs text-text-muted/50 text-center italic">
            暂无最近打开的文件夹
          </div>
        )}
      </div>
    </>
  );
}
