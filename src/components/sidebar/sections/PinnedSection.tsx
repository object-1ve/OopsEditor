/**
 * PinnedSection - Collapsible section showing pinned files with drag-to-reorder
 */
import { useCallback } from "react";
import { CSS } from "@dnd-kit/utilities";
import { useSortable, SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { ChevronDown, ChevronRight, Pin } from "lucide-react";
import MaterialFileIcon from "@/components/MaterialFileIcon";
import type { PinnedFile } from "@/store/types";

interface PinnedSectionProps {
  isExpanded: boolean;
  pinnedFiles: PinnedFile[];
  cutSourcePaths?: string[] | null;
  onToggle: () => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string) => void;
  onHover: (path: string | null) => void;
  onReorder: (files: PinnedFile[]) => void;
}

function PinnedFileItem({
  file,
  cutSourcePaths,
  onOpenFile,
  onContextMenu,
  onHover,
}: {
  file: PinnedFile;
  cutSourcePaths?: string[] | null;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string) => void;
  onHover: (path: string | null) => void;
}) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: file.path });

  return (
    <button
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(cutSourcePaths?.includes(file.path) ? { boxShadow: "inset 0 -1px 0 0 rgba(184,90,62,0.55)" } : {}),
      }}
      className={`flex w-full items-center gap-1.5 px-3 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface/30 hover:text-text ${
        cutSourcePaths?.includes(file.path) ? "opacity-40" : ""
      } ${isDragging ? "opacity-30" : ""}`}
      {...attributes}
      {...listeners}
      onClick={() => onOpenFile(file.path)}
      onContextMenu={(e) => onContextMenu(e, file.path)}
      onMouseEnter={() => onHover(file.path)}
      onMouseLeave={() => onHover(null)}
      title={file.path}
    >
      <MaterialFileIcon name={file.name} path={file.path} size={14} className="shrink-0" />
      <span className="truncate text-left">{file.name}</span>
    </button>
  );
}

export default function PinnedSection({
  isExpanded,
  pinnedFiles,
  cutSourcePaths,
  onToggle,
  onOpenFile,
  onContextMenu,
  onHover,
  onReorder,
}: PinnedSectionProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = pinnedFiles.findIndex((f) => f.path === active.id);
      const newIndex = pinnedFiles.findIndex((f) => f.path === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      onReorder(arrayMove(pinnedFiles, oldIndex, newIndex));
    },
    [pinnedFiles, onReorder],
  );

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
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={pinnedFiles.map((f) => f.path)} strategy={verticalListSortingStrategy}>
                  {pinnedFiles.map((file) => (
                    <PinnedFileItem
                      key={file.path}
                      file={file}
                      cutSourcePaths={cutSourcePaths}
                      onOpenFile={onOpenFile}
                      onContextMenu={onContextMenu}
                      onHover={onHover}
                    />
                  ))}
                </SortableContext>
              </DndContext>
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