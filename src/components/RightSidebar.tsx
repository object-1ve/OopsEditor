import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Info, HelpCircle, ListTree, GitBranch } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "../store/editor";
import { parseMarkdownHeadings } from "../utils/markdown";
import GitPanel from "./GitPanel";

const COLLAPSED_WIDTH = 40;
const DEFAULT_OUTLINE_WIDTH = 280;
const DEFAULT_INFO_WIDTH = 280;
const DEFAULT_GIT_WIDTH = 280;

function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined) return "未知";
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatModifiedTime(timestamp: number | undefined): string {
  if (!timestamp) return "未知";

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

interface FileInfo {
  size: number;
  modified_at: number;
}

export default function RightSidebar() {
  const tabs = useEditorStore(s => s.tabs);
  const activeTabId = useEditorStore(s => s.activeTabId);
  const rightSidebarWidth = useEditorStore(s => s.rightSidebarWidth);
  const setRightSidebarWidth = useEditorStore(s => s.setRightSidebarWidth);
  const navigateToMarkdownHeading = useEditorStore(s => s.navigateToMarkdownHeading);
  const rightSidebarIconOrder = useEditorStore(s => s.rightSidebarIconOrder);
  const setRightSidebarIconOrder = useEditorStore(s => s.setRightSidebarIconOrder);
  const isResizing = useRef(false);
  const [activePanel, setActivePanel] = useState<"outline" | "info" | "git" | null>(null);
  const [draggedIcon, setDraggedIcon] = useState<string | null>(null);
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const isMarkdownTab = activeTab?.language === "markdown";

  const headings = useMemo(
    () => (isMarkdownTab && activeTab ? parseMarkdownHeadings(activeTab.content) : []),
    [activeTab, isMarkdownTab],
  );

  const isPanelOpen = activePanel !== null;
  const isOutlineOpen = isMarkdownTab && activePanel === "outline";
  const isInfoOpen = activePanel === "info";
  const isGitOpen = activePanel === "git";

  const displayWidth = isPanelOpen
    ? Math.max(rightSidebarWidth, activePanel === "outline" ? DEFAULT_OUTLINE_WIDTH : activePanel === "git" ? DEFAULT_GIT_WIDTH : DEFAULT_INFO_WIDTH)
    : COLLAPSED_WIDTH;

  useEffect(() => {
    if (!isMarkdownTab && activePanel === "outline") {
      setActivePanel(null);
    }
  }, [isMarkdownTab, activePanel]);

  useEffect(() => {
    let cancelled = false;

    if (!activeTab?.path) {
      setFileInfo(null);
      return;
    }

    void invoke<FileInfo>("get_file_info", { path: activeTab.path })
      .then((info) => {
        if (!cancelled) {
          setFileInfo(info);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFileInfo(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab?.path, activeTab?.isDirty]);

  const startResizing = useCallback((e: React.MouseEvent) => {
    if (!isPanelOpen) return;
    e.preventDefault();
    isResizing.current = true;
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", stopResizing);
    document.body.style.cursor = "col-resize";
  }, [isPanelOpen]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing.current) return;
    const newWidth = window.innerWidth - e.clientX;
    if (newWidth > 180 && newWidth < 400) {
      setRightSidebarWidth(newWidth);
    }
  }, [setRightSidebarWidth]);

  const stopResizing = useCallback(() => {
    isResizing.current = false;
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", stopResizing);
    document.body.style.cursor = "default";
  }, [handleMouseMove]);

  const togglePanel = useCallback((panel: "outline" | "info" | "git") => {
    setActivePanel((current) => {
      const nextPanel = current === panel ? null : panel;
      const defaultWidth = panel === "outline" ? DEFAULT_OUTLINE_WIDTH : panel === "git" ? DEFAULT_GIT_WIDTH : DEFAULT_INFO_WIDTH;
      if (nextPanel === panel && rightSidebarWidth < defaultWidth) {
        setRightSidebarWidth(defaultWidth);
      }
      return nextPanel;
    });
  }, [rightSidebarWidth, setRightSidebarWidth]);

  const handleHeadingClick = useCallback((headingId: string, line: number) => {
    if (!activeTab) return;
    navigateToMarkdownHeading({
      tabId: activeTab.id,
      headingId,
      line,
    });
  }, [activeTab, navigateToMarkdownHeading]);

  const handleDragStart = (e: React.DragEvent, id: string) => {
    console.log("DragStart:", id);
    setDraggedIcon(id);
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
    
    const target = e.currentTarget as HTMLElement;
    setTimeout(() => {
      target.style.opacity = "0.4";
    }, 0);
  };

  const handleDragEnter = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    console.log("DragEnter target:", id, "draggedIcon:", draggedIcon);
    if (!draggedIcon || draggedIcon === id) return;

    const newOrder = [...rightSidebarIconOrder];
    const draggedIdx = newOrder.indexOf(draggedIcon);
    const targetIdx = newOrder.indexOf(id);

    console.log("Attempting swap:", draggedIdx, "->", targetIdx);

    if (draggedIdx !== -1 && targetIdx !== -1) {
      newOrder.splice(draggedIdx, 1);
      newOrder.splice(targetIdx, 0, draggedIcon);
      console.log("New order calculated:", newOrder);
      setRightSidebarIconOrder(newOrder);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDragEnd = (e: React.DragEvent) => {
    console.log("DragEnd");
    setDraggedIcon(null);
    const target = e.currentTarget as HTMLElement;
    target.style.opacity = "1";
  };

  const renderIcon = (id: string) => {
    switch (id) {
      case "info":
        return (
          <SidebarIcon
            key="info"
            icon={<Info size={18} />}
            title="文件信息"
            isActive={isInfoOpen}
            onClick={() => togglePanel("info")}
            onDragStart={(e) => handleDragStart(e, "info")}
            onDragEnter={(e) => handleDragEnter(e, "info")}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            isDragging={draggedIcon === "info"}
          />
        );
      case "git":
        return (
          <SidebarIcon
            key="git"
            icon={<GitBranch size={18} />}
            title="Git"
            isActive={isGitOpen}
            onClick={() => togglePanel("git")}
            onDragStart={(e) => handleDragStart(e, "git")}
            onDragEnter={(e) => handleDragEnter(e, "git")}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            isDragging={draggedIcon === "git"}
          />
        );
      case "outline":
        return isMarkdownTab ? (
          <SidebarIcon
            key="outline"
            icon={<ListTree size={18} />}
            title={isOutlineOpen ? "收起目录" : "显示目录"}
            isActive={isOutlineOpen}
            onClick={() => togglePanel("outline")}
            onDragStart={(e) => handleDragStart(e, "outline")}
            onDragEnter={(e) => handleDragEnter(e, "outline")}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            isDragging={draggedIcon === "outline"}
          />
        ) : null;
      case "help":
        return (
          <SidebarIcon
            key="help"
            icon={<HelpCircle size={18} />}
            title="帮助"
            onDragStart={(e) => handleDragStart(e, "help")}
            onDragEnter={(e) => handleDragEnter(e, "help")}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            isDragging={draggedIcon === "help"}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div
      className="h-full bg-deepest border-l border-border flex relative overflow-hidden"
      style={{ width: `${displayWidth}px` }}
    >
      {/* Resize Handle */}
      {isPanelOpen && (
        <div
          onMouseDown={startResizing}
          className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors z-50"
        />
      )}

      <div 
        className="w-10 shrink-0 flex flex-col items-center py-4 gap-4 border-r border-border"
        onDragOver={handleDragOver}
      >
        {rightSidebarIconOrder.filter(id => id !== "help").map(renderIcon)}
        <div className="flex-1" />
        {rightSidebarIconOrder.includes("help") && renderIcon("help")}
      </div>

      {isOutlineOpen && (
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="h-10 px-4 border-b border-border flex items-center justify-between">
            <span className="text-sm font-medium text-text-primary">目录</span>
            <span className="text-[11px] text-text-muted">
              {headings.length} 项
            </span>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            {headings.length > 0 ? (
              headings.map((heading) => (
                <button
                  key={`${heading.id}-${heading.line}`}
                  onClick={() => handleHeadingClick(heading.id, heading.line)}
                  className="w-full text-left px-4 py-1.5 text-sm text-text-secondary hover:text-accent hover:bg-surface/50 transition-colors truncate"
                  style={{ paddingLeft: `${16 + (heading.level - 1) * 14}px` }}
                  title={heading.text}
                >
                  {heading.text}
                </button>
              ))
            ) : (
              <div className="px-4 py-3 text-sm text-text-muted">
                当前 Markdown 没有可用标题
              </div>
            )}
          </div>
        </div>
      )}

      {isInfoOpen && (
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="h-10 px-4 border-b border-border flex items-center">
            <span className="text-sm font-medium text-text-primary">文件信息</span>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {activeTab ? (
              <>
                <InfoSection title="基本信息">
                  <InfoItem label="文件名" value={activeTab.name} />
                  <InfoItem label="大小" value={formatFileSize(fileInfo?.size ?? activeTab.size)} />
                  <InfoItem label="类型" value={activeTab.language.toUpperCase()} />
                  <InfoItem label="状态" value={activeTab.isDirty ? "已修改" : "已保存"} />
                  <InfoItem label="修改时间" value={formatModifiedTime(fileInfo?.modified_at)} />
                </InfoSection>

                <InfoSection title="路径信息">
                  <div className="space-y-1">
                    <span className="text-[11px] text-text-muted uppercase tracking-wider">完整路径</span>
                    <p className="text-xs text-text-secondary break-all bg-surface/30 p-2 rounded border border-border/50">
                      {activeTab.path}
                    </p>
                  </div>
                </InfoSection>

                <InfoSection title="统计信息">
                  <InfoItem label="字符数" value={activeTab.content.length.toLocaleString()} />
                  <InfoItem label="行数" value={activeTab.content.split("\n").length.toLocaleString()} />
                  <InfoItem label="单词数" value={activeTab.content.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} />
                </InfoSection>
              </>
            ) : (
              <div className="text-center py-8 text-text-muted text-sm">
                未选择活跃文件
              </div>
            )}
          </div>
        </div>
      )}

      {isGitOpen && (
        <GitPanel />
      )}
    </div>
  );
}

function InfoSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-[11px] font-bold text-text-muted uppercase tracking-widest px-1">
        {title}
      </h3>
      <div className="space-y-2.5">
        {children}
      </div>
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between items-center px-1">
      <span className="text-xs text-text-secondary">{label}</span>
      <span className="text-xs font-medium text-text-primary truncate ml-4" title={String(value)}>
        {value}
      </span>
    </div>
  );
}

function SidebarIcon({
  icon,
  title,
  isActive = false,
  onClick,
  onDragStart,
  onDragEnter,
  onDragOver,
  onDragEnd,
  isDragging = false,
}: {
  icon: ReactNode;
  title: string;
  isActive?: boolean;
  onClick?: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnter: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  isDragging?: boolean;
}) {
  return (
    <button
      draggable
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={`p-2 rounded-lg transition-all duration-200 cursor-pointer group relative ${
        isActive
          ? "bg-surface text-accent"
          : "text-text-muted hover:text-accent hover:bg-surface"
      } ${isDragging ? "opacity-30 scale-90" : "opacity-100"}`}
      title={title}
    >
      {icon}
      <span className="absolute right-full mr-2 px-2 py-1 rounded bg-secondary text-text-primary text-[10px] whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity shadow-sm border border-border z-50">
        {title}
      </span>
    </button>
  );
}
