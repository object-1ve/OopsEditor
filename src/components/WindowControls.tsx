import { useEffect, useState } from "react";
import { Minus, Square, Copy, X, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Settings } from "lucide-react";
import { useEditorStore } from "../store/editor";

export default function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
  const { 
    isLeftSidebarCollapsed, 
    isRightSidebarCollapsed, 
    toggleLeftSidebar, 
    toggleRightSidebar,
    openSettings,
    tabs,
    showModal,
  } = useEditorStore();

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    async function setupListener() {
      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const appWindow = getCurrentWebviewWindow();

        // Initial state
        setIsMaximized(await appWindow.isMaximized());

        const unlistenRes = await appWindow.onResized(async () => {
          setIsMaximized(await appWindow.isMaximized());
        });
        unlisten = unlistenRes;
      } catch (e) {
        console.error("Failed to setup window listener", e);
      }
    }

    setupListener();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleMinimize = async () => {
    try {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      await getCurrentWebviewWindow().minimize();
    } catch (e) {
      console.error(e);
    }
  };

  const handleMaximize = async () => {
    try {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const appWindow = getCurrentWebviewWindow();
      await appWindow.toggleMaximize();
    } catch (e) {
      console.error(e);
    }
  };

  const handleClose = async () => {
    const dirtyTabs = tabs.filter(tab => tab.isDirty);
    
    if (dirtyTabs.length > 0) {
      showModal({
        title: "是否保存窗口",
        message: `有 ${dirtyTabs.length} 个文件尚未保存，关闭将丢失所有更改。确定要关闭吗？`,
        kind: "warning",
        onConfirm: async () => {
          try {
            const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
            await getCurrentWebviewWindow().hide();
          } catch (e) {
            console.error(e);
          }
        },
      });
      return;
    }

    try {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      await getCurrentWebviewWindow().hide();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="flex items-center h-full no-drag" onDoubleClick={(e) => e.stopPropagation()}>
      <div className="flex items-center mr-2 border-r border-border pr-2 gap-1">
        <button
          onClick={openSettings}
          className="p-1.5 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer"
          title="设置"
        >
          <Settings size={14} />
        </button>
        <button
          onClick={toggleLeftSidebar}
          className="p-1.5 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer"
          title={isLeftSidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          {isLeftSidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        </button>
        <button
          onClick={toggleRightSidebar}
          className="p-1.5 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer"
          title={isRightSidebarCollapsed ? "展开右边栏" : "收起右边栏"}
        >
          {isRightSidebarCollapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
        </button>
      </div>

      <button
        onClick={handleMinimize}
        className="h-full px-4 flex items-center justify-center text-text-muted hover:bg-surface transition-colors"
        title="最小化"
      >
        <Minus size={14} />
      </button>
      <button
        onClick={handleMaximize}
        className="h-full px-4 flex items-center justify-center text-text-muted hover:bg-surface transition-colors"
        title={isMaximized ? "还原" : "最大化"}
      >
        {isMaximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        onClick={handleClose}
        className="h-full px-4 flex items-center justify-center text-text-muted hover:bg-red-500/20 hover:text-red-500 transition-colors"
        title="关闭"
      >
        <X size={14} />
      </button>
    </div>
  );
}
