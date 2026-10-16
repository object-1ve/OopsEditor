import { useEffect, useState } from "react";
import { Pin, PinOff, Minus, Square, Copy, X, Search } from "lucide-react";
import { useEditorStore } from "@/store/editor";

export default function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  const tabs = useEditorStore(s => s.tabs);
  const showModal = useEditorStore(s => s.showModal);
  const isLeftSidebarCollapsed = useEditorStore(s => s.isLeftSidebarCollapsed);
  const toggleLeftSidebar = useEditorStore(s => s.toggleLeftSidebar);
  const openSearch = useEditorStore(s => s.openSearch);

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

  /** 打开搜索面板：面板挂在左侧边栏里，侧边栏收起时先展开，否则点了看不到 */
  const handleOpenSearch = () => {
    if (isLeftSidebarCollapsed) {
      toggleLeftSidebar();
    }
    openSearch();
  };

  const handleToggleAlwaysOnTop = async () => {
    try {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const appWindow = getCurrentWebviewWindow();
      const next = !isAlwaysOnTop;
      await appWindow.setAlwaysOnTop(next);
      setIsAlwaysOnTop(next);
    } catch (e) {
      console.error(e);
    }
  };

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

      <button
        onClick={handleOpenSearch}
        className="p-1.5 rounded hover:bg-surface transition-colors cursor-pointer text-text-muted hover:text-accent"
        title="搜索文件内容 / 会话消息"
      >
        <Search size={14} />
      </button>

      <button
        onClick={handleToggleAlwaysOnTop}
        className={`p-1.5 rounded hover:bg-surface transition-colors cursor-pointer ${
          isAlwaysOnTop ? "text-accent bg-surface" : "text-text-muted hover:text-accent"
        }`}
        title={isAlwaysOnTop ? "取消置顶" : "窗口置顶"}
      >
        {isAlwaysOnTop ? <Pin size={14} /> : <PinOff size={14} />}
      </button>

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
