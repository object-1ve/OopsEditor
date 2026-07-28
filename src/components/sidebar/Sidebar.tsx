/**
 * Sidebar - File explorer panel (VS Code-style layout)
 */
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  Folder, FolderOpen, Plus, Search, X, Edit2, Trash2,
  ExternalLink, Terminal as TerminalIcon, FilePlus, FolderPlus, Settings, Copy, Pin,
  ChevronsUp, RotateCw, ArrowDownAZ, ArrowUpAZ, Clock, History,
  SortAsc, SortDesc,
} from "lucide-react";
import { useEditorStore } from "@/store/editor";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import ContextMenu from "../ContextMenu";
import { normalizePath, openFileTab } from "./sidebarUtils";
import type { DirEntry } from "./sidebarUtils";
import RootFolder from "./RootFolder";
import RecentDropdown from "./sections/RecentDropdown";
import SearchBar from "./sections/SearchBar";
import PinnedSection from "./sections/PinnedSection";
import EmptyFolderState from "./sections/EmptyFolderState";

export default function Sidebar() {
  const rootPaths = useEditorStore((s) => s.rootPaths);
  const addRootPath = useEditorStore((s) => s.addRootPath);
  const leftSidebarWidth = useEditorStore((s) => s.leftSidebarWidth);
  const setLeftSidebarWidth = useEditorStore((s) => s.setLeftSidebarWidth);
  const showNotification = useEditorStore((s) => s.showNotification);
  const addTerminal = useEditorStore((s) => s.addTerminal);
  const openTab = useEditorStore((s) => s.openTab);
  const defaultFolders = useEditorStore((s) => s.defaultFolders);
  const addDefaultFolder = useEditorStore((s) => s.addDefaultFolder);
  const removeDefaultFolder = useEditorStore((s) => s.removeDefaultFolder);
  const updateDefaultFolder = useEditorStore((s) => s.updateDefaultFolder);
  const pinnedFiles = useEditorStore((s) => s.pinnedFiles);
  const removePinnedFile = useEditorStore((s) => s.removePinnedFile);
  const pinnedFolders = useEditorStore((s) => s.pinnedFolders);
  const pinFolder = useEditorStore((s) => s.pinFolder);
  const unpinFolder = useEditorStore((s) => s.unpinFolder);
  const removePinnedFoldersUnder = useEditorStore((s) => s.removePinnedFoldersUnder);
  const collapseAllFolders = useEditorStore((s) => s.collapseAllFolders);
  const showModal = useEditorStore((s) => s.showModal);
  const setHoveredPath = useEditorStore((s) => s.setHoveredPath);
  const hoveredPath = useEditorStore((s) => s.hoveredPath);
  const setFolderExpanded = useEditorStore((s) => s.setFolderExpanded);
  const sidebarSortField = useEditorStore((s) => s.sidebarSortField);
  const sidebarSortOrder = useEditorStore((s) => s.sidebarSortOrder);
  const setSidebarSortField = useEditorStore((s) => s.setSidebarSortField);
  const setSidebarSortOrder = useEditorStore((s) => s.setSidebarSortOrder);
  const rootPathOrder = useEditorStore((s) => s.rootPathOrder);
  const setRootPathOrder = useEditorStore((s) => s.setRootPathOrder);
  const recentFolders = useEditorStore((s) => s.recentFolders);
  const loadRecentFolders = useEditorStore((s) => s.loadRecentFolders);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isPinnedExpanded, setIsPinnedExpanded] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: DirEntry } | null>(null);
  const [emptyAreaContextMenu, setEmptyAreaContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [defaultFolderContextMenu, setDefaultFolderContextMenu] = useState<{ x: number; y: number; folderId: string } | null>(null);
  const [pinnedFileContextMenu, setPinnedFileContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [sortContextMenu, setSortContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [draggedRootPath, setDraggedRootPath] = useState<string | null>(null);
  const [isRecentOpen, setIsRecentOpen] = useState(false);
  const recentDropdownRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const sortedRootPaths = useMemo(() => {
    const defaultPathsSet = new Set(defaultFolders.map((f) => normalizePath(f.path)));
    const pinnedSet = new Set(pinnedFolders.map(normalizePath));

    if (!rootPathOrder || rootPathOrder.length === 0) {
      return [...rootPaths].sort((a, b) => {
        const aPath = normalizePath(a);
        const bPath = normalizePath(b);
        const aDefault = defaultPathsSet.has(aPath);
        const bDefault = defaultPathsSet.has(bPath);
        if (aDefault !== bDefault) return aDefault ? -1 : 1;
        const aPinned = pinnedSet.has(aPath);
        const bPinned = pinnedSet.has(bPath);
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
        return 0;
      });
    }

    return [...rootPaths].sort((a, b) => {
      const aIdx = rootPathOrder.indexOf(a);
      const bIdx = rootPathOrder.indexOf(b);
      if (aIdx === -1 && bIdx === -1) return 0;
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });
  }, [rootPaths, pinnedFolders, defaultFolders, rootPathOrder]);

  const handleDragStart = (e: React.DragEvent, path: string) => {
    setDraggedRootPath(path);
    e.dataTransfer.setData("text/plain", path);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragEnter = (e: React.DragEvent, targetPath: string) => {
    e.preventDefault();
    if (!draggedRootPath || draggedRootPath === targetPath) return;
    const newOrder = [...sortedRootPaths];
    const draggedIdx = newOrder.indexOf(draggedRootPath);
    const targetIdx = newOrder.indexOf(targetPath);
    if (draggedIdx !== -1 && targetIdx !== -1) {
      newOrder.splice(draggedIdx, 1);
      newOrder.splice(targetIdx, 0, draggedRootPath);
      setRootPathOrder(newOrder);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDragEnd = () => setDraggedRootPath(null);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", stopResizing);
    document.body.style.cursor = "col-resize";
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = e.clientX;
      if (newWidth > 120 && newWidth < 600) setLeftSidebarWidth(newWidth);
    },
    [setLeftSidebarWidth],
  );

  const stopResizing = useCallback(() => {
    isResizing.current = false;
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", stopResizing);
    document.body.style.cursor = "default";
  }, [handleMouseMove]);

  const openFile = useCallback(
    async (filePath: string, fileSize?: number) => {
      await openFileTab(filePath, openTab, showNotification, fileSize);
    },
    [openTab, showNotification],
  );

  const handleOpenFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === "string") addRootPath(selected);
    } catch (err) {
      console.error("Failed to open folder:", err);
    }
  }, [addRootPath]);

  const handleContextMenu = (e: React.MouseEvent, entry: DirEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
    setEmptyAreaContextMenu(null);
    setDefaultFolderContextMenu(null);
    setPinnedFileContextMenu(null);
  };

  const handleEmptyAreaContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setEmptyAreaContextMenu({ x: e.clientX, y: e.clientY });
    setContextMenu(null);
    setDefaultFolderContextMenu(null);
    setPinnedFileContextMenu(null);
  };

  const handleDefaultFolderContextMenu = (e: React.MouseEvent, folderId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDefaultFolderContextMenu({ x: e.clientX, y: e.clientY, folderId });
    setContextMenu(null);
    setEmptyAreaContextMenu(null);
    setPinnedFileContextMenu(null);
  };

  const handlePinnedFileContextMenu = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    setPinnedFileContextMenu({ x: e.clientX, y: e.clientY, path });
    setContextMenu(null);
    setEmptyAreaContextMenu(null);
    setDefaultFolderContextMenu(null);
  };

  const handleToolbarCreate = useCallback(
    async (type: "file" | "folder") => {
      if (rootPaths.length === 0) {
        showNotification("请先添加一个文件夹到工作区", "error");
        return;
      }
      let baseDir = sortedRootPaths[0];
      if (hoveredPath) {
        try {
          const isDir = await invoke<boolean>("is_directory", { path: hoveredPath });
          if (isDir) {
            baseDir = hoveredPath;
          } else {
            const lastIdx = Math.max(hoveredPath.lastIndexOf("/"), hoveredPath.lastIndexOf("\\"));
            if (lastIdx !== -1) baseDir = hoveredPath.substring(0, lastIdx);
          }
        } catch (err) {
          console.error("Failed to check if directory:", err);
        }
      }
      const separator = baseDir.includes("\\") ? "\\" : "/";
      const isFolder = type === "folder";
      const defaultName = isFolder ? "新建文件夹" : "新建文件.txt";
      const newPath = `${baseDir}${separator}${defaultName}`;
      try {
        if (isFolder) {
          await invoke("create_dir", { path: newPath });
        } else {
          await invoke("create_file", { path: newPath });
          await openFile(newPath);
        }
        window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path: baseDir } }));
        setFolderExpanded(baseDir, true);
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent("file-rename", { detail: { path: newPath } }));
        }, 100);
      } catch (err) {
        showNotification(`创建失败: ${err}`, "error");
      }
    },
    [sortedRootPaths, rootPaths.length, showNotification, openFile, hoveredPath],
  );

  const handleCollapseAllFolders = useCallback(() => {
    collapseAllFolders();
    showNotification("已全部折叠", "success");
  }, [collapseAllFolders, showNotification]);

  const handleAddDefaultFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === "string") {
        const name = selected.split(/[/\\]/).pop() || selected;
        addDefaultFolder(name, selected);
        showNotification("已添加默认文件夹", "success");
      }
    } catch (err) {
      showNotification(`添加失败: ${err}`, "error");
    }
  }, [addDefaultFolder, showNotification]);

  const handleAction = useCallback(
    async (action: string) => {
      if (!contextMenu) return;
      const { path, is_dir, name } = contextMenu.entry;
      try {
        switch (action) {
          case "reveal":
            await invoke("reveal_in_explorer", { path });
            break;
          case "copy-path":
            await navigator.clipboard.writeText(path);
            showNotification("路径已复制到剪贴板", "success");
            break;
          case "copy-cd-path": {
            const dirPath = is_dir ? path : path.substring(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
            await navigator.clipboard.writeText(`cd ${dirPath}`);
            showNotification("cd 路径已复制到剪贴板", "success");
            break;
          }
          case "terminal": {
            const lastIdx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
            addTerminal(is_dir ? path : path.substring(0, lastIdx + 1));
            break;
          }
          case "open-base64":
            if (is_dir) {
              showNotification("文件夹暂不支持 Base64 视图", "info");
              break;
            }
            await openFileTab(path, openTab, showNotification, contextMenu.entry.size, "base64");
            break;
          case "rename":
            window.dispatchEvent(new CustomEvent("file-rename", { detail: { path } }));
            break;
          case "refresh":
            if (is_dir) {
              window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path } }));
              showNotification(`已刷新目录 ${name}`, "success");
            }
            break;
          case "pin":
            pinFolder(path);
            showNotification(`已置顶文件夹 ${name}`, "success");
            break;
          case "unpin":
            unpinFolder(path);
            showNotification(`已取消置顶 ${name}`, "success");
            break;
          case "delete":
            showModal({
              title: "删除确认",
              message: `确定要永久删除 ${name} 吗？此操作无法撤销。`,
              kind: "danger",
              onConfirm: async () => {
                try {
                  await invoke("delete_item", { path });
                  if (is_dir) {
                    removePinnedFoldersUnder(path);
                  } else {
                    removePinnedFile(path);
                  }
                  const lastIdxDel = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
                  const parentPath = path.substring(0, lastIdxDel + 1);
                  window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path: parentPath } }));
                  showNotification(`已删除 ${name}`, "success");
                } catch (err) {
                  showNotification(`删除失败: ${err}`, "error");
                }
              },
            });
            break;
          case "new-file":
          case "new-folder": {
            const isFolder = action === "new-folder";
            const lastIdxNew = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
            const baseDir = is_dir ? path : path.substring(0, lastIdxNew);
            const separator = path.includes("\\") ? "\\" : "/";
            const defaultName = isFolder ? "新建文件夹" : "新建文件.txt";
            const newPath = `${baseDir}${separator}${defaultName}`;
            if (isFolder) {
              await invoke("create_dir", { path: newPath });
            } else {
              await invoke("create_file", { path: newPath });
              await openFile(newPath);
            }
            window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path: baseDir } }));
            setFolderExpanded(baseDir, true);
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent("file-rename", { detail: { path: newPath } }));
            }, 100);
            break;
          }
        }
      } catch (err) {
        showNotification(`操作失败: ${err}`, "error");
      }
      setContextMenu(null);
    },
    [contextMenu, showNotification, addTerminal, pinFolder, unpinFolder, showModal, openFile, removePinnedFile, removePinnedFoldersUnder],
  );

  const handlePinnedFileAction = useCallback(
    async (action: string) => {
      if (!pinnedFileContextMenu) return;
      const pinnedFile = pinnedFiles.find((file) => file.path === pinnedFileContextMenu.path);
      if (!pinnedFile) return;
      try {
        switch (action) {
          case "open":
            await openFile(pinnedFile.path);
            break;
          case "reveal":
            await invoke("reveal_in_explorer", { path: pinnedFile.path });
            break;
          case "copy-path":
            await navigator.clipboard.writeText(pinnedFile.path);
            showNotification("路径已复制到剪贴板", "success");
            break;
          case "unpin":
            removePinnedFile(pinnedFile.path);
            showNotification(`已取消固定 ${pinnedFile.name}`, "success");
            break;
        }
      } catch (err) {
        showNotification(`操作失败: ${err}`, "error");
      }
      setPinnedFileContextMenu(null);
    },
    [openFile, pinnedFileContextMenu, pinnedFiles, removePinnedFile, showNotification],
  );

  const handleDefaultFolderAction = useCallback(
    async (action: string) => {
      if (!defaultFolderContextMenu) return;
      const { folderId } = defaultFolderContextMenu;
      try {
        if (action === "configure") {
          const selected = await open({ directory: true, multiple: false });
          if (selected && typeof selected === "string") {
            updateDefaultFolder(folderId, selected);
            showNotification("默认文件夹路径已更新", "success");
          }
        } else if (action === "delete") {
          removeDefaultFolder(folderId);
          showNotification("默认文件夹已移除", "success");
        }
      } catch (err) {
        showNotification(`操作失败: ${err}`, "error");
      }
      setDefaultFolderContextMenu(null);
    },
    [defaultFolderContextMenu, updateDefaultFolder, removeDefaultFolder, showNotification],
  );

  // Focus search input when opened
  useEffect(() => {
    if (isSearchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isSearchOpen]);

  // F2 rename shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F2" && hoveredPath) {
        if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("file-rename", { detail: { path: hoveredPath } }));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hoveredPath]);

  const contextMenuItems = useMemo(() => {
    if (!contextMenu) return [];
    const normalizedPath = normalizePath(contextMenu.entry.path);
    const isDefault = contextMenu.entry.is_dir && defaultFolders.some((f) => normalizePath(f.path) === normalizedPath);
    const isPinned = contextMenu.entry.is_dir && (isDefault || pinnedFolders.includes(normalizedPath));
    return [
      { label: "新建文件", icon: <FilePlus size={14} />, onClick: () => handleAction("new-file") },
      { label: "新建文件夹", icon: <FolderPlus size={14} />, onClick: () => handleAction("new-folder") },
      ...(contextMenu.entry.is_dir ? [{ label: "刷新", icon: <RotateCw size={14} />, onClick: () => handleAction("refresh") }] : []),
      { separator: true, label: "", onClick: () => {} },
      ...(rootPaths.length > 0 ? [{ label: "全部折叠", icon: <ChevronsUp size={14} />, onClick: handleCollapseAllFolders }] : []),
      ...(rootPaths.length > 0 ? [{ separator: true, label: "", onClick: () => {} }] : []),
      { label: "在资源管理器中显示", icon: <ExternalLink size={14} />, onClick: () => handleAction("reveal") },
      { label: "在终端中打开", icon: <TerminalIcon size={14} />, onClick: () => handleAction("terminal") },
      ...(!contextMenu.entry.is_dir ? [{ label: "以 Base64 打开", icon: <Copy size={14} />, onClick: () => handleAction("open-base64") }] : []),
      { label: "复制完整路径", icon: <Copy size={14} />, onClick: () => handleAction("copy-path") },
      { label: "复制 cd 路径", icon: <TerminalIcon size={14} />, onClick: () => handleAction("copy-cd-path") },
      { separator: true, label: "", onClick: () => {} },
      ...(contextMenu.entry.is_dir ? [{ label: isPinned ? "取消置顶" : "置顶", icon: <Pin size={14} />, onClick: () => handleAction(isPinned ? "unpin" : "pin") }] : []),
      ...(contextMenu.entry.is_dir ? [{ separator: true, label: "", onClick: () => {} }] : []),
      { label: "重命名", icon: <Edit2 size={14} />, onClick: () => handleAction("rename") },
      { label: "删除", icon: <Trash2 size={14} />, onClick: () => handleAction("delete"), danger: true },
    ];
  }, [contextMenu, handleAction, pinnedFolders, rootPaths.length, handleCollapseAllFolders]);

  const emptyAreaMenuItems = useMemo(
    () => [
      { label: "新建文件", icon: <FilePlus size={14} />, onClick: () => handleToolbarCreate("file") },
      { label: "新建文件夹", icon: <FolderPlus size={14} />, onClick: () => handleToolbarCreate("folder") },
      { separator: true, label: "", onClick: () => {} },
      ...(rootPaths.length > 0 ? [{ label: "全部折叠", icon: <ChevronsUp size={14} />, onClick: handleCollapseAllFolders }, { separator: true, label: "", onClick: () => {} }] : []),
      { label: "添加文件夹到工作区...", icon: <FolderOpen size={14} />, onClick: handleOpenFolder },
      { label: "添加默认文件夹...", icon: <Plus size={14} />, onClick: handleAddDefaultFolder },
      { separator: true, label: "", onClick: () => {} },
      {
        label: "在终端中打开",
        icon: <TerminalIcon size={14} />,
        onClick: () => {
          if (sortedRootPaths.length > 0) addTerminal(sortedRootPaths[0]);
          else addTerminal();
        },
      },
    ],
    [handleToolbarCreate, handleCollapseAllFolders, handleOpenFolder, handleAddDefaultFolder, rootPaths.length, sortedRootPaths, addTerminal],
  );

  const defaultFolderMenuItems = useMemo(() => {
    if (!defaultFolderContextMenu) return [];
    const { folderId } = defaultFolderContextMenu;
    const folder = defaultFolders.find((f) => f.id === folderId);
    if (!folder) return [];
    return [
      { label: "添加到工作区", icon: <Plus size={14} />, onClick: () => addRootPath(folder.path) },
      { separator: true, label: "", onClick: () => {} },
      { label: "在资源管理器中显示", icon: <ExternalLink size={14} />, onClick: () => invoke("reveal_in_explorer", { path: folder.path }) },
      { label: "在终端中打开", icon: <TerminalIcon size={14} />, onClick: () => addTerminal(folder.path) },
      { label: "复制完整路径", icon: <Copy size={14} />, onClick: async () => { await navigator.clipboard.writeText(folder.path); showNotification("路径已复制到剪贴板", "success"); } },
      { separator: true, label: "", onClick: () => {} },
      { label: "配置路径", icon: <Settings size={14} />, onClick: () => handleDefaultFolderAction("configure") },
      { label: "从列表中移除", icon: <Trash2 size={14} />, onClick: () => handleDefaultFolderAction("delete"), danger: true },
    ];
  }, [defaultFolderContextMenu, defaultFolders, addRootPath, addTerminal, handleDefaultFolderAction]);

  const pinnedFileMenuItems = useMemo(() => {
    if (!pinnedFileContextMenu) return [];
    const pinnedFile = pinnedFiles.find((file) => file.path === pinnedFileContextMenu.path);
    if (!pinnedFile) return [];
    return [
      { label: "打开文件", icon: <FolderOpen size={14} />, onClick: () => void handlePinnedFileAction("open") },
      { separator: true, label: "", onClick: () => {} },
      { label: "在资源管理器中显示", icon: <ExternalLink size={14} />, onClick: () => void handlePinnedFileAction("reveal") },
      { label: "复制完整路径", icon: <Copy size={14} />, onClick: () => void handlePinnedFileAction("copy-path") },
      { separator: true, label: "", onClick: () => {} },
      { label: "取消固定", icon: <X size={14} />, onClick: () => void handlePinnedFileAction("unpin"), danger: true },
    ];
  }, [handlePinnedFileAction, pinnedFileContextMenu, pinnedFiles]);

  const sortMenuItems = useMemo(
    () => [
      { label: "按名称排序", icon: sidebarSortOrder === "asc" ? <ArrowUpAZ size={14} /> : <ArrowDownAZ size={14} />, onClick: () => setSidebarSortField("name"), active: sidebarSortField === "name" },
      { label: "按修改时间排序", icon: <Clock size={14} />, onClick: () => setSidebarSortField("modified"), active: sidebarSortField === "modified" },
      { separator: true, label: "", onClick: () => {} },
      { label: "升序", icon: <SortAsc size={14} />, onClick: () => setSidebarSortOrder("asc"), active: sidebarSortOrder === "asc" },
      { label: "降序", icon: <SortDesc size={14} />, onClick: () => setSidebarSortOrder("desc"), active: sidebarSortOrder === "desc" },
    ],
    [sidebarSortField, sidebarSortOrder, setSidebarSortField, setSidebarSortOrder],
  );

  return (
    <div
      className="h-full bg-deepest flex flex-col overflow-hidden relative group/sidebar"
      style={{ width: `${leftSidebarWidth}px` }}
    >
      {/* Right resize handle - provides the border + hit area */}
      <div onMouseDown={startResizing} className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-50 group/resize">
        {/* Visible border line */}
        <div className="absolute left-0 inset-y-0 w-px bg-border group-hover/resize:bg-accent/50 group-active/resize:bg-accent transition-colors" />
        {/* Invisible wider hit area */}
        <div className="absolute -left-1 -right-1 inset-y-0 hover:bg-accent/10 active:bg-accent/20 transition-colors rounded-sm" />
      </div>

      {/* ── Header with action buttons ── */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-border shrink-0 select-none">
        <div className="flex items-center gap-0.5 no-drag">
          <div className="relative">
            <button
              onClick={() => {
                setIsRecentOpen(!isRecentOpen);
                if (!isRecentOpen) loadRecentFolders();
              }}
              className={`p-1 rounded hover:bg-surface transition-colors cursor-pointer ${
                isRecentOpen ? "text-accent bg-surface" : "text-text-muted hover:text-accent"
              }`}
              title="最近打开的文件夹"
            >
              <History size={13} />
            </button>
            <RecentDropdown
              isRecentOpen={isRecentOpen}
              recentFolders={recentFolders}
              recentDropdownRef={recentDropdownRef}
              onClose={() => setIsRecentOpen(false)}
              onSelect={(path) => {
                addRootPath(path);
                setIsRecentOpen(false);
              }}
              onHover={(path) => setHoveredPath(path)}
            />
          </div>
          <button
            onClick={() => setIsSearchOpen(!isSearchOpen)}
            className={`p-1 rounded hover:bg-surface transition-colors cursor-pointer ${
              isSearchOpen ? "text-accent bg-surface" : "text-text-muted hover:text-accent"
            }`}
            title="搜索文件"
          >
            <Search size={13} />
          </button>
          <button
            onClick={() => handleToolbarCreate("file")}
            className="p-1 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer"
            title="新建文件"
          >
            <FilePlus size={13} />
          </button>
          <button
            onClick={() => handleToolbarCreate("folder")}
            className="p-1 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer"
            title="新建文件夹"
          >
            <FolderPlus size={13} />
          </button>
          <button
            onClick={handleCollapseAllFolders}
            className="p-1 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer"
            title="全部折叠"
          >
            <ChevronsUp size={13} />
          </button>
          <button
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setSortContextMenu({ x: rect.left, y: rect.bottom + 4 });
            }}
            className={`p-1 rounded hover:bg-surface transition-colors cursor-pointer ${
              sortContextMenu ? "text-accent bg-surface" : "text-text-muted hover:text-accent"
            }`}
            title="排序选项"
          >
            {sidebarSortField === "name" ? (
              sidebarSortOrder === "asc" ? <ArrowUpAZ size={13} /> : <ArrowDownAZ size={13} />
            ) : (
              <Clock size={13} />
            )}
          </button>
        </div>
      </div>

      {isSearchOpen && <SearchBar searchInputRef={searchInputRef} />}

      {/* ── Main content area ── */}
      <div className="flex-1 overflow-auto" onContextMenu={handleEmptyAreaContextMenu}>
        <PinnedSection
          isExpanded={isPinnedExpanded}
          pinnedFiles={pinnedFiles}
          onToggle={() => setIsPinnedExpanded(!isPinnedExpanded)}
          onOpenFile={(path) => void openFile(path)}
          onContextMenu={handlePinnedFileContextMenu}
          onHover={(path) => setHoveredPath(path)}
        />

        {/* ── Folder tree area ── */}
        {rootPaths.length > 0 ? (
          <div className="py-0.5">
            {sortedRootPaths.map((path) => (
              <RootFolder
                key={path}
                path={path}
                onContextMenu={handleContextMenu}
                onDragStart={(e) => handleDragStart(e, path)}
                onDragEnter={(e) => handleDragEnter(e, path)}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
                isDragging={draggedRootPath === path}
              />
            ))}
          </div>
        ) : (
          <EmptyFolderState onOpenFolder={handleOpenFolder} />
        )}
      </div>

      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenuItems} onClose={() => setContextMenu(null)} />}
      {emptyAreaContextMenu && <ContextMenu x={emptyAreaContextMenu.x} y={emptyAreaContextMenu.y} items={emptyAreaMenuItems} onClose={() => setEmptyAreaContextMenu(null)} />}
      {defaultFolderContextMenu && <ContextMenu x={defaultFolderContextMenu.x} y={defaultFolderContextMenu.y} items={defaultFolderMenuItems} onClose={() => setDefaultFolderContextMenu(null)} />}
      {pinnedFileContextMenu && <ContextMenu x={pinnedFileContextMenu.x} y={pinnedFileContextMenu.y} items={pinnedFileMenuItems} onClose={() => setPinnedFileContextMenu(null)} />}
      {sortContextMenu && <ContextMenu x={sortContextMenu.x} y={sortContextMenu.y} items={sortMenuItems} onClose={() => setSortContextMenu(null)} />}
    </div>
  );
}
