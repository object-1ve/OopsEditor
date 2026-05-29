import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { ChevronRight, ChevronDown, Folder, FolderOpen, Plus, Search, X, Edit2, Trash2, ExternalLink, Terminal as TerminalIcon, FilePlus, FolderPlus, Settings, Copy, Pin, ChevronsUp } from "lucide-react";
import { useEditorStore } from "../store/editor";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { detectLanguage, isPreviewOnlyLanguage } from "../types";
import { base64ToHexView } from "../utils/hexView";
import ContextMenu from "./ContextMenu";
import MaterialFileIcon from "./MaterialFileIcon";

const normalizePath = (p: string) => {
  if (!p) return "";
  // 统一斜杠，移除末尾斜杠，并统一盘符为大写（Windows）
  let normalized = p.replace(/\\/g, "/").replace(/\/$/, "");
  if (/^[a-z]:/i.test(normalized)) {
    normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  return normalized;
};

interface DirEntry {
  path: string;
  name: string;
  is_dir: boolean;
  size: number;
}

type OpenMode = "text" | "base64";

const buildTabId = (filePath: string, mode: OpenMode) =>
  mode === "base64" ? `${filePath}#base64` : filePath;

async function openFileTab(
  filePath: string,
  openTab: ReturnType<typeof useEditorStore.getState>["openTab"],
  showNotification: ReturnType<typeof useEditorStore.getState>["showNotification"],
  fileSize?: number,
  mode: OpenMode = "text",
) {
  try {
    const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
    const language = mode === "base64" ? "plaintext" : detectLanguage(fileName);
    let content = "";

    if (mode === "base64") {
      const base64Content = await invoke<string>("read_file_as_base64", { path: filePath });
      content = base64ToHexView(base64Content);
    } else if (!isPreviewOnlyLanguage(language)) {
      content = await invoke<string>("read_file", { path: filePath });
    }

    openTab({
      id: buildTabId(filePath, mode),
      name: mode === "base64" ? `${fileName} [Base64]` : fileName,
      path: filePath,
      language,
      content,
      isDirty: false,
      size: fileSize,
      viewMode: mode,
      isReadOnly: false,
    });
  } catch (err) {
    showNotification(`无法打开文件: ${filePath.split(/[/\\]/).pop()} (${String(err)})`, "error");
  }
}

const sortTreeEntries = (entries: DirEntry[], pinnedFolders: string[]) => {
  const pinnedSet = new Set(pinnedFolders.map(normalizePath));

  return [...entries].sort((a, b) => {
    const aPinned = a.is_dir && pinnedSet.has(normalizePath(a.path));
    const bPinned = b.is_dir && pinnedSet.has(normalizePath(b.path));

    if (aPinned !== bPinned) {
      return aPinned ? -1 : 1;
    }

    if (a.is_dir !== b.is_dir) {
      return a.is_dir ? -1 : 1;
    }

    return 0;
  });
};

interface FileNodeProps extends DirEntry {
  level: number;
  onContextMenu: (e: React.MouseEvent, entry: DirEntry) => void;
  onRefresh?: () => void;
}

function FileNode({ path, name, is_dir, size, level, onContextMenu, onRefresh }: FileNodeProps) {
  const {
    openTab,
    activeTabId,
    showNotification,
    expandedFolders,
    pinnedFolders,
    toggleFolderExpanded,
    rebasePinnedFolderPaths,
  } = useEditorStore();
  const isOpen = expandedFolders.includes(path);
  const isPinned = is_dir && pinnedFolders.includes(normalizePath(path));
  const [children, setChildren] = useState<DirEntry[]>([]);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const sortedChildren = useMemo(() => sortTreeEntries(children, pinnedFolders), [children, pinnedFolders]);

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
    if (isOpen) {
      refreshChildren();
    }
  }, [isOpen, refreshChildren]);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  const handleToggle = async (e: React.MouseEvent) => {
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
      }
      setIsRenaming(false);
      if (onRefresh) onRefresh();
    } catch (err) {
      showNotification(`重命名失败: ${err}`, "error");
    }
  }, [newName, name, path, is_dir, onRefresh, rebasePinnedFolderPaths, showNotification]);

  const openFile = async (filePath: string, fileSize?: number) => {
    await openFileTab(filePath, openTab, showNotification, fileSize);
  };

  const isActive = activeTabId === path;

  // Listen for custom "rename" event if we are the target
  useEffect(() => {
    const handleRenameEvent = (e: any) => {
      if (e.detail.path === path) {
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
        className={`flex items-center gap-1.5 py-1 px-2 cursor-pointer hover:bg-surface/50 transition-colors select-none text-sm group ${
          isActive ? "bg-surface text-accent font-medium" : "text-text-secondary"
        }`}
        style={{ paddingLeft: `${level * 12 + 12}px` }}
        onClick={handleToggle}
        onContextMenu={(e) => onContextMenu(e, { path, name, is_dir, size })}
      >
        {is_dir ? (
          <>
            {isOpen ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
            <MaterialFileIcon
              name={name}
              path={path}
              isDirectory
              isOpen={isOpen}
              size={16}
            />
          </>
        ) : (
          <>
            <div className="w-[14px] shrink-0" />
            <MaterialFileIcon
              name={name}
              path={path}
              size={16}
            />
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
              <span className="shrink-0 rounded bg-accent/10 px-1 py-0.5 text-[9px] leading-none text-accent">
                置顶
              </span>
            )}
          </div>
        )}
      </div>
      {isOpen && sortedChildren.length > 0 && (
        <div>
          {sortedChildren.map((child) => (
            <FileNode 
              key={child.path} 
              {...child} 
              level={level + 1} 
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
        >
          空目录
        </div>
      )}
    </div>
  );
}

function RootFolder({ path, onContextMenu }: { path: string; onContextMenu: (e: React.MouseEvent, entry: DirEntry) => void }) {
  const { removeRootPath, expandedFolders, pinnedFolders, toggleFolderExpanded } = useEditorStore();
  const isOpen = expandedFolders.includes(path);
  const isPinned = pinnedFolders.includes(normalizePath(path));
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const sortedEntries = useMemo(() => sortTreeEntries(entries, pinnedFolders), [entries, pinnedFolders]);

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

  // Listen for refresh
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
    <div className="mb-2">
      <div 
        className="pl-2 pr-3 py-1.5 flex items-center justify-between group/folder cursor-pointer select-none hover:bg-surface/30 transition-colors"
        onClick={() => toggleFolderExpanded(path)}
        onContextMenu={(e) => onContextMenu(e, { path, name: path.split(/[/\\]/).pop() || path, is_dir: true, size: 0 })}
      >
        <div className="flex items-center gap-1.5 overflow-hidden">
          {isOpen ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
          <MaterialFileIcon
            name={path.split(/[/\\]/).pop() || path}
            path={path}
            isDirectory
            isOpen={isOpen}
            size={16}
          />
          <span 
            className="text-[11px] font-bold tracking-wider text-text-secondary truncate"
            title={path}
          >
            {path.split(/[/\\]/).pop() || path}
          </span>
          {isPinned && (
            <span className="shrink-0 rounded bg-accent/10 px-1 py-0.5 text-[9px] leading-none text-accent">
              置顶
            </span>
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
        <div className="mt-0.5">
          {sortedEntries.length > 0 ? (
            sortedEntries.map((entry) => (
              <FileNode 
                key={entry.path} 
                {...entry} 
                level={0} 
                onContextMenu={onContextMenu}
                onRefresh={loadRoot}
              />
            ))
          ) : (
            <div className="px-8 py-1 text-[10px] text-text-muted italic">空目录</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Sidebar() {
  const { 
    rootPaths, addRootPath, leftSidebarWidth, setLeftSidebarWidth, 
    showNotification, addTerminal, openTab,
    defaultFolders, addDefaultFolder, removeDefaultFolder, updateDefaultFolder,
    pinnedFolders, pinFolder, unpinFolder, removePinnedFoldersUnder, collapseAllFolders, showModal
  } = useEditorStore();
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: DirEntry } | null>(null);
  const [emptyAreaContextMenu, setEmptyAreaContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [defaultFolderContextMenu, setDefaultFolderContextMenu] = useState<{ x: number; y: number; folderId: string } | null>(null);
  const isResizing = useRef(false);
  const sortedRootPaths = useMemo(() => {
    const pinnedSet = new Set(pinnedFolders.map(normalizePath));
    return [...rootPaths].sort((a, b) => {
      const aPinned = pinnedSet.has(normalizePath(a));
      const bPinned = pinnedSet.has(normalizePath(b));
      if (aPinned === bPinned) return 0;
      return aPinned ? -1 : 1;
    });
  }, [rootPaths, pinnedFolders]);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", stopResizing);
    document.body.style.cursor = "col-resize";
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing.current) return;
    const newWidth = e.clientX;
    if (newWidth > 120 && newWidth < 600) {
      setLeftSidebarWidth(newWidth);
    }
  }, [setLeftSidebarWidth]);

  const stopResizing = useCallback(() => {
    isResizing.current = false;
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", stopResizing);
    document.body.style.cursor = "default";
  }, [handleMouseMove]);

  const openFile = useCallback(async (filePath: string, fileSize?: number) => {
    await openFileTab(filePath, openTab, showNotification, fileSize);
  }, [openTab, showNotification]);

  const handleOpenFolder = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      if (selected && typeof selected === "string") {
        addRootPath(selected);
      }
    } catch (err) {
      console.error("Failed to open folder:", err);
    }
  }, [addRootPath]);

  const handleContextMenu = (e: React.MouseEvent, entry: DirEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      entry
    });
    setEmptyAreaContextMenu(null);
    setDefaultFolderContextMenu(null);
  };

  const handleEmptyAreaContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setEmptyAreaContextMenu({
      x: e.clientX,
      y: e.clientY
    });
    setContextMenu(null);
    setDefaultFolderContextMenu(null);
  };

  const handleDefaultFolderContextMenu = (e: React.MouseEvent, folderId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDefaultFolderContextMenu({
      x: e.clientX,
      y: e.clientY,
      folderId
    });
    setContextMenu(null);
    setEmptyAreaContextMenu(null);
  };

  const handleBottomAreaContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (defaultFolders.length > 0) {
      // 默认使用第一个文件夹的右键菜单
      setDefaultFolderContextMenu({
        x: e.clientX,
        y: e.clientY,
        folderId: defaultFolders[0].id
      });
      setContextMenu(null);
      setEmptyAreaContextMenu(null);
    } else {
      handleEmptyAreaContextMenu(e);
    }
  };

  const handleToolbarCreate = useCallback(async (type: 'file' | 'folder') => {
    if (rootPaths.length === 0) {
      showNotification("请先添加一个文件夹到工作区", "error");
      return;
    }

    const baseDir = sortedRootPaths[0];
    const separator = baseDir.includes("\\") ? "\\" : "/";
    const isFolder = type === 'folder';
    const defaultName = isFolder ? "新建文件夹" : "新建文件.txt";
    const newPath = `${baseDir}${separator}${defaultName}`;

    try {
      if (isFolder) {
        await invoke("create_dir", { path: newPath });
      } else {
        await invoke("create_file", { path: newPath });
        // Automatically open the new file
        await openFile(newPath);
      }
      
      window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path: baseDir } }));
      
      // Trigger rename for the new item
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("file-rename", { detail: { path: newPath } }));
      }, 100);
    } catch (err) {
      showNotification(`创建失败: ${err}`, "error");
    }
  }, [sortedRootPaths, rootPaths.length, showNotification, openFile]);

  const handleCollapseAllFolders = useCallback(() => {
    collapseAllFolders();
    showNotification("已全部折叠", "success");
  }, [collapseAllFolders, showNotification]);

  const handleAction = useCallback(async (action: string) => {
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
        case "terminal":
          // If it's a file, open terminal in parent dir
          const lastIdx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
          const terminalPath = is_dir ? path : path.substring(0, lastIdx + 1);
          // Only open it in internal terminal
          addTerminal(terminalPath);
          break;
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
                }
                const lastIdxDel = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
                const parentPath = path.substring(0, lastIdxDel + 1);
                window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path: parentPath } }));
                showNotification(`已删除 ${name}`, "success");
              } catch (err) {
                showNotification(`删除失败: ${err}`, "error");
              }
            }
          });
          break;
        case "new-file":
        case "new-folder":
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
            // Automatically open the new file
            await openFile(newPath);
          }
          
          window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path: baseDir } }));
          // Optional: trigger rename for the new item
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent("file-rename", { detail: { path: newPath } }));
          }, 100);
          break;
      }
    } catch (err) {
      showNotification(`操作失败: ${err}`, "error");
    }
    setContextMenu(null);
  }, [contextMenu, showNotification, addTerminal, pinFolder, unpinFolder, showModal, openFile, removePinnedFoldersUnder]);

  const handleDefaultFolderAction = useCallback(async (action: string) => {
    if (!defaultFolderContextMenu) return;
    const { folderId } = defaultFolderContextMenu;
    
    try {
      if (action === "configure") {
        const selected = await open({
          directory: true,
          multiple: false,
        });
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
  }, [defaultFolderContextMenu, updateDefaultFolder, removeDefaultFolder, showNotification]);

  const handleAddDefaultFolder = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      if (selected && typeof selected === "string") {
        const name = selected.split(/[/\\]/).pop() || selected;
        addDefaultFolder(name, selected);
        showNotification("已添加默认文件夹", "success");
      }
    } catch (err) {
      showNotification(`添加失败: ${err}`, "error");
    }
  }, [addDefaultFolder, showNotification]);

  const contextMenuItems = useMemo(() => {
    if (!contextMenu) return [];
    const isPinned = contextMenu.entry.is_dir && pinnedFolders.includes(normalizePath(contextMenu.entry.path));
    return [
      { label: "新建文件", icon: <FilePlus size={14} />, onClick: () => handleAction("new-file") },
      { label: "新建文件夹", icon: <FolderPlus size={14} />, onClick: () => handleAction("new-folder") },
      { separator: true, label: "", onClick: () => {} },
      ...(rootPaths.length > 0
        ? [{ label: "全部折叠", icon: <ChevronsUp size={14} />, onClick: handleCollapseAllFolders }]
        : []),
      ...(rootPaths.length > 0 ? [{ separator: true, label: "", onClick: () => {} }] : []),
      { label: "在资源管理器中显示", icon: <ExternalLink size={14} />, onClick: () => handleAction("reveal") },
      { label: "在终端中打开", icon: <TerminalIcon size={14} />, onClick: () => handleAction("terminal") },
      ...(!contextMenu.entry.is_dir
        ? [{ label: "以 Base64 打开", icon: <Copy size={14} />, onClick: () => handleAction("open-base64") }]
        : []),
      { label: "复制完整路径", icon: <Copy size={14} />, onClick: () => handleAction("copy-path") },
      { separator: true, label: "", onClick: () => {} },
      ...(contextMenu.entry.is_dir
        ? [{ label: isPinned ? "取消置顶" : "置顶", icon: <Pin size={14} />, onClick: () => handleAction(isPinned ? "unpin" : "pin") }]
        : []),
      ...(contextMenu.entry.is_dir ? [{ separator: true, label: "", onClick: () => {} }] : []),
      { label: "重命名", icon: <Edit2 size={14} />, onClick: () => handleAction("rename") },
      { label: "删除", icon: <Trash2 size={14} />, onClick: () => handleAction("delete"), danger: true },
    ];
  }, [contextMenu, handleAction, pinnedFolders, rootPaths.length, handleCollapseAllFolders]);

  const emptyAreaMenuItems = useMemo(() => [
    { label: "新建文件", icon: <FilePlus size={14} />, onClick: () => handleToolbarCreate("file") },
    { label: "新建文件夹", icon: <FolderPlus size={14} />, onClick: () => handleToolbarCreate("folder") },
    { separator: true, label: "", onClick: () => {} },
    ...(rootPaths.length > 0
      ? [{ label: "全部折叠", icon: <ChevronsUp size={14} />, onClick: handleCollapseAllFolders }, { separator: true, label: "", onClick: () => {} }]
      : []),
    { label: "添加文件夹到工作区...", icon: <FolderOpen size={14} />, onClick: handleOpenFolder },
    { label: "添加默认文件夹...", icon: <Plus size={14} />, onClick: handleAddDefaultFolder },
    { separator: true, label: "", onClick: () => {} },
    { label: "在终端中打开", icon: <TerminalIcon size={14} />, onClick: () => {
      if (sortedRootPaths.length > 0) {
        addTerminal(sortedRootPaths[0]);
      } else {
        addTerminal();
      }
    }},
  ], [handleToolbarCreate, handleCollapseAllFolders, handleOpenFolder, handleAddDefaultFolder, rootPaths.length, sortedRootPaths, addTerminal]);

  const defaultFolderMenuItems = useMemo(() => {
    if (!defaultFolderContextMenu) return [];
    const { folderId } = defaultFolderContextMenu;
    const folder = defaultFolders.find(f => f.id === folderId);
    if (!folder) return [];

    return [
      { label: "添加到工作区", icon: <Plus size={14} />, onClick: () => addRootPath(folder.path) },
      { separator: true, label: "", onClick: () => {} },
      { label: "在资源管理器中显示", icon: <ExternalLink size={14} />, onClick: () => invoke("reveal_in_explorer", { path: folder.path }) },
      { label: "在终端中打开", icon: <TerminalIcon size={14} />, onClick: () => {
        addTerminal(folder.path);
      }},
      { label: "复制完整路径", icon: <Copy size={14} />, onClick: async () => {
        await navigator.clipboard.writeText(folder.path);
        showNotification("路径已复制到剪贴板", "success");
      }},
      { separator: true, label: "", onClick: () => {} },
      { label: "配置路径", icon: <Settings size={14} />, onClick: () => handleDefaultFolderAction("configure") },
      { label: "从列表中移除", icon: <Trash2 size={14} />, onClick: () => handleDefaultFolderAction("delete"), danger: true },
    ];
  }, [defaultFolderContextMenu, defaultFolders, addRootPath, addTerminal, handleDefaultFolderAction]);

  return (
    <div 
      className="h-full bg-deepest border-r border-border flex flex-col overflow-hidden relative group/sidebar"
      style={{ width: `${leftSidebarWidth}px` }}
    >
      {/* Resize Handle */}
      <div
        onMouseDown={startResizing}
        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors z-50"
      />

      <div 
        className="h-10 flex items-center justify-between px-3 border-b border-border shrink-0 select-none"
      >
        <button 
          onClick={handleOpenFolder}
          className="p-1 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer"
          title="添加文件夹到工作区"
        >
          <FolderOpen size={14} />
        </button>
        <div className="flex items-center gap-1 no-drag">
          <button 
            onClick={() => setIsSearchOpen(!isSearchOpen)}
            className={`p-1 rounded hover:bg-surface transition-colors cursor-pointer ${isSearchOpen ? "text-accent bg-surface" : "text-text-muted hover:text-accent"}`}
            title="搜索文件"
          >
            <Search size={14} />
          </button>
          <button 
            onClick={() => handleToolbarCreate('file')}
            className="p-1 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer"
            title="新建文件"
          >
            <FilePlus size={14} />
          </button>
          <button 
            onClick={() => handleToolbarCreate('folder')}
            className="p-1 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer"
            title="新建文件夹"
          >
            <FolderPlus size={14} />
          </button>
        </div>
      </div>

      {isSearchOpen && (
        <div className="p-2 shrink-0">
          <div className="relative group">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted group-focus-within:text-accent transition-colors" />
            <input 
              type="text" 
              placeholder="搜索文件..."
              autoFocus
              className="w-full bg-secondary/50 border border-border rounded-md py-1 pl-8 pr-2 text-xs focus:outline-none focus:border-accent/50 focus:bg-primary transition-all"
            />
          </div>
        </div>
      )}

      <div 
        className="flex-1 overflow-auto py-2"
        onContextMenu={handleEmptyAreaContextMenu}
      >
        {rootPaths.length > 0 ? (
          sortedRootPaths.map((path) => (
            <RootFolder key={path} path={path} onContextMenu={handleContextMenu} />
          ))
        ) : (
          <div className="h-full flex flex-col items-center justify-center p-6 text-center space-y-4">
            <div className="w-12 h-12 rounded-full bg-accent/5 flex items-center justify-center text-accent/40">
              <Folder size={24} />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-text-secondary font-medium">未打开文件夹</p>
              <p className="text-[10px] text-text-muted">添加文件夹到工作区来查看文件结构</p>
            </div>
            <button
              onClick={handleOpenFolder}
              className="px-3 py-1.5 bg-accent hover:bg-accent-bright text-white text-xs rounded-md shadow-sm transition-colors"
            >
              打开文件夹
            </button>
          </div>
        )}
      </div>

      {/* Default Folders fixed at the bottom */}
      <div 
        className="h-6 shrink-0 border-t border-border bg-deepest flex items-center justify-between px-3 py-2 gap-2 overflow-hidden"
        onContextMenu={handleBottomAreaContextMenu}
      >
        <div className="flex items-center gap-2 overflow-hidden flex-1">
          <div className="flex items-center gap-2 overflow-hidden scrollbar-none">
            {defaultFolders.map((folder) => (
              <div 
                key={folder.id}
                className="flex items-center gap-1.5 cursor-pointer hover:bg-surface/50 px-1.5 py-0.5 rounded transition-colors text-text-secondary hover:text-accent text-[11px] truncate group shrink-0 max-w-[150px]"
                onClick={() => addRootPath(folder.path)}
                onContextMenu={(e) => handleDefaultFolderContextMenu(e, folder.id)}
                title={folder.path}
              >
                <MaterialFileIcon
                  name={folder.name}
                  path={folder.path}
                  isDirectory
                  size={14}
                />
                <span className="truncate">{folder.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}

      {emptyAreaContextMenu && (
        <ContextMenu
          x={emptyAreaContextMenu.x}
          y={emptyAreaContextMenu.y}
          items={emptyAreaMenuItems}
          onClose={() => setEmptyAreaContextMenu(null)}
        />
      )}

      {defaultFolderContextMenu && (
        <ContextMenu
          x={defaultFolderContextMenu.x}
          y={defaultFolderContextMenu.y}
          items={defaultFolderMenuItems}
          onClose={() => setDefaultFolderContextMenu(null)}
        />
      )}
    </div>
  );
}
