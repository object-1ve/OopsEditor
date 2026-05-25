import { useEffect, useCallback, useRef, useState } from "react";
import { Terminal, PanelRightClose, Plus, X, UploadCloud } from "lucide-react";
import Sidebar from "./components/Sidebar";
import RightSidebar from "./components/RightSidebar";
import TitleBar from "./components/TitleBar";
import Toolbar from "./components/Toolbar";
import Editor from "./components/Editor";
import TerminalView from "./components/Terminal";
import Toast from "./components/Toast";
import ConfirmModal from "./components/ConfirmModal";
import { useEditorStore } from "./store/editor";
import { detectLanguage } from "./types";
import { saveSetting, loadSettings } from "./utils/settings";
import { monacoReady } from "./monaco";

const DEFAULT_WINDOW_SIZE = { width: 1200, height: 800 };
const DEFAULT_WINDOW_POSITION = { x: 100, y: 100 };
const MIN_RESTORABLE_WINDOW_SIZE = { width: 800, height: 600 };
const MAX_ABSOLUTE_WINDOW_POSITION = 10000;

function isValidRestoredWindowSize(
  size: { width: number; height: number } | undefined,
): size is { width: number; height: number } {
  return Boolean(
    size &&
      Number.isFinite(size.width) &&
      Number.isFinite(size.height) &&
      size.width >= MIN_RESTORABLE_WINDOW_SIZE.width &&
      size.height >= MIN_RESTORABLE_WINDOW_SIZE.height,
  );
}

function isValidRestoredWindowPosition(
  position: { x: number; y: number } | undefined,
): position is { x: number; y: number } {
  return Boolean(
    position &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.y) &&
      Math.abs(position.x) <= MAX_ABSOLUTE_WINDOW_POSITION &&
      Math.abs(position.y) <= MAX_ABSOLUTE_WINDOW_POSITION,
  );
}

function App() {
  const { 
    isLeftSidebarCollapsed, 
    isRightSidebarCollapsed, 
    isTerminalVisible,
    terminalHeight,
    toggleTerminal,
    setTerminalHeight,
    terminals,
    activeTerminalId,
    setActiveTerminal,
    addTerminal,
    removeTerminal,
    init
  } = useEditorStore();

  const [isDragging, setIsDragging] = useState(false);
  const [isAppReady, setIsAppReady] = useState(false);
  const isResizingTerminal = useRef(false);

  const handleTerminalMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizingTerminal.current) return;
    
    // 终端在底部，高度 = 窗口高度 - 鼠标点击位置的 Y 坐标
    // 需要减去状态栏的高度 (24px)
    const newHeight = window.innerHeight - e.clientY - 24;
    
    if (newHeight > 100 && newHeight < window.innerHeight * 0.7) {
      setTerminalHeight(newHeight);
    }
  }, [setTerminalHeight]);

  const stopResizingTerminal = useCallback(() => {
    isResizingTerminal.current = false;
    document.removeEventListener("mousemove", handleTerminalMouseMove);
    document.removeEventListener("mouseup", stopResizingTerminal);
    document.body.style.cursor = "default";
  }, [handleTerminalMouseMove]);

  const startResizingTerminal = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingTerminal.current = true;
    document.addEventListener("mousemove", handleTerminalMouseMove);
    document.addEventListener("mouseup", stopResizingTerminal);
    document.body.style.cursor = "row-resize";
  }, [handleTerminalMouseMove, stopResizingTerminal]);

  const handleOpenTerminal = async () => {
    const { tabs, activeTabId, rootPaths, addTerminal, toggleTerminal, isTerminalVisible, terminals } = useEditorStore.getState();
    
    // 如果终端未显示，则尝试在当前目录打开
    if (!isTerminalVisible) {
      if (terminals.length === 0) {
        let targetPath = rootPaths[0] || null;
        
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
        addTerminal(targetPath);
      } else {
        toggleTerminal();
      }
    } else {
      toggleTerminal();
    }
  };

  useEffect(() => {
    let unlistenResize: (() => void) | undefined;
    let unlistenMoved: (() => void) | undefined;
    let unlistenDrop: (() => void) | undefined;

    async function setupApp() {
      // 设置一个安全超时，防止初始化挂起导致窗口永远不显示
      const timeoutId = setTimeout(async () => {
        if (!isAppReady) {
          console.warn("App initialization timeout, forcing window show");
          try {
            const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
            const appWindow = getCurrentWebviewWindow();
            setIsAppReady(true);
            await appWindow.show();
            await appWindow.setFocus();
          } catch (e) {
            console.error("Failed to show window on timeout:", e);
          }
        }
      }, 5000); // 5秒超时

      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const { LogicalSize, LogicalPosition } = await import("@tauri-apps/api/dpi");
        const appWindow = getCurrentWebviewWindow();

        // 1. 等待核心状态和 Monaco 都准备完成后再显示主界面，避免半加载闪烁。
        await Promise.all([init(), monacoReady]);

        // 2. 加载并应用窗口配置
        const settings = await loadSettings();
        const restoredWindowSize = settings.windowSize;
        if (isValidRestoredWindowSize(restoredWindowSize)) {
          await appWindow.setSize(new LogicalSize(restoredWindowSize.width, restoredWindowSize.height));
        } else if (restoredWindowSize) {
          await appWindow.setSize(new LogicalSize(DEFAULT_WINDOW_SIZE.width, DEFAULT_WINDOW_SIZE.height));
          await saveSetting("windowSize", DEFAULT_WINDOW_SIZE);
        }
        const restoredWindowPosition = settings.windowPosition;
        if (isValidRestoredWindowPosition(restoredWindowPosition)) {
          await appWindow.setPosition(new LogicalPosition(restoredWindowPosition.x, restoredWindowPosition.y));
        } else if (restoredWindowPosition) {
          await appWindow.setPosition(new LogicalPosition(DEFAULT_WINDOW_POSITION.x, DEFAULT_WINDOW_POSITION.y));
          await saveSetting("windowPosition", DEFAULT_WINDOW_POSITION);
        }

        // 3. 监听窗口变化并保存
        unlistenResize = await appWindow.onResized(async () => {
          const size = await appWindow.innerSize();
          const factor = await appWindow.scaleFactor();
          const logicalSize = size.toLogical(factor);
          await saveSetting('windowSize', { width: logicalSize.width, height: logicalSize.height });
        });

        unlistenMoved = await appWindow.onMoved(async () => {
          const pos = await appWindow.innerPosition();
          const factor = await appWindow.scaleFactor();
          const logicalPos = pos.toLogical(factor);
          await saveSetting('windowPosition', { x: logicalPos.x, y: logicalPos.y });
        });

        // 4. 监听文件拖拽
        unlistenDrop = await appWindow.onDragDropEvent((event) => {
          if (event.payload.type === "enter") {
            setIsDragging(true);
          } else if (event.payload.type === "drop") {
            setIsDragging(false);
            const paths = event.payload.paths;
            for (const path of paths) {
              handleDroppedPath(path);
            }
          } else {
            setIsDragging(false);
          }
        });

        // 5. 准备就绪，显示窗口
        // 在所有位置和大小调整完成后再显示，避免视觉上的闪烁或跳变
        clearTimeout(timeoutId);
        setIsAppReady(true);
        await appWindow.show();
        await appWindow.setFocus();
      } catch (e) {
        clearTimeout(timeoutId);
        console.error("Tauri API Error:", e);
        // 出错时也尝试显示窗口，避免应用永远隐藏
        try {
          const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
          const appWindow = getCurrentWebviewWindow();
          setIsAppReady(true);
          await appWindow.show();
        } catch (innerE) {
          console.error("Failed to show window in error handler:", innerE);
        }
      }
    }

    setupApp();

    return () => {
      if (unlistenResize) unlistenResize();
      if (unlistenMoved) unlistenMoved();
      if (unlistenDrop) unlistenDrop();
    };
  }, []);

  if (!isAppReady) {
    return (
      <div className="h-screen w-screen flex items-center justify-center overflow-hidden bg-deepest">
        <div className="text-center space-y-6 relative select-none">
          <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-72 h-72 rounded-full bg-accent-glow blur-3xl pointer-events-none" />
          <div className="relative w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-accent to-accent-bright flex items-center justify-center shadow-lg shadow-accent/20">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <rect x="6" y="7" width="20" height="18" rx="3" stroke="white" strokeWidth="1.5" fill="none" />
              <path d="M10 13h12M10 17h8M10 21h6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight shimmer-text">Oops Editor</h1>
            <p className="text-text-secondary">正在完整加载工作区...</p>
          </div>
          <div className="inline-flex items-center gap-3 px-4 py-2 rounded-full border border-border bg-surface/60 text-xs text-text-muted">
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            初始化编辑器与窗口状态
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden relative border border-border rounded-lg shadow-2xl bg-deepest">
      {/* Top Title Bar */}
      <TitleBar />

      {/* Main Layout Area: Sidebars and Content */}
      <div className={`flex-1 flex overflow-hidden transition-transform duration-300 ${isDragging ? 'scale-[0.98] opacity-50 blur-[2px]' : 'scale-100 opacity-100 blur-0'}`}>
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
                {/* Resize Handle */}
                <div
                  onMouseDown={startResizingTerminal}
                  className="absolute -top-1 left-0 right-0 h-2 cursor-row-resize z-50 hover:bg-accent/30 active:bg-accent/50 transition-colors"
                />
                
                {/* Terminal Header/Handle */}
                <div className="h-8 bg-surface border-b border-border flex items-center justify-between shrink-0 select-none">
                  <div className="flex items-center flex-1 overflow-x-auto h-full scrollbar-hide">
                    <div className="flex items-center h-full px-1 gap-0.5">
                      {terminals.map((t) => (
                        <div
                          key={t.id}
                          onClick={() => setActiveTerminal(t.id)}
                          className={`group relative flex items-center gap-1.5 px-3 h-7 text-[11px] cursor-pointer transition-all duration-150 rounded-t-md min-w-0 shrink-0 ${
                            t.id === activeTerminalId
                              ? "bg-primary text-text-primary"
                              : "text-text-muted hover:text-text-secondary hover:bg-white/5"
                          }`}
                        >
                          {t.id === activeTerminalId && (
                            <div className="absolute top-0 left-0 right-0 h-[2px] bg-accent rounded-full" />
                          )}
                          <Terminal size={10} className={`${t.id === activeTerminalId ? "text-accent" : "opacity-60"}`} />
                          <span className="truncate max-w-24 font-medium uppercase tracking-wider">{t.name}</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              removeTerminal(t.id);
                            }}
                            className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-surface transition-all shrink-0 text-text-muted hover:text-text"
                          >
                            <X size={10} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                  
                  <div className="flex items-center px-1 gap-1">
                    <button 
                      onClick={() => addTerminal()}
                      className="p-1.5 hover:bg-white/5 rounded transition-colors text-text-muted hover:text-accent cursor-pointer"
                      title="新建终端"
                    >
                      <Plus size={14} />
                    </button>
                    <button 
                      onClick={toggleTerminal}
                      className="p-1.5 hover:bg-white/5 rounded transition-colors text-text-muted hover:text-text cursor-pointer"
                      title="关闭面板"
                    >
                      <PanelRightClose size={14} className="rotate-90" />
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-hidden relative">
                  {terminals.map((t) => (
                    <TerminalView 
                      key={t.id}
                      id={t.id}
                      path={t.path}
                      isVisible={t.id === activeTerminalId}
                    />
                  ))}
                </div>
               </div>
            )}
          </div>

          {/* Status bar */}
          <div className="h-6 bg-deepest border-t border-border flex items-center px-1 text-xs text-text-muted gap-2 relative z-10">
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
          </div>
        </div>

        {/* Right Sidebar */}
        {!isRightSidebarCollapsed && <RightSidebar />}
      </div>

      {/* Drag and Drop Overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-[100] bg-accent/5 backdrop-blur-[2px] flex flex-col items-center justify-center pointer-events-none animate-in fade-in duration-300">
          <div className="relative flex flex-col items-center justify-center p-12 rounded-3xl border-2 border-dashed border-accent bg-deepest/90 shadow-[0_0_50px_rgba(var(--accent-rgb),0.2)] animate-in zoom-in duration-300">
            {/* Pulsing rings */}
            <div className="absolute inset-0 rounded-3xl border-2 border-accent/30 animate-ping pointer-events-none" />
            <div className="absolute -inset-4 rounded-[40px] border border-accent/10 animate-pulse pointer-events-none" />
            
            <div className="w-24 h-24 rounded-2xl bg-accent/10 flex items-center justify-center text-accent mb-6 shadow-inner relative overflow-hidden group">
              <div className="absolute inset-0 bg-gradient-to-tr from-accent/20 to-transparent opacity-50" />
              <UploadCloud size={48} className="relative z-10 animate-bounce" />
            </div>
            
            <h2 className="text-2xl font-bold text-text mb-3 tracking-tight">
              释放以导入资源
            </h2>
            <div className="flex items-center gap-3">
              <span className="px-2 py-1 rounded bg-surface border border-border text-[10px] text-text-secondary font-mono uppercase tracking-widest">
                Files
              </span>
              <div className="w-1 h-1 rounded-full bg-text-muted" />
              <span className="px-2 py-1 rounded bg-surface border border-border text-[10px] text-text-secondary font-mono uppercase tracking-widest">
                Folders
              </span>
            </div>
            
            <div className="mt-8 flex items-center gap-2 text-text-muted text-xs bg-surface/50 px-4 py-2 rounded-full border border-border/50">
              <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
              Oops Editor 准备就绪
            </div>
          </div>
        </div>
      )}

      <ConfirmModal />
      <Toast />
    </div>
  );
}

async function handleDroppedPath(path: string) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const isDir = await invoke<boolean>("is_directory", { path });
    
    if (isDir) {
      useEditorStore.getState().addRootPath(path);
      useEditorStore.getState().showNotification(`已添加文件夹: ${path.split(/[/\\]/).pop()}`, "success");
    } else {
      await openDroppedFile(path);
    }
  } catch (err) {
    console.error("Failed to handle dropped path:", err);
  }
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
