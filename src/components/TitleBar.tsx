import { X, ChevronLeft, ChevronRight, CopyX, Save, Pin, ArrowRight } from "lucide-react";
import { useEditorStore } from "@/store/editor";
import { invoke } from "@tauri-apps/api/core";
import { useState, useCallback, useMemo } from "react";
import ContextMenu from "./ContextMenu";
import MaterialFileIcon from "./MaterialFileIcon";
import WindowControls from "./WindowControls";
import { saveTab } from "@/services/editorSave";
import { detectLanguage } from "@/types";
import { useTabStripDensity } from "@/hooks/useTabStripDensity";

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

export default function TitleBar() {
  // ── Store ──
  const tabs = useEditorStore(s => s.tabs);
  const activeTabId = useEditorStore(s => s.activeTabId);
  const isSplit = useEditorStore(s => s.isSplit);
  const focusedPane = useEditorStore(s => s.focusedPane);
  const setFocusedPane = useEditorStore(s => s.setFocusedPane);
  const setActiveTabInPane = useEditorStore(s => s.setActiveTabInPane);
  const closeTabInPane = useEditorStore(s => s.closeTabInPane);
  const closeTabsInPane = useEditorStore(s => s.closeTabsInPane);
  const openTabInPane = useEditorStore(s => s.openTabInPane);
  const showNotification = useEditorStore(s => s.showNotification);
  const defaultFolders = useEditorStore(s => s.defaultFolders);
  const pinnedFiles = useEditorStore(s => s.pinnedFiles);
  const pinFile = useEditorStore(s => s.pinFile);
  const unpinFile = useEditorStore(s => s.unpinFile);
  const replaceTabFileLocation = useEditorStore(s => s.replaceTabFileLocation);
  const showModal = useEditorStore(s => s.showModal);
  const setHoveredPath = useEditorStore(s => s.setHoveredPath);
  const defaultSavePath = useEditorStore(s => s.defaultSavePath);

  const isSecondary = false; // TitleBar always handles primary pane
  const pane = "primary" as const;
  const isFocused = isSplit && focusedPane === pane;
  const { ref: tabStripRef, hideClose, hideName } = useTabStripDensity(tabs.length);

  // ── Tab actions ──
  const setActive = useCallback((id: string) => {
    setActiveTabInPane(id, pane);
  }, [setActiveTabInPane, pane]);

  const handleClose = useCallback((e: React.MouseEvent | { stopPropagation: () => void }, tab: any) => {
    e.stopPropagation();
    if (tab.isDirty) {
      showModal({
        title: "确认关闭",
        message: `文件 "${tab.name}" 尚未保存，关闭将丢失所有更改。确定要关闭吗？`,
        kind: "warning",
        onConfirm: () => closeTabInPane(tab.id, pane),
      });
    } else {
      closeTabInPane(tab.id, pane);
    }
  }, [closeTabInPane, showModal, pane]);

  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, tabId: string } | null>(null);

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
      closeTabsInPane(cleanTabs.map((tab) => tab.id), pane);
    }
    if (dirtyTabs.length > 0) {
      showModal({
        title: "确认关闭其他文件",
        message: `有 ${dirtyTabs.length} 个文件尚未保存，关闭将丢失更改。确定要全部关闭吗？`,
        kind: "warning",
        onConfirm: () => closeTabsInPane(dirtyTabs.map((tab) => tab.id), pane),
      });
    }
    setContextMenu(null);
  }, [contextMenu, tabs, closeTabsInPane, showModal, pane]);

  const handleCloseLeft = useCallback(() => {
    if (!contextMenu) return;
    const currentTabId = contextMenu.tabId;
    const idx = tabs.findIndex(t => t.id === currentTabId);
    const leftTabs = tabs.slice(0, idx);
    const cleanTabs = leftTabs.filter(t => !t.isDirty);
    const dirtyTabs = leftTabs.filter(t => t.isDirty);

    if (cleanTabs.length > 0) {
      closeTabsInPane(cleanTabs.map((tab) => tab.id), pane);
    }
    if (dirtyTabs.length > 0) {
      showModal({
        title: "确认关闭左侧文件",
        message: `左侧有 ${dirtyTabs.length} 个文件尚未保存，关闭将丢失更改。确定要全部关闭吗？`,
        kind: "warning",
        onConfirm: () => closeTabsInPane(dirtyTabs.map((tab) => tab.id), pane),
      });
    }
    setContextMenu(null);
  }, [contextMenu, tabs, closeTabsInPane, showModal, pane]);

  const handleCloseRight = useCallback(() => {
    if (!contextMenu) return;
    const currentTabId = contextMenu.tabId;
    const idx = tabs.findIndex(t => t.id === currentTabId);
    const rightTabs = tabs.slice(idx + 1);
    const cleanTabs = rightTabs.filter(t => !t.isDirty);
    const dirtyTabs = rightTabs.filter(t => t.isDirty);

    if (cleanTabs.length > 0) {
      closeTabsInPane(cleanTabs.map((tab) => tab.id), pane);
    }
    if (dirtyTabs.length > 0) {
      showModal({
        title: "确认关闭右侧文件",
        message: `右侧有 ${dirtyTabs.length} 个文件尚未保存，关闭将丢失更改。确定要全部关闭吗？`,
        kind: "warning",
        onConfirm: () => closeTabsInPane(dirtyTabs.map((tab) => tab.id), pane),
      });
    }
    setContextMenu(null);
  }, [contextMenu, tabs, closeTabsInPane, showModal, pane]);

  const handleCloseAll = useCallback(() => {
    if (!contextMenu) return;
    const cleanTabs = tabs.filter(t => !t.isDirty);
    const dirtyTabs = tabs.filter(t => t.isDirty);

    if (cleanTabs.length > 0) {
      closeTabsInPane(cleanTabs.map((tab) => tab.id), pane);
    }
    if (dirtyTabs.length > 0) {
      showModal({
        title: "确认关闭所有标签页",
        message: `有 ${dirtyTabs.length} 个文件尚未保存，关闭将丢失更改。确定要全部关闭吗？`,
        kind: "warning",
        onConfirm: () => closeTabsInPane(dirtyTabs.map((tab) => tab.id), pane),
      });
    }
    setContextMenu(null);
  }, [contextMenu, tabs, closeTabsInPane, showModal, pane]);

  const handleTransferToOtherPane = useCallback(() => {
    if (!contextMenu || !isSplit) return;
    const tab = tabs.find(t => t.id === contextMenu.tabId);
    if (!tab) return;

    const targetPane = "secondary" as const;
    closeTabInPane(tab.id, pane);
    openTabInPane(tab, targetPane);
    showNotification(`已将 "${tab.name}" 转移到右分区`, "success");
    setContextMenu(null);
  }, [contextMenu, isSplit, tabs, closeTabInPane, openTabInPane, pane, showNotification]);

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
      await saveTab(tab, targetPath);
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
    const isPinnedToSidebar = pinnedFiles.some((item) => item.path === tab.path);

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
      { separator: true, label: "", onClick: () => {} },
      {
        label: isPinnedToSidebar ? "从左侧边栏取消固定" : "固定到左侧边栏",
        icon: <Pin size={14} />,
        onClick: () => {
          if (isPinnedToSidebar) {
            unpinFile(tab.path);
            showNotification(`已取消固定 ${tab.name}`, "success");
            return;
          }

          pinFile({ name: tab.name, path: tab.path });
          showNotification(`已固定到左侧边栏: ${tab.name}`, "success");
        },
      },
      ...(isSplit ? [
        { separator: true, label: "", onClick: () => {} },
        {
          label: "转移到右分区",
          icon: <ArrowRight size={14} />,
          onClick: handleTransferToOtherPane,
        },
      ] : []),
      { separator: true, label: "", onClick: () => {} },
      {
        label: "关闭标签页",
        icon: <X size={14} />,
        onClick: () => handleClose({ stopPropagation: () => {} } as any, tab)
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
      { separator: true, label: "", onClick: () => {} },
      {
        label: "关闭所有标签页",
        icon: <CopyX size={14} />,
        onClick: handleCloseAll
      },
    ];
  }, [contextMenu, tabs, defaultFolders, pinnedFiles, handleClose, handleCloseOthers, handleCloseLeft, handleCloseRight, handleCloseAll, handleSaveToDefaultFolder, handleTransferToOtherPane, pinFile, showNotification, unpinFile, isSplit]);


  const handleTabDoubleClick = useCallback(async (e: React.MouseEvent) => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    const fileName = `${year}-${month}-${day}_${hours}-${minutes}-${seconds}.md`;
    const savePath = defaultSavePath || defaultFolders[0]?.path || "";
    if (!savePath) {
      showNotification("请先在设置中配置默认文件保存路径", "error");
      return;
    }
    const filePath = buildChildPath(savePath, fileName);

    try {
      await invoke("save_file", { path: filePath, content: "" });

      const newTab = {
        id: filePath,
        name: fileName,
        path: filePath,
        language: detectLanguage(fileName).language,
        content: "",
        isDirty: false,
      };
      openTabInPane(newTab, pane);

      showNotification(`已创建并打开新文件: ${fileName}`, "success");

      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path: savePath } }));
      }, 200);
    } catch (err) {
      console.error("Failed to create file:", err);
      showNotification(`创建文件失败: ${err}`, "error");
    }
  }, [defaultFolders, defaultSavePath, openTabInPane, pane, showNotification]);

  return (
    <div
      ref={tabStripRef}
      data-tauri-drag-region
      onMouseDown={() => isSplit && setFocusedPane(pane)}
      className={`h-8 bg-deepest border-b border-border flex items-center select-none relative z-[100] cursor-default transition-colors ${
        isSplit ? (isFocused ? "border-b-2 border-b-accent" : "opacity-80") : ""
      }`}
    >
      {/* Tabs */}
      <div className="flex items-center flex-initial min-w-0 overflow-x-auto h-full relative">
        <div className="flex items-center h-full" onDoubleClick={handleTabDoubleClick}>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`group relative flex items-center gap-1.5 px-3 h-full text-sm cursor-pointer transition-all duration-150 min-w-10 shrink select-none ${
                tab.id === activeTabId
                  ? "bg-primary text-text-primary"
                  : "bg-secondary text-text-muted hover:text-text-secondary hover:bg-surface/50"
              } ${hideClose ? "tab-no-close" : ""} ${hideName ? "tab-icon-only" : ""}`}
              onClick={() => setActive(tab.id)}
              onContextMenu={(e) => handleContextMenu(e, tab.id)}
              onMouseEnter={() => setHoveredPath(tab.path)}
              onMouseLeave={() => setHoveredPath(null)}
            >
              {tab.id === activeTabId && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-accent to-accent-bright rounded-full" />
              )}

              <MaterialFileIcon
                name={tab.name}
                path={tab.path}
                size={16}
              />
              <span className="tab-name truncate max-w-28">{tab.name}</span>
              {tab.isDirty && <span className="tab-dirty text-accent-warm text-xs shrink-0">&#9679;</span>}
              <button
                className="tab-close ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-surface transition-all shrink-0 cursor-pointer text-text-muted hover:text-text-primary"
                onClick={(e) => handleClose(e, tab)}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Native title-bar drag region: press & drag to move the window, double-click to toggle maximize/restore */}
      <div
        data-tauri-drag-region
        onMouseDown={() => isSplit && setFocusedPane(pane)}
        className="flex-1 min-w-20 h-full"
      />

      <WindowControls />

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
