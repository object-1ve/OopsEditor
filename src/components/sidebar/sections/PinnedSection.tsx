/**
 * PinnedSection - Collapsible section showing pinned files
 */
import { ChevronDown, ChevronRight, Pin } from "lucide-react";
import MaterialFileIcon from "@/components/MaterialFileIcon";
import type { PinnedFile } from "@/store/types";

interface PinnedSectionProps {
  isExpanded: boolean;
  pinnedFiles: PinnedFile[];
  onToggle: () => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string) => void;
  onHover: (path: string | null) => void;
}

export default function PinnedSection({
  isExpanded,
  pinnedFiles,
  onToggle,
  onOpenFile,
  onContextMenu,
  onHover,
}: PinnedSectionProps) {
  return (
    <div className="pt-2">
      <div
        className="flex items-center gap-1 px-2 py-1 select-none cursor-pointer hover:bg-surface/30 transition-colors group/section"
        onClick={onToggle}
      >
        {isExpanded ? (
          <ChevronDown size={12} className="text-text-muted shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-text-muted shrink-0" />
        )}
        <Pin size={11} className="text-text-muted/60 shrink-0" />
        <span className="text-[10px] font-semibold tracking-wider uppercase text-text-muted/60">
          固定文件
        </span>
        <span className="text-[10px] text-text-muted/30 font-medium ml-0.5">
          {pinnedFiles.length}
        </span>
      </div>

      {isExpanded && (
        <div className="ml-0">
          {pinnedFiles.length > 0 ? (
            <div className="py-0.5">
              {pinnedFiles.map((file) => (
                <button
                  key={file.path}
                  className="flex w-full items-center gap-1.5 px-3 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface/30 hover:text-text"
                  onClick={() => onOpenFile(file.path)}
                  onContextMenu={(e) => onContextMenu(e, file.path)}
                  onMouseEnter={() => onHover(file.path)}
                  onMouseLeave={() => onHover(null)}
                  title={file.path}
                >
                  <MaterialFileIcon name={file.name} path={file.path} size={14} className="shrink-0" />
                  <span className="truncate text-left">{file.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="px-3 py-1.5 text-[11px] text-text-muted/40 italic">
              在文件标签上右键固定
            </div>
          )}
        </div>
      )}

      <div className="h-px bg-border/40 mx-3 my-1.5" />
    </div>
  );
}
