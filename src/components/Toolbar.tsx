import { X, ChevronLeft, ChevronRight, CopyX, Save } from "lucide-react";
import { useEditorStore } from "../store/editor";
import { invoke } from "@tauri-apps/api/core";
import { useState, useCallback, useMemo } from "react";
import { hexViewToBase64 } from "../utils/hexView";
import ContextMenu from "./ContextMenu";
import MaterialFileIcon from "./MaterialFileIcon";

const buildChildPath = (basePath: string, fileName: string) => {
  if (/[\\/]$/.test(basePath)) {
    return `${basePath}${fileName}`;
  }
  const separator = basePath.includes("\\") ? "\\" : "/";
  return `${basePath}${separator}${fileName}`;
};

const canSaveToDefaultFolder = (language: string) => {
  if (language === "pdf") {
    return false;
  }

  return true;
};

export default function Toolbar() {
  const { 
    tabs, 
    activeTabId, 
    setActiveTab, 
    closeTab, 
    closeTabs,
    openTab, 
    showNotification, 
    defaultFolders,
    replaceTabFileLocation,
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
    const cleanTabs = otherTabs.filter(t => !t.isDirty);
    const dirtyTabs = otherTabs.filter(t => t.isDirty);

    if (cleanTabs.length > 0) {
      closeTabs(cleanTabs.map((tab) => tab.id));
    }

    if (dirtyTabs.length > 0) {
      showModal({
        title: "确认关闭其他文件",
        message: `有 ${dirtyTabs.length} 个文件尚未保存，关闭将丢失更改。确定要全部关闭吗？`,
        kind: "warning",
        onConfirm: () => closeTabs(dirtyTabs.map((tab) => tab.id)),
      });
    }
    setContextMenu(null);
  }, [contextMenu, tabs, closeTabs, showModal]);

  const handleCloseLeft = useCallback(() => {
    if (!contextMenu) return;
    const currentTabId = contextMenu.tabId;
    const idx = tabs.findIndex(t => t.id === currentTabId);
    const leftTabs = tabs.slice(0, idx);
    const cleanTabs = leftTabs.filter(t => !t.isDirty);
    const dirtyTabs = leftTabs.filter(t => t.isDirty);

    if (cleanTabs.length > 0) {
      closeTabs(cleanTabs.map((tab) => tab.id));
    }

    if (dirtyTabs.length > 0) {
      showModal({
        title: "确认关闭左侧文件",
        message: `左侧有 ${dirtyTabs.length} 个文件尚未保存，关闭将丢失更改。确定要全部关闭吗？`,
        kind: "warning",
        onConfirm: () => closeTabs(dirtyTabs.map((tab) => tab.id)),
      });
    }
    setContextMenu(null);
  }, [contextMenu, tabs, closeTabs, showModal]);

  const handleCloseRight = useCallback(() => {
    if (!contextMenu) return;
    const currentTabId = contextMenu.tabId;
    const idx = tabs.findIndex(t => t.id === currentTabId);
    const rightTabs = tabs.slice(idx + 1);
    const cleanTabs = rightTabs.filter(t => !t.isDirty);
    const dirtyTabs = rightTabs.filter(t => t.isDirty);

    if (cleanTabs.length > 0) {
      closeTabs(cleanTabs.map((tab) => tab.id));
    }

    if (dirtyTabs.length > 0) {
      showModal({
        title: "确认关闭右侧文件",
        message: `右侧有 ${dirtyTabs.length} 个文件尚未保存，关闭将丢失更改。确定要全部关闭吗？`,
        kind: "warning",
        onConfirm: () => closeTabs(dirtyTabs.map((tab) => tab.id)),
      });
    }
    setContextMenu(null);
  }, [contextMenu, tabs, closeTabs, showModal]);

  const handleSaveToDefaultFolder = useCallback(async (defaultFolderPath: string, defaultFolderName: string) => {
    if (!contextMenu) return;

    const tab = tabs.find((item) => item.id === contextMenu.tabId);
    if (!tab) return;

    if (!canSaveToDefaultFolder(tab.language)) {
      showNotification("当前视图暂不支持保存到默认文件夹", "info");
      setContextMenu(null);
      return;
    }

    const targetPath = buildChildPath(defaultFolderPath, tab.name);
    const targetTab = tabs.find((item) => item.path === targetPath && item.id !== tab.id);
    if (targetTab) {
      showNotification("目标文件已在其他标签页中打开，请先关闭该标签页", "error");
      setContextMenu(null);
      return;
    }

    const persistToTarget = async () => {
      if (tab.language === "image") {
        await invoke("copy_file", { sourcePath: tab.path, targetPath });
      } else if (tab.viewMode === "base64") {
        await invoke("save_file_from_base64", {
          path: targetPath,
          content: hexViewToBase64(tab.content),
        });
      } else {
        await invoke("save_file", { path: targetPath, content: tab.content });
      }
      replaceTabFileLocation(tab.id, targetPath, tab.name);
      showNotification(`已保存到默认文件夹: ${defaultFolderName}`, "success");
      window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path: defaultFolderPath } }));
      setContextMenu(null);
    };

    if (targetPath === tab.path) {
      await persistToTarget();
      return;
    }

    try {
      const exists = await invoke<boolean>("path_exists", { path: targetPath });
      if (exists) {
        showModal({
          title: "覆盖确认",
          message: `默认文件夹中已存在 "${tab.name}"，继续将覆盖该文件。确定要保存吗？`,
          kind: "warning",
          onConfirm: () => {
            void persistToTarget();
          },
        });
        setContextMenu(null);
        return;
      }

      await persistToTarget();
    } catch (err) {
      console.error("Failed to save to default folder:", err);
      showNotification(`保存到默认文件夹失败: ${err}`, "error");
      setContextMenu(null);
    }
  }, [contextMenu, tabs, replaceTabFileLocation, showNotification, showModal]);

  const contextMenuItems = useMemo(() => {
    if (!contextMenu) return [];
    const tab = tabs.find(t => t.id === contextMenu.tabId);
    if (!tab) return [];

    const saveToDefaultFolderItems = !canSaveToDefaultFolder(tab.language)
      ? []
      : defaultFolders.length > 0
        ? defaultFolders.map((folder) => ({
            label: defaultFolders.length === 1 ? "保存到默认文件夹" : `保存到 ${folder.name}`,
            icon: <Save size={14} />,
            onClick: () => {
              void handleSaveToDefaultFolder(folder.path, folder.name);
            },
            separatorBefore: false,
          }))
        : [
            {
              label: "保存到默认文件夹",
              icon: <Save size={14} />,
              onClick: () => showNotification("请先在侧边栏添加默认文件夹", "info"),
              separatorBefore: false,
            },
          ];

    return [
      ...saveToDefaultFolderItems.flatMap((item) => [
        ...(item.separatorBefore ? [{ separator: true, label: "", onClick: () => {} }] : []),
        { label: item.label, icon: item.icon, onClick: item.onClick },
      ]),
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
  }, [contextMenu, tabs, defaultFolders, handleCloseTab, handleCloseOthers, handleCloseLeft, handleCloseRight, handleSaveToDefaultFolder, showNotification]);

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

              <MaterialFileIcon
                name={tab.name}
                path={tab.path}
                size={16}
              />
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
