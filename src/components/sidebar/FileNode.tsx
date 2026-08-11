/**
 * FileNode - Recursive file/directory entry in the sidebar
 */
import { useState, useEffect, useCallback, useMemo, memo, useRef } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "@/store/editor";
import { normalizePath, sortTreeEntries, openFileTab, getRenameSelectionEnd } from "./sidebarUtils";
import type { DirEntry } from "./sidebarUtils";
import MaterialFileIcon from "../MaterialFileIcon";

/** 缩进引导线：depth 为祖先层级，hasMore 表示该层级是否还有后续兄弟 */
interface GuideLevel {
  depth: number;
  hasMore: boolean;
}

interface FileNodeProps extends DirEntry {
  level: number;
  guideLevels: GuideLevel[];
  isLastSibling: boolean;
  cutSourcePath?: string | null;
  onContextMenu: (e: React.MouseEvent, entry: DirEntry) => void;
  onRefresh?: () => void;
}

const FileNode = memo(function FileNode({
  path, name, is_dir, size, modified_at, level, guideLevels, isLastSibling, cutSourcePath, onContextMenu, onRefresh,
}: FileNodeProps) {
  const {
    openTab,
    showNotification,
    rebasePinnedFilePath,
    rebasePinnedFolderPaths,
    setHoveredPath,
    replaceTabFileLocation,
  } = useEditorStore();
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const expandedFolders = useEditorStore((s) => s.expandedFolders);
  const pinnedFolders = useEditorStore((s) => s.pinnedFolders);
  const defaultFolders = useEditorStore((s) => s.defaultFolders);
  const toggleFolderExpanded = useEditorStore((s) => s.toggleFolderExpanded);
  const sidebarSortField = useEditorStore((s) => s.sidebarSortField);
  const sidebarSortOrder = useEditorStore((s) => s.sidebarSortOrder);
  const tabs = useEditorStore((s) => s.tabs);
  const secondaryTabs = useEditorStore((s) => s.secondaryTabs);
  const isOpen = expandedFolders.includes(path);
  const isCutSource = !!cutSourcePath && cutSourcePath === path;
  const isDefault = is_dir && defaultFolders.some((f) => normalizePath(f.path) === normalizePath(path));
  const isPinned = is_dir && (isDefault || pinnedFolders.includes(normalizePath(path)));
  const [children, setChildren] = useState<DirEntry[]>([]);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  // 当前行之后是否还有更多行（子树或后续兄弟），决定缩进引导线是否在此行结束
  const noRowsAfter = isLastSibling && !(isOpen && children.length > 0);

  const sortedChildren = useMemo(
    () => sortTreeEntries(children, pinnedFolders, defaultFolders, sidebarSortField, sidebarSortOrder),
    [children, pinnedFolders, defaultFolders, sidebarSortField, sidebarSortOrder],
  );

  const refreshChildren = useCallback(async () => {
    if (is_dir && isOpen) {
      try {
        const result = await invoke<DirEntry[]>("list_dir", { path });
        setChildren(result);
      } catch (err) {
        console.error("Failed to list dir:", err);
      }
    }
  }, [is_dir, isOpen, path]);

  useEffect(() => {
    if (isOpen) refreshChildren();
  }, [isOpen, refreshChildren]);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.setSelectionRange(0, getRenameSelectionEnd(name, is_dir));
    }
  }, [isRenaming, is_dir, name]);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (is_dir) {
      toggleFolderExpanded(path);
    } else {
      openFile(path, size);
    }
  };

  const handleRename = useCallback(async () => {
    if (newName === name || !newName.trim()) {
      setIsRenaming(false);
      return;
    }
    try {
      const lastIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      const newPath = path.substring(0, lastIndex + 1) + newName;
      await invoke("rename_item", { path, newPath });
      if (is_dir) {
        rebasePinnedFolderPaths(path, newPath);
      } else {
        rebasePinnedFilePath(path, newPath, newName);
        // Sync any open editor tabs that point to the old path
        const matchedTabs = [...tabs, ...secondaryTabs].filter(
          (tab) => normalizePath(tab.path) === normalizePath(path),
        );
        matchedTabs.forEach((tab) =>
          replaceTabFileLocation(tab.id, newPath, newName),
        );
      }
      setIsRenaming(false);
      if (onRefresh) onRefresh();
    } catch (err) {
      showNotification(`重命名失败: ${err}`, "error");
    }
  }, [newName, name, path, is_dir, onRefresh, rebasePinnedFilePath, rebasePinnedFolderPaths, replaceTabFileLocation, showNotification, tabs, secondaryTabs]);

  const openFile = async (filePath: string, fileSize?: number) => {
    await openFileTab(filePath, openTab, showNotification, fileSize);
  };

  const isActive = useMemo(() => {
    if (!activeTabId) return false;
    const activePath = activeTabId.endsWith("#base64")
      ? activeTabId.slice(0, -7)
      : activeTabId;
    return normalizePath(activePath) === normalizePath(path);
  }, [activeTabId, path]);

  // Listen for custom "rename" event
  useEffect(() => {
    const handleRenameEvent = (e: any) => {
      if (normalizePath(e.detail.path) === normalizePath(path)) {
        setIsRenaming(true);
      }
    };
    window.addEventListener("file-rename", handleRenameEvent);
    return () => window.removeEventListener("file-rename", handleRenameEvent);
  }, [path]);

  // Listen for custom "refresh" event
  useEffect(() => {
    const handleRefreshEvent = (e: any) => {
      const eventPath = normalizePath(e.detail.path);
      const myPath = normalizePath(path);
      if (eventPath === myPath || (is_dir && myPath === normalizePath(e.detail.parentPath))) {
        refreshChildren();
      }
    };
    window.addEventListener("file-refresh", handleRefreshEvent);
    return () => window.removeEventListener("file-refresh", handleRefreshEvent);
  }, [path, is_dir, refreshChildren]);

  return (
    <div>
      <div
        className={`flex items-center gap-1.5 py-1 cursor-pointer hover:bg-surface/50 transition-colors select-none text-sm group ${
          isActive ? "bg-surface text-accent font-medium" : "text-text-secondary"
        } ${!is_dir ? "draggable-file" : ""} ${isCutSource ? "opacity-40" : ""}`}
        style={{
          paddingLeft: `${level * 12 + 24}px`,
          paddingRight: "12px",
          position: "relative",
          ...(isCutSource ? { boxShadow: "inset 0 -1px 0 0 rgba(184,90,62,0.55)" } : {}),
        }}
        onClick={handleToggle}
        onMouseEnter={() => setHoveredPath(path)}
        onMouseLeave={() => setHoveredPath(null)}
        onContextMenu={(e) => onContextMenu(e, { path, name, is_dir, size, modified_at })}
        {...(!is_dir
          ? {
              draggable: true,
              onDragStart: (e: React.DragEvent) => {
                e.dataTransfer.setData("application/x-sidebar-file", path);
                e.dataTransfer.setData("text/plain", path);
                e.dataTransfer.effectAllowed = "copy";
              },
            }
          : {})}
      >
        {guideLevels.map((guide) => (
          <div
            key={guide.depth}
            className="absolute top-0 bottom-0 w-px bg-border/25 pointer-events-none"
            style={{
              left: `${guide.depth * 12 + 31}px`,
              // 该祖先没有后续兄弟且当前行是其后代中的最后一行时，竖线到此行中间结束
              ...(!guide.hasMore && noRowsAfter ? { bottom: "50%" } : {}),
            }}
          />
        ))}
        {level > 0 && (
          <>
            <div
              className="absolute w-px bg-border/25 pointer-events-none"
              style={{ left: `${(level - 1) * 12 + 31}px`, top: 0, bottom: noRowsAfter ? "50%" : 0 }}
            />
            <div
              className="absolute top-1/2 h-px bg-border/25 pointer-events-none"
              style={{ left: `${(level - 1) * 12 + 31}px`, width: "10px" }}
            />
          </>
        )}
        {is_dir ? (
          <>
            {isOpen ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
            <MaterialFileIcon name={name} path={path} isDirectory isOpen={isOpen} size={16} className="shrink-0" />
          </>
        ) : (
          <>
            <div className="w-[14px] shrink-0" />
            <MaterialFileIcon name={name} path={path} size={16} className="shrink-0" />
          </>
        )}

        {isRenaming ? (
          <input
            ref={inputRef}
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename();
              if (e.key === "Escape") {
                setNewName(name);
                setIsRenaming(false);
              }
            }}
            className="flex-1 bg-secondary border border-accent/50 rounded px-1 py-0 text-xs focus:outline-none"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <span className="truncate">{name}</span>
            {isPinned && (
              <span className="shrink-0 rounded bg-accent/10 px-1 py-0.5 text-[9px] leading-none text-accent">置顶</span>
            )}
          </div>
        )}
      </div>
      {isOpen && sortedChildren.length > 0 && (
        <div onContextMenu={(e) => onContextMenu(e, { path, name, is_dir, size, modified_at })}>
          {sortedChildren.map((child, index) => (
            <FileNode
              key={child.path}
              {...child}
              level={level + 1}
              guideLevels={[...guideLevels, { depth: level, hasMore: !isLastSibling }]}
              isLastSibling={index === sortedChildren.length - 1}
              cutSourcePath={cutSourcePath ?? null}
              onContextMenu={onContextMenu}
              onRefresh={refreshChildren}
            />
          ))}
        </div>
      )}
      {isOpen && sortedChildren.length === 0 && (
        <div
          className="py-1 text-[10px] text-text-muted italic"
          style={{ paddingLeft: `${(level + 1) * 12 + 28}px` }}
          onContextMenu={(e) => onContextMenu(e, { path, name, is_dir, size, modified_at })}
        >
          空目录
        </div>
      )}
    </div>
  );
});

export default FileNode;
