import { File, X, ChevronLeft, ChevronRight, CopyX } from "lucide-react";
import { useEditorStore } from "../store/editor";
import { invoke } from "@tauri-apps/api/core";
import { useState, useEffect, useCallback, useMemo } from "react";
import ContextMenu from "./ContextMenu";

export default function Toolbar() {
  const { 
    tabs, 
    activeTabId, 
    setActiveTab, 
    closeTab, 
    closeTabs,
    closeOtherTabs,
    closeTabsToLeft,
    closeTabsToRight,
    openTab, 
    showNotification, 
    defaultFolders,
    showModal 
  } = useEditorStore();

  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, tabId: string } | null>(null);

  const handleCloseTab = useCallback((e: React.MouseEvent | { stopPropagation: () => void }, tab: any) => {
    e.stopPropagation();
    if (tab.isDirty) {
      showModal({
        title: "确认关闭",
        message: `文件 "${tab.name}" 尚未保存，关闭将丢失所有更改。确定要关闭吗？`,
        kind: "warning",
        onConfirm: () => closeTab(tab.id),
      });
    } else {
      closeTab(tab.id);
    }
  }, [closeTab, showModal]);

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, tabId });
  };

  const handleCloseOthers = useCallback(() => {
    if (!contextMenu) return;
    const currentTabId = contextMenu.tabId;
    const otherTabs = tabs.filter(t => t.id !== currentTabId);
    const dirtyTabs = otherTabs.filter(t => t.isDirty);

    if (dirtyTabs.length > 0) {
      showModal({
        title: "确认关闭其他文件",
        message: `有 ${dirtyTabs.length} 个文件尚未保存，关闭将丢失更改。确定要全部关闭吗？`,
        kind: "warning",
        onConfirm: () => closeOtherTabs(currentTabId),
      });
    } else {
      closeOtherTabs(currentTabId);
    }
    setContextMenu(null);
  }, [contextMenu, tabs, closeOtherTabs, showModal]);

  const handleCloseLeft = useCallback(() => {
    if (!contextMenu) return;
    const currentTabId = contextMenu.tabId;
    const idx = tabs.findIndex(t => t.id === currentTabId);
    const leftTabs = tabs.slice(0, idx);
    const dirtyTabs = leftTabs.filter(t => t.isDirty);

    if (dirtyTabs.length > 0) {
      showModal({
        title: "确认关闭左侧文件",
        message: `左侧有 ${dirtyTabs.length} 个文件尚未保存，关闭将丢失更改。确定要全部关闭吗？`,
        kind: "warning",
        onConfirm: () => closeTabsToLeft(currentTabId),
      });
    } else {
      closeTabsToLeft(currentTabId);
    }
    setContextMenu(null);
  }, [contextMenu, tabs, closeTabsToLeft, showModal]);

  const handleCloseRight = useCallback(() => {
    if (!contextMenu) return;
    const currentTabId = contextMenu.tabId;
    const idx = tabs.findIndex(t => t.id === currentTabId);
    const rightTabs = tabs.slice(idx + 1);
    const dirtyTabs = rightTabs.filter(t => t.isDirty);

    if (dirtyTabs.length > 0) {
      showModal({
        title: "确认关闭右侧文件",
        message: `右侧有 ${dirtyTabs.length} 个文件尚未保存，关闭将丢失更改。确定要全部关闭吗？`,
        kind: "warning",
        onConfirm: () => closeTabsToRight(currentTabId),
      });
    } else {
      closeTabsToRight(currentTabId);
    }
    setContextMenu(null);
  }, [contextMenu, tabs, closeTabsToRight, showModal]);

  const contextMenuItems = useMemo(() => {
    if (!contextMenu) return [];
    const tab = tabs.find(t => t.id === contextMenu.tabId);
    if (!tab) return [];

    return [
      { 
        label: "关闭标签页", 
        icon: <X size={14} />, 
        onClick: () => handleCloseTab({ stopPropagation: () => {} } as any, tab) 
      },
      { separator: true, label: "", onClick: () => {} },
      { 
        label: "关闭其他标签页", 
        icon: <CopyX size={14} />, 
        onClick: handleCloseOthers 
      },
      { 
        label: "关闭左侧标签页", 
        icon: <ChevronLeft size={14} />, 
        onClick: handleCloseLeft 
      },
      { 
        label: "关闭右侧标签页", 
        icon: <ChevronRight size={14} />, 
        onClick: handleCloseRight 
      },
    ];
  }, [contextMenu, tabs, handleCloseTab, handleCloseOthers, handleCloseLeft, handleCloseRight]);

  const handleDoubleClick = useCallback(async (e: React.MouseEvent) => {
    // 只有在标签栏空白处双击才触发（或者在整个工具栏双击，但要避开按钮）
    if (e.target !== e.currentTarget) return;

    // 获取当前时间并格式化为 YYYY-MM-DD_HH-mm-ss
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    
    const fileName = `${year}-${month}-${day}_${hours}-${minutes}-${seconds}.txt`;
    const defaultPath = defaultFolders[0]?.path || "d:/Desktop/oops_try/OopsEditor/src";
    const filePath = `${defaultPath}/${fileName}`;
    
    try {
      // 创建文件（空内容）
      await invoke("save_file", { path: filePath, content: "" });
      
      // 在编辑器中打开
      openTab({
        id: filePath,
        name: fileName,
        path: filePath,
        language: "plaintext",
        content: "",
        isDirty: false,
      });
      
      showNotification(`已创建并打开新文件: ${fileName}`, "success");

      // 延迟一小段时间确保系统文件刷新，然后触发同步
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path: defaultPath } }));
      }, 200);
    } catch (err) {
      console.error("Failed to create file:", err);
      showNotification(`创建文件失败: ${err}`, "error");
    }
  }, [defaultFolders, openTab, showNotification]);

  return (
    <div 
      className="flex items-center h-10 bg-secondary border-b border-border select-none relative z-10 cursor-default"
      onDoubleClick={handleDoubleClick}
    >
      {/* Tabs */}
      <div className="flex items-center flex-1 overflow-x-auto h-full relative" onDoubleClick={handleDoubleClick}>
        <div className="flex items-center h-full" onDoubleClick={handleDoubleClick}>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`group relative flex items-center gap-1.5 px-3 h-full text-sm cursor-pointer transition-all duration-150 min-w-0 shrink-0 select-none ${
                tab.id === activeTabId
                  ? "bg-primary text-text-primary"
                  : "bg-secondary text-text-muted hover:text-text-secondary hover:bg-surface/50"
              }`}
              onClick={() => setActiveTab(tab.id)}
              onDoubleClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => handleContextMenu(e, tab.id)}
            >
              {tab.id === activeTabId && (
                <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-accent to-accent-bright rounded-full" />
              )}

              <File size={14} className="shrink-0 opacity-60" />
              <span className="truncate max-w-28">{tab.name}</span>
              {tab.isDirty && <span className="text-accent-warm text-xs shrink-0">&#9679;</span>}
              <button
                className="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-surface transition-all shrink-0 cursor-pointer text-text-muted hover:text-text-primary"
                onClick={(e) => handleCloseTab(e, tab)}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
