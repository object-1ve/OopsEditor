import { X, ChevronLeft, ChevronRight, CopyX, Save, Pin, SplitSquareHorizontal, ArrowRight } from "lucide-react";
import { useEditorStore, type EditorPane } from "../store/editor";
import { invoke } from "@tauri-apps/api/core";
import { useState, useCallback, useMemo } from "react";
import ContextMenu from "./ContextMenu";
import MaterialFileIcon from "./MaterialFileIcon";
import { saveTab } from "../services/editorSave";

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

interface ToolbarProps {
  pane?: EditorPane;
}

export default function Toolbar({ pane = "primary" }: ToolbarProps) {
  const store = useEditorStore();
  const {
    tabs,
    activeTabId,
    secondaryTabs,
    secondaryActiveTabId,
    isSplit,
    focusedPane,
    toggleSplit,
    setSplit,
    setFocusedPane,
    setActiveTabInPane,
    closeTabInPane,
    closeTabsInPane,
    openTabInPane,
    showNotification,
    defaultFolders,
    pinnedFiles,
    pinFile,
    unpinFile,
    replaceTabFileLocation,
    showModal,
    setHoveredPath,
  } = store;

  const isSecondary = pane === "secondary";
  // 副窗口持有独立的标签列表，与主窗口互不影响；同 id 标签共享内容（由 updateContent 同步）
  const paneTabs = isSecondary ? secondaryTabs : tabs;
  const paneActiveTabId = isSecondary ? secondaryActiveTabId : activeTabId;
  const isFocused = isSplit && focusedPane === pane;

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
    const otherTabs = paneTabs.filter(t => t.id !== currentTabId);
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
  }, [contextMenu, paneTabs, closeTabsInPane, showModal, pane]);

  const handleCloseLeft = useCallback(() => {
    if (!contextMenu) return;
    const currentTabId = contextMenu.tabId;
    const idx = paneTabs.findIndex(t => t.id === currentTabId);
    const leftTabs = paneTabs.slice(0, idx);
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
  }, [contextMenu, paneTabs, closeTabsInPane, showModal, pane]);

  const handleCloseRight = useCallback(() => {
    if (!contextMenu) return;
    const currentTabId = contextMenu.tabId;
    const idx = paneTabs.findIndex(t => t.id === currentTabId);
    const rightTabs = paneTabs.slice(idx + 1);
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
  }, [contextMenu, paneTabs, closeTabsInPane, showModal, pane]);

  const handleTransferToOtherPane = useCallback(() => {
    if (!contextMenu || !isSplit) return;
    const tab = paneTabs.find(t => t.id === contextMenu.tabId);
    if (!tab) return;

    const targetPane = isSecondary ? "primary" : "secondary";

    // Close from current pane
    closeTabInPane(tab.id, pane);

    // Open in target pane
    openTabInPane(tab, targetPane);

    showNotification(`已将 "${tab.name}" 转移到${isSecondary ? "左" : "右"}分区`, "success");
    setContextMenu(null);
  }, [contextMenu, isSplit, isSecondary, paneTabs, closeTabInPane, openTabInPane, pane, showNotification]);

  const handleSaveToDefaultFolder = useCallback(async (defaultFolderPath: string, defaultFolderName: string) => {
    if (!contextMenu) return;

    const tab = paneTabs.find((item) => item.id === contextMenu.tabId);
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
  }, [contextMenu, paneTabs, tabs, replaceTabFileLocation, showNotification, showModal]);

  const contextMenuItems = useMemo(() => {
    if (!contextMenu) return [];
    const tab = paneTabs.find(t => t.id === contextMenu.tabId);
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
          label: isSecondary ? "转移到左分区" : "转移到右分区",
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
    ];
  }, [contextMenu, paneTabs, defaultFolders, pinnedFiles, handleClose, handleCloseOthers, handleCloseLeft, handleCloseRight, handleSaveToDefaultFolder, handleTransferToOtherPane, pinFile, showNotification, unpinFile, isSplit, isSecondary]);

  const handleDoubleClick = useCallback(async (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;

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
      await invoke("save_file", { path: filePath, content: "" });

      const newTab = {
        id: filePath,
        name: fileName,
        path: filePath,
        language: "plaintext",
        content: "",
        isDirty: false,
      };
      openTabInPane(newTab, pane);

      showNotification(`已创建并打开新文件: ${fileName}`, "success");

      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path: defaultPath } }));
      }, 200);
    } catch (err) {
      console.error("Failed to create file:", err);
      showNotification(`创建文件失败: ${err}`, "error");
    }
  }, [defaultFolders, openTabInPane, pane, showNotification]);

  return (
    <div
      className={`flex items-center h-10 bg-secondary border-b border-border select-none relative z-10 cursor-default transition-colors ${
        isSplit ? (isFocused ? "border-b-2 border-b-accent" : "opacity-80") : ""
      }`}
      onDoubleClick={handleDoubleClick}
      onMouseDown={() => isSplit && setFocusedPane(pane)}
    >
      {/* Tabs */}
      <div className="flex items-center flex-1 overflow-x-auto h-full relative" onDoubleClick={handleDoubleClick}>
        <div className="flex items-center h-full" onDoubleClick={handleDoubleClick}>
          {paneTabs.map((tab) => (
            <div
              key={tab.id}
              className={`group relative flex items-center gap-1.5 px-3 h-full text-sm cursor-pointer transition-all duration-150 min-w-0 shrink-0 select-none ${
                tab.id === paneActiveTabId
                  ? "bg-primary text-text-primary"
                  : "bg-secondary text-text-muted hover:text-text-secondary hover:bg-surface/50"
              }`}
              onClick={() => setActive(tab.id)}
              onDoubleClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => handleContextMenu(e, tab.id)}
              onMouseEnter={() => setHoveredPath(tab.path)}
              onMouseLeave={() => setHoveredPath(null)}
            >
              {tab.id === paneActiveTabId && (
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
                onClick={(e) => handleClose(e, tab)}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Split controls */}
      <div className="flex items-center gap-1 px-2 shrink-0">
        {!isSplit && pane === "primary" && (
          <button
            className="p-1.5 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer"
            onClick={() => toggleSplit()}
            title="分屏显示"
          >
            <SplitSquareHorizontal size={16} />
          </button>
        )}
        {isSplit && pane === "secondary" && (
          <button
            className="p-1.5 rounded hover:bg-surface text-text-muted hover:text-error transition-colors cursor-pointer"
            onClick={() => setSplit(false)}
            title="关闭分屏"
          >
            <X size={16} />
          </button>
        )}
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
