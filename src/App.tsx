import { useEffect } from "react";
import { Terminal, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import Sidebar from "./components/Sidebar";
import RightSidebar from "./components/RightSidebar";
import TitleBar from "./components/TitleBar";
import Toolbar from "./components/Toolbar";
import Editor from "./components/Editor";
import TerminalView from "./components/Terminal";
import Toast from "./components/Toast";
import { useEditorStore } from "./store/editor";
import { detectLanguage } from "./types";
import { saveSetting, loadSettings } from "./utils/settings";

function App() {
  const { 
    isLeftSidebarCollapsed, 
    isRightSidebarCollapsed, 
    isTerminalVisible,
    terminalHeight,
    toggleLeftSidebar, 
    toggleRightSidebar,
    toggleTerminal,
    setTerminalHeight,
    init
  } = useEditorStore();

  const handleOpenTerminal = async () => {
    const { tabs, activeTabId, rootPath, setTerminalPath, toggleTerminal, isTerminalVisible } = useEditorStore.getState();
    
    // 如果终端未显示，则根据当前文件设置路径
    if (!isTerminalVisible) {
      let targetPath = rootPath;
      
      if (activeTabId) {
        const activeTab = tabs.find(t => t.id === activeTabId);
        if (activeTab && activeTab.path) {
          const path = activeTab.path;
          const lastSeparator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
          if (lastSeparator !== -1) {
            targetPath = path.substring(0, lastSeparator);
          }
        }
      }
      
      setTerminalPath(targetPath);
    }
    
    toggleTerminal();
  };

  useEffect(() => {
    async function setupApp() {
      // 1. 初始化 Store 并加载侧边栏配置
      await init();

      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const { LogicalSize, LogicalPosition } = await import("@tauri-apps/api/dpi");
        const appWindow = getCurrentWebviewWindow();

        // 2. 加载并应用窗口配置
        const settings = await loadSettings();
        if (settings.windowSize) {
          await appWindow.setSize(new LogicalSize(settings.windowSize.width, settings.windowSize.height));
        }
        if (settings.windowPosition) {
          await appWindow.setPosition(new LogicalPosition(settings.windowPosition.x, settings.windowPosition.y));
        }

        // 3. 监听窗口变化并保存
        const unlistenResize = await appWindow.onResized(async () => {
          const size = await appWindow.innerSize();
          const factor = await appWindow.scaleFactor();
          const logicalSize = size.toLogical(factor);
          await saveSetting('windowSize', { width: logicalSize.width, height: logicalSize.height });
        });

        const unlistenMoved = await appWindow.onMoved(async () => {
          const pos = await appWindow.innerPosition();
          const factor = await appWindow.scaleFactor();
          const logicalPos = pos.toLogical(factor);
          await saveSetting('windowPosition', { x: logicalPos.x, y: logicalPos.y });
        });

        // 4. 监听文件拖拽
        const unlistenDrop = await appWindow.onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            const paths = event.payload.paths;
            for (const path of paths) {
              openDroppedFile(path);
            }
          }
        });

        return () => {
          unlistenResize();
          unlistenMoved();
          unlistenDrop();
        };
      } catch (e) {
        console.error("Tauri API Error:", e);
      }
    }
    setupApp();
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden relative border border-border rounded-lg shadow-2xl bg-deepest">
      {/* Top Title Bar */}
      <TitleBar />

      {/* Main Layout Area: Sidebars and Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        {!isLeftSidebarCollapsed && <Sidebar />}

        {/* Center Main Area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <Toolbar />
          <div className="flex-1 overflow-hidden relative z-0 flex flex-col">
            <div className="flex-1 overflow-hidden relative">
              <Editor />
            </div>
            
            {/* Integrated Terminal */}
            {isTerminalVisible && (
              <div 
                style={{ height: terminalHeight }}
                className="border-t border-border bg-deepest flex flex-col relative"
              >
                {/* Terminal Header/Handle */}
                <div className="h-7 bg-surface border-b border-border flex items-center px-2 justify-between shrink-0">
                  <div className="flex items-center gap-2">
                    <Terminal size={12} className="text-accent" />
                    <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">终端</span>
                  </div>
                  <button 
                    onClick={toggleTerminal}
                    className="p-1 hover:bg-white/5 rounded transition-colors text-text-muted hover:text-text cursor-pointer"
                  >
                    <PanelRightClose size={12} className="rotate-90" />
                  </button>
                </div>
                 <div className="flex-1 overflow-hidden">
                   <TerminalView />
                 </div>
               </div>
            )}
          </div>

          {/* Status bar */}
          <div className="h-6 bg-deepest border-t border-border flex items-center px-1 text-xs text-text-muted gap-2 relative z-10">
            <button
              onClick={toggleLeftSidebar}
              className="p-1 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer"
              title={isLeftSidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            >
              {isLeftSidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
            </button>

            <button
              onClick={handleOpenTerminal}
              className="p-1 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer"
              title="在当前目录打开终端"
            >
              <Terminal size={14} />
            </button>
            
            <span className="text-border mx-1">|</span>

            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-accent/60 status-dot" />
              <span>就绪</span>
            </div>
            <span className="text-border">|</span>
            <span>Oops Editor</span>
            <div className="flex-1" />
            <span className="hidden sm:inline text-text-muted/60">拖拽文件到窗口打开</span>

            <span className="text-border mx-1">|</span>

            <button
              onClick={toggleRightSidebar}
              className="p-1 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer"
              title={isRightSidebarCollapsed ? "展开右边栏" : "收起右边栏"}
            >
              {isRightSidebarCollapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
            </button>
          </div>
        </div>

        {/* Right Sidebar */}
        {!isRightSidebarCollapsed && <RightSidebar />}
      </div>

      <Toast />
    </div>
  );
}

async function openDroppedFile(path: string) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const name = path.split(/[/\\]/).pop() ?? path;
    const language = detectLanguage(name);
    let content = "";

    if (language !== "image") {
      content = await invoke<string>("read_file", { path });
    }

    useEditorStore.getState().openTab({
      id: path,
      name,
      path,
      language,
      content,
      isDirty: false,
    });
  } catch (err) {
    useEditorStore.getState().showNotification(`无法打开文件: ${path.split(/[/\\]/).pop()} (可能是不支持的二进制格式)`, "error");
  }
}

export default App;
