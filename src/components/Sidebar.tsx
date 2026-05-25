import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronRight, ChevronDown, Folder, File, FolderOpen, Plus, Search } from "lucide-react";
import { useEditorStore } from "../store/editor";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { detectLanguage } from "../types";

interface DirEntry {
  path: string;
  name: string;
  is_dir: boolean;
}

interface FileNodeProps extends DirEntry {
  level: number;
}

function FileNode({ path, name, is_dir, level }: FileNodeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [children, setChildren] = useState<FileNodeProps[]>([]);
  const { openTab, activeTabId } = useEditorStore();

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (is_dir) {
      if (!isOpen) {
        try {
          const result = await invoke<DirEntry[]>("list_dir", { path });
          const nodes = result.map((entry) => ({
            ...entry,
            level: level + 1,
          }));
          setChildren(nodes);
        } catch (err) {
          console.error("Failed to list dir:", err);
        }
      }
      setIsOpen(!isOpen);
    } else {
      openFile(path);
    }
  };

  const openFile = async (filePath: string) => {
    try {
      const name = filePath.split(/[/\\]/).pop() ?? filePath;
      const language = detectLanguage(name);
      let content = "";
      if (language !== "image") {
        content = await invoke<string>("read_file", { path: filePath });
      }
      openTab({
        id: filePath,
        name,
        path: filePath,
        language,
        content,
        isDirty: false,
      });
    } catch (err) {
      useEditorStore.getState().showNotification(`无法打开文件: ${filePath.split(/[/\\]/).pop()} (可能是不支持的二进制格式)`, "error");
    }
  };

  const isActive = activeTabId === path;

  return (
    <div>
      <div
        className={`flex items-center gap-1.5 py-1 px-2 cursor-pointer hover:bg-surface/50 transition-colors select-none text-sm ${
          isActive ? "bg-surface text-accent font-medium" : "text-text-secondary"
        }`}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
        onClick={handleToggle}
      >
        {is_dir ? (
          <>
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Folder size={14} className="text-accent/70" />
          </>
        ) : (
          <>
            <div className="w-[14px]" />
            <File size={14} className="text-text-muted/70" />
          </>
        )}
        <span className="truncate">{name}</span>
      </div>
      {isOpen && children.length > 0 && (
        <div>
          {children.map((child) => (
            <FileNode key={child.path} {...child} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Sidebar() {
  const { rootPath, setRootPath, leftSidebarWidth, setLeftSidebarWidth } = useEditorStore();
  const [entries, setEntries] = useState<FileNodeProps[]>([]);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const isResizing = useRef(false);

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
    if (newWidth > 150 && newWidth < 600) {
      setLeftSidebarWidth(newWidth);
    }
  }, [setLeftSidebarWidth]);

  const stopResizing = useCallback(() => {
    isResizing.current = false;
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", stopResizing);
    document.body.style.cursor = "default";
  }, [handleMouseMove]);

  const handleOpenFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      if (selected && typeof selected === "string") {
        setRootPath(selected);
      }
    } catch (err) {
      console.error("Failed to open folder:", err);
    }
  };

  useEffect(() => {
    async function loadRoot() {
      if (rootPath) {
        try {
          const result = await invoke<DirEntry[]>("list_dir", { path: rootPath });
          const nodes = result.map((entry) => ({
            ...entry,
            level: 0,
          }));
          setEntries(nodes);
        } catch (err) {
          console.error("Failed to load root:", err);
        }
      } else {
        setEntries([]);
      }
    }
    loadRoot();
  }, [rootPath]);

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
        <span className="text-xs font-bold uppercase tracking-wider text-text-muted">资源管理器</span>
        <div className="flex items-center gap-1 no-drag">
          <button 
            onClick={() => setIsSearchOpen(!isSearchOpen)}
            className={`p-1 rounded hover:bg-surface transition-colors cursor-pointer ${isSearchOpen ? "text-accent bg-surface" : "text-text-muted hover:text-accent"}`}
            title="搜索文件"
          >
            <Search size={14} />
          </button>
          <button 
            onClick={handleOpenFolder}
            className="p-1 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer"
            title="打开文件夹"
          >
            <FolderOpen size={14} />
          </button>
          <button className="p-1 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer">
            <Plus size={14} />
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

      <div className="flex-1 overflow-auto py-2">
        {rootPath ? (
          entries.length > 0 ? (
            entries.map((entry) => (
              <FileNode key={entry.path} {...entry} />
            ))
          ) : (
            <div className="px-4 py-2 text-xs text-text-muted italic text-center">空目录</div>
          )
        ) : (
          <div className="h-full flex flex-col items-center justify-center p-6 text-center space-y-4">
            <div className="w-12 h-12 rounded-full bg-accent/5 flex items-center justify-center text-accent/40">
              <Folder size={24} />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-text-secondary font-medium">未打开文件夹</p>
              <p className="text-[10px] text-text-muted">打开一个文件夹来查看文件结构</p>
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
    </div>
  );
}
