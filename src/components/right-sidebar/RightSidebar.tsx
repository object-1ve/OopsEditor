/**
 * RightSidebar - Info, Outline panels with icon tabs
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Info, HelpCircle, ListTree } from "lucide-react";
import { useEditorStore } from "@/store/editor";
import InfoPanel from "./panels/InfoPanel";
import OutlinePanel from "./panels/OutlinePanel";

const COLLAPSED_WIDTH = 40;
const DEFAULT_OUTLINE_WIDTH = 280;
const DEFAULT_INFO_WIDTH = 280;

export default function RightSidebar() {
  const tabs = useEditorStore(s => s.tabs);
  const activeTabId = useEditorStore(s => s.activeTabId);
  const rightSidebarWidth = useEditorStore(s => s.rightSidebarWidth);
  const setRightSidebarWidth = useEditorStore(s => s.setRightSidebarWidth);
  const rightSidebarIconOrder = useEditorStore(s => s.rightSidebarIconOrder);
  const setRightSidebarIconOrder = useEditorStore(s => s.setRightSidebarIconOrder);
  const isResizing = useRef(false);
  const [activePanel, setActivePanel] = useState<"outline" | "info" | null>(null);
  const [draggedIcon, setDraggedIcon] = useState<string | null>(null);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const isMarkdownTab = activeTab?.language === "markdown";

  const isPanelOpen = activePanel !== null;
  const isOutlineOpen = isMarkdownTab && activePanel === "outline";
  const isInfoOpen = activePanel === "info";

  const displayWidth = isPanelOpen
    ? Math.max(rightSidebarWidth, activePanel === "outline" ? DEFAULT_OUTLINE_WIDTH : DEFAULT_INFO_WIDTH)
    : COLLAPSED_WIDTH;

  useEffect(() => {
    if (!isMarkdownTab && activePanel === "outline") {
      setActivePanel(null);
    }
  }, [isMarkdownTab, activePanel]);

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

  const togglePanel = useCallback((panel: "outline" | "info") => {
    setActivePanel((current) => {
      const nextPanel = current === panel ? null : panel;
      const defaultWidth = panel === "outline" ? DEFAULT_OUTLINE_WIDTH : DEFAULT_INFO_WIDTH;
      if (nextPanel === panel && rightSidebarWidth < defaultWidth) {
        setRightSidebarWidth(defaultWidth);
      }
      return nextPanel;
    });
  }, [rightSidebarWidth, setRightSidebarWidth]);

  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggedIcon(id);
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
    const target = e.currentTarget as HTMLElement;
    setTimeout(() => { target.style.opacity = "0.4"; }, 0);
  };

  const handleDragEnter = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    if (!draggedIcon || draggedIcon === id) return;
    const newOrder = [...rightSidebarIconOrder];
    const draggedIdx = newOrder.indexOf(draggedIcon);
    const targetIdx = newOrder.indexOf(id);
    if (draggedIdx !== -1 && targetIdx !== -1) {
      newOrder.splice(draggedIdx, 1);
      newOrder.splice(targetIdx, 0, draggedIcon);
      setRightSidebarIconOrder(newOrder);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDragEnd = (e: React.DragEvent) => {
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
          </div>
          <div className="flex-1 overflow-y-auto">
            <OutlinePanel content={activeTab?.content} tabId={activeTab?.id} />
          </div>
        </div>
      )}

      {isInfoOpen && (
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="h-10 px-4 border-b border-border flex items-center">
            <span className="text-sm font-medium text-text-primary">文件信息</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <InfoPanel filePath={activeTab?.path} />
          </div>
        </div>
      )}

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
