/**
 * RootFolder - Root-level folder entry in the sidebar
 */
import { useState, useEffect, useCallback, useMemo, memo } from "react";
import { ChevronRight, ChevronDown, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "@/store/editor";
import { normalizePath, sortTreeEntries } from "./sidebarUtils";
import type { DirEntry } from "./sidebarUtils";
import FileNode from "./FileNode";
import MaterialFileIcon from "../MaterialFileIcon";

const RootFolder = memo(function RootFolder({
  path,
  onContextMenu,
  onDragStart,
  onDragEnter,
  onDragOver,
  onDragEnd,
  isDragging,
}: {
  path: string;
  onContextMenu: (e: React.MouseEvent, entry: DirEntry) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnter: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  isDragging: boolean;
}) {
  const removeRootPath = useEditorStore((s) => s.removeRootPath);
  const expandedFolders = useEditorStore((s) => s.expandedFolders);
  const pinnedFolders = useEditorStore((s) => s.pinnedFolders);
  const defaultFolders = useEditorStore((s) => s.defaultFolders);
  const toggleFolderExpanded = useEditorStore((s) => s.toggleFolderExpanded);
  const setHoveredPath = useEditorStore((s) => s.setHoveredPath);
  const sidebarSortField = useEditorStore((s) => s.sidebarSortField);
  const sidebarSortOrder = useEditorStore((s) => s.sidebarSortOrder);
  const isOpen = expandedFolders.includes(path);
  const isDefault = defaultFolders.some((f) => normalizePath(f.path) === normalizePath(path));
  const isPinned = isDefault || pinnedFolders.includes(normalizePath(path));
  const [entries, setEntries] = useState<DirEntry[]>([]);

  const sortedEntries = useMemo(
    () => sortTreeEntries(entries, pinnedFolders, defaultFolders, sidebarSortField, sidebarSortOrder),
    [entries, pinnedFolders, defaultFolders, sidebarSortField, sidebarSortOrder],
  );

  const loadRoot = useCallback(async () => {
    try {
      const result = await invoke<DirEntry[]>("list_dir", { path });
      setEntries(result);
    } catch (err) {
      console.error("Failed to load root:", err);
    }
  }, [path]);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

  useEffect(() => {
    const handleRefreshEvent = (e: any) => {
      if (normalizePath(e.detail.path) === normalizePath(path)) {
        loadRoot();
      }
    };
    window.addEventListener("file-refresh", handleRefreshEvent);
    return () => window.removeEventListener("file-refresh", handleRefreshEvent);
  }, [path, loadRoot]);

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    removeRootPath(path);
  };

  return (
    <div
      className={`mb-2 transition-all duration-200 ${isDragging ? "opacity-30 scale-[0.98] bg-surface/20" : "opacity-100"}`}
      draggable
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
    >
      <div
        className="px-3 py-1.5 flex items-center justify-between group/folder cursor-grab active:cursor-grabbing select-none hover:bg-surface/30 transition-colors"
        onClick={() => toggleFolderExpanded(path)}
        onMouseEnter={() => setHoveredPath(path)}
        onMouseLeave={() => setHoveredPath(null)}
        onContextMenu={(e) =>
          onContextMenu(e, {
            path,
            name: path.split(/[/\\]/).pop() || path,
            is_dir: true,
            size: 0,
            modified_at: 0,
          })
        }
      >
        <div className="flex items-center gap-1.5 overflow-hidden min-w-0 flex-1">
          {isOpen ? (
            <ChevronDown size={14} className="text-text-muted shrink-0" />
          ) : (
            <ChevronRight size={14} className="text-text-muted shrink-0" />
          )}
          <MaterialFileIcon
            name={path.split(/[/\\]/).pop() || path}
            path={path}
            isDirectory
            isOpen={isOpen}
            size={16}
            className="shrink-0"
          />
          <span className="text-[11px] font-bold tracking-wider text-text-secondary truncate" title={path}>
            {path.split(/[/\\]/).pop() || path}
          </span>
          {isPinned && (
            <span className="shrink-0 rounded bg-accent/10 px-1 py-0.5 text-[9px] leading-none text-accent">置顶</span>
          )}
        </div>
        <button
          onClick={handleRemove}
          className="p-1 opacity-0 group-hover/folder:opacity-100 hover:bg-surface rounded transition-all text-text-muted hover:text-error"
        >
          <X size={12} />
        </button>
      </div>
      {isOpen && (
        <div
          className="mt-0.5"
          onContextMenu={(e) =>
            onContextMenu(e, {
              path,
              name: path.split(/[/\\]/).pop() || path,
              is_dir: true,
              size: 0,
              modified_at: 0,
            })
          }
        >
          {sortedEntries.length > 0 ? (
            sortedEntries.map((entry, index) => (
              <FileNode
                key={entry.path}
                {...entry}
                level={0}
                guideLevels={[]}
                isLastSibling={index === sortedEntries.length - 1}
                onContextMenu={onContextMenu}
                onRefresh={loadRoot}
              />
            ))
          ) : (
            <div
              className="px-8 py-1 text-[10px] text-text-muted italic"
              onContextMenu={(e) =>
                onContextMenu(e, {
                  path,
                  name: path.split(/[/\\]/).pop() || path,
                  is_dir: true,
                  size: 0,
                  modified_at: 0,
                })
              }
            >
              空目录
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default RootFolder;
