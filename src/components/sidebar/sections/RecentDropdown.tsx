/**
 * RecentDropdown - Dropdown showing recently opened folders
 * Rendered via portal to body so it floats above the editor area,
 * unaffected by the sidebar's overflow clipping.
 */
import { createPortal } from "react-dom";
import { FolderOpen } from "lucide-react";

interface RecentDropdownProps {
  position: { x: number; y: number } | null;
  recentFolders: string[];
  onClose: () => void;
  onSelect: (path: string) => void;
  onHover: (path: string | null) => void;
}

export default function RecentDropdown({
  position,
  recentFolders,
  onClose,
  onSelect,
  onHover,
}: RecentDropdownProps) {
  if (!position) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[1000]" onClick={onClose} />
      <div
        className="fixed z-[1000] w-64 max-w-[220px] max-h-80 overflow-y-auto rounded-lg border border-border bg-secondary shadow-2xl animate-in fade-in slide-in-from-top-1 duration-150"
        style={{ left: position.x, top: position.y + 4 }}
      >
        <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted/85 border-b border-border">
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
                  <FolderOpen size={13} className="shrink-0 text-text-muted/80" />
                  <span className="truncate mr-2">{name}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="px-3 py-4 text-xs text-text-muted/80 text-center italic">
            暂无最近打开的文件夹
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}
