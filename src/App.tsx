import { useEffect, useCallback, useRef, useState, useMemo } from "react";
import { Terminal, PanelRightClose, Plus, X, UploadCloud, ChevronsUp, Minimize2, ChevronLeft, ChevronRight, CopyX, FileText, Image, Link, ListChecks } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import Sidebar from "./components/Sidebar";
import RightSidebar from "./components/RightSidebar";
import TitleBar from "./components/TitleBar";
import Toolbar from "./components/Toolbar";
import Editor from "./components/Editor";
import TerminalView from "./components/Terminal";
import Toast from "./components/Toast";
import ConfirmModal from "./components/ConfirmModal";
import SettingsModal from "./components/SettingsModal";
import ContextMenu from "./components/ContextMenu";
import UpgradePanel from "./components/UpgradePanel";
import { useEditorStore } from "./store/editor";
import { detectLanguage, isPreviewOnlyLanguage } from "./types";
import { saveSetting, loadSettings } from "./utils/settings";
import { monacoReady } from "./monaco";
import { dispatchFileDrop, isMarkdownEditable } from "./utils/editorInsert";

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
    closeOtherTerminals,
    closeTerminalsToLeft,
    closeTerminalsToRight,
    init,
    hoveredPath,
    isSplit,
    splitRatio,
    setSplitRatio,
    setFocusedPane,
    focusedPane,
    secondaryActiveTabId,
    tabs,
    activeTabId,
    secondaryTabs,
  } = useEditorStore();

  const [isDragging, setIsDragging] = useState(false);
  const [isDraggingOverTerminal, setIsDraggingOverTerminal] = useState(false);
  const [isDraggingOverEditor, setIsDraggingOverEditor] = useState(false);
  const [isAppReady, setIsAppReady] = useState(false);
  const [isTerminalExpanded, setIsTerminalExpanded] = useState(false);
  const [terminalContextMenu, setTerminalContextMenu] = useState<{ x: number; y: number; terminalId: string } | null>(null);
  const [showUpgradePanel, setShowUpgradePanel] = useState(false);
  const isResizingTerminal = useRef(false);
  const editorWorkspaceRef = useRef<HTMLDivElement>(null);
  const terminalDropZoneRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const isDraggingOverTerminalRef = useRef(false);
  const isDraggingOverEditorRef = useRef(false);
  const lastRestorableTerminalHeightRef = useRef(terminalHeight);
  const dragStartTerminalHeightRef = useRef(terminalHeight);
  const isResizingSplit = useRef(false);
  const splitWorkspaceRef = useRef<HTMLDivElement>(null);

  const setTerminalDragState = useCallback((value: boolean) => {
    isDraggingOverTerminalRef.current = value;
    setIsDraggingOverTerminal(value);
  }, []);

  const setEditorDragState = useCallback((value: boolean) => {
    isDraggingOverEditorRef.current = value;
    setIsDraggingOverEditor(value);
  }, []);

  const getMaxTerminalHeight = useCallback(() => {
    return editorWorkspaceRef.current?.getBoundingClientRect().height ?? terminalHeight;
  }, [terminalHeight]);

  const handleTerminalMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizingTerminal.current) return;

    const workspaceRect = editorWorkspaceRef.current?.getBoundingClientRect();
    if (!workspaceRect) return;

    // 基于编辑区容器的实际底边计算终端高度，支持向上拖满整个编辑区域。
    const newHeight = workspaceRect.bottom - e.clientY;
    const maxHeight = workspaceRect.height;
    const clampedHeight = Math.max(100, Math.min(newHeight, maxHeight));

    // 拖拽接近顶部时自动切换到最大化态，和按钮行为保持一致。
    if (clampedHeight >= maxHeight - 8) {
      lastRestorableTerminalHeightRef.current = dragStartTerminalHeightRef.current;
      setTerminalHeight(maxHeight);
      setIsTerminalExpanded(true);
      return;
    }

    if (isTerminalExpanded) {
      setIsTerminalExpanded(false);
    }
    setTerminalHeight(clampedHeight);
  }, [isTerminalExpanded, setTerminalHeight]);

  const stopResizingTerminal = useCallback(() => {
    isResizingTerminal.current = false;
    document.removeEventListener("mousemove", handleTerminalMouseMove);
    document.removeEventListener("mouseup", stopResizingTerminal);
    document.body.style.cursor = "default";
  }, [handleTerminalMouseMove]);

  const startResizingTerminal = useCallback((e: React.MouseEvent) => {
    if (isTerminalExpanded) return;
    e.preventDefault();
    dragStartTerminalHeightRef.current = terminalHeight;
    isResizingTerminal.current = true;
    document.addEventListener("mousemove", handleTerminalMouseMove);
    document.addEventListener("mouseup", stopResizingTerminal);
    document.body.style.cursor = "row-resize";
  }, [handleTerminalMouseMove, isTerminalExpanded, stopResizingTerminal, terminalHeight]);

  const handleSplitMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizingSplit.current || !splitWorkspaceRef.current) return;
    const rect = splitWorkspaceRef.current.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    setSplitRatio(ratio);
  }, [setSplitRatio]);

  const stopResizingSplit = useCallback(() => {
    isResizingSplit.current = false;
    document.removeEventListener("mousemove", handleSplitMouseMove);
    document.removeEventListener("mouseup", stopResizingSplit);
    document.body.style.cursor = "default";
  }, [handleSplitMouseMove]);

  const startResizingSplit = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingSplit.current = true;
    document.addEventListener("mousemove", handleSplitMouseMove);
    document.addEventListener("mouseup", stopResizingSplit);
    document.body.style.cursor = "col-resize";
  }, [handleSplitMouseMove, stopResizingSplit]);

  const toggleTerminalExpanded = useCallback(() => {
    if (isTerminalExpanded) {
      const restoredHeight = Math.max(100, Math.min(lastRestorableTerminalHeightRef.current, getMaxTerminalHeight()));
      setIsTerminalExpanded(false);
      setTerminalHeight(restoredHeight);
      return;
    }

    lastRestorableTerminalHeightRef.current = terminalHeight;
    setTerminalHeight(getMaxTerminalHeight());
    setIsTerminalExpanded(true);
  }, [getMaxTerminalHeight, isTerminalExpanded, setTerminalHeight, terminalHeight]);

  const handleTerminalContextMenu = useCallback((e: React.MouseEvent, terminalId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveTerminal(terminalId);
    setTerminalContextMenu({ x: e.clientX, y: e.clientY, terminalId });
  }, [setActiveTerminal]);

  const handleCloseTerminal = useCallback((e: React.MouseEvent | { stopPropagation: () => void }, terminalId: string) => {
    e.stopPropagation();
    removeTerminal(terminalId);
    setTerminalContextMenu(null);
  }, [removeTerminal]);

  const handleCloseOtherTerminalTabs = useCallback(() => {
    if (!terminalContextMenu) return;
    closeOtherTerminals(terminalContextMenu.terminalId);
    setTerminalContextMenu(null);
  }, [closeOtherTerminals, terminalContextMenu]);

  const handleCloseTerminalTabsToLeft = useCallback(() => {
    if (!terminalContextMenu) return;
    closeTerminalsToLeft(terminalContextMenu.terminalId);
    setTerminalContextMenu(null);
  }, [closeTerminalsToLeft, terminalContextMenu]);

  const handleCloseTerminalTabsToRight = useCallback(() => {
    if (!terminalContextMenu) return;
    closeTerminalsToRight(terminalContextMenu.terminalId);
    setTerminalContextMenu(null);
  }, [closeTerminalsToRight, terminalContextMenu]);

  const terminalContextMenuItems = useMemo(() => {
    if (!terminalContextMenu) return [];
    const terminal = terminals.find((item) => item.id === terminalContextMenu.terminalId);
    if (!terminal) return [];

    return [
      {
        label: "关闭终端",
        icon: <X size={14} />,
        onClick: () => handleCloseTerminal({ stopPropagation: () => {} } as React.MouseEvent, terminal.id),
      },
      { separator: true, label: "", onClick: () => {} },
      {
        label: "关闭其他终端",
        icon: <CopyX size={14} />,
        onClick: handleCloseOtherTerminalTabs,
      },
      {
        label: "关闭左侧终端",
        icon: <ChevronLeft size={14} />,
        onClick: handleCloseTerminalTabsToLeft,
      },
      {
        label: "关闭右侧终端",
        icon: <ChevronRight size={14} />,
        onClick: handleCloseTerminalTabsToRight,
      },
    ];
  }, [
    handleCloseOtherTerminalTabs,
    handleCloseTerminal,
    handleCloseTerminalTabsToLeft,
    handleCloseTerminalTabsToRight,
    terminalContextMenu,
    terminals,
  ]);

  const handleTerminalTabBarDoubleClick = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    addTerminal();
  }, [addTerminal]);

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

  const isPointInsideTerminal = useCallback((position?: { x: number; y: number }) => {
    if (!position || !terminalDropZoneRef.current) return false;
    const { isTerminalVisible, activeTerminalId } = useEditorStore.getState();
    if (!isTerminalVisible || !activeTerminalId) return false;

    const factor = window.devicePixelRatio || 1;
    const logicalX = position.x / factor;
    const logicalY = position.y / factor;

    const rect = terminalDropZoneRef.current.getBoundingClientRect();
    return (
      logicalX >= rect.left &&
      logicalX <= rect.right &&
      logicalY >= rect.top &&
      logicalY <= rect.bottom
    );
  }, []);

  const isPointInsideEditor = useCallback((position?: { x: number; y: number }) => {
    if (!position) return false;
    // 分屏时用分屏工作区判定，单屏时用 editorRef
    const target = isSplit ? splitWorkspaceRef.current : editorRef.current;
    if (!target) return false;

    const factor = window.devicePixelRatio || 1;
    const logicalX = position.x / factor;
    const logicalY = position.y / factor;

    const rect = target.getBoundingClientRect();
    return (
      logicalX >= rect.left &&
      logicalX <= rect.right &&
      logicalY >= rect.top &&
      logicalY <= rect.bottom
    );
  }, [isSplit]);

  const insertPathsIntoTerminal = useCallback(async (paths: string[]) => {
    const { activeTerminalId, showNotification } = useEditorStore.getState();
    if (!activeTerminalId || paths.length === 0) return false;

    try {
      const serializedPaths = paths.map(quotePathForPowerShell).join(" ");
      await invoke("write_to_terminal", {
        id: activeTerminalId,
        data: `${serializedPaths} `,
      });
      showNotification(`已插入 ${paths.length} 个路径到终端`, "success");
      return true;
    } catch (err) {
      console.error("Failed to insert dropped paths into terminal:", err);
      showNotification("无法将路径写入终端", "error");
      return false;
    }
  }, []);

  useEffect(() => {
    let unlistenResize: (() => void) | undefined;
    let unlistenMoved: (() => void) | undefined;
    let unlistenDrop: (() => void) | undefined;
    let unlistenClose: (() => void) | undefined;
    let isMounted = true;

    async function setupApp() {
      // 设置一个安全超时，防止初始化挂起导致窗口永远不显示
      const timeoutId = setTimeout(async () => {
        if (!isAppReady && isMounted) {
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

        if (!isMounted) return;

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
            setTerminalDragState(false);
            setEditorDragState(false);
          } else if (event.payload.type === "over") {
            const overTerminal = isPointInsideTerminal(event.payload.position);
            const dropState = useEditorStore.getState();
            const focusedTabId = dropState.isSplit && dropState.focusedPane === 'secondary'
              ? dropState.secondaryActiveTabId
              : dropState.activeTabId;
            // 合并主副窗口标签以判定焦点窗口的活动标签是否可编辑 markdown
            const allTabs = dropState.isSplit
              ? [...dropState.tabs, ...dropState.secondaryTabs]
              : dropState.tabs;
            const overEditor = !overTerminal && isPointInsideEditor(event.payload.position) && isMarkdownEditable(allTabs, focusedTabId);
            setTerminalDragState(overTerminal);
            setEditorDragState(overEditor);
          } else if (event.payload.type === "drop") {
            // 在 drop 时重新判定一次落点，确保准确性
            const droppedInTerminal = isPointInsideTerminal(event.payload.position);
            const dropState = useEditorStore.getState();
            const focusedTabId = dropState.isSplit && dropState.focusedPane === 'secondary'
              ? dropState.secondaryActiveTabId
              : dropState.activeTabId;
            const allTabs = dropState.isSplit
              ? [...dropState.tabs, ...dropState.secondaryTabs]
              : dropState.tabs;
            const droppedInEditor = !droppedInTerminal && isPointInsideEditor(event.payload.position) && isMarkdownEditable(allTabs, focusedTabId);
            
            setIsDragging(false);
            setTerminalDragState(false);
            setEditorDragState(false);
            
            const paths = event.payload.paths;
            if (droppedInTerminal) {
              void insertPathsIntoTerminal(paths);
              return;
            }

            // 如果活动 tab 是 Markdown 编辑模式，交由 Editor 组件处理
            if (droppedInEditor) {
              dispatchFileDrop(paths);
              return;
            }

            // 只有当既不在终端也不在可编辑的编辑器区域时，才执行打开文件的操作
            for (const path of paths) {
              void handleDroppedPath(path);
            }
          } else {
            setIsDragging(false);
            setTerminalDragState(false);
            setEditorDragState(false);
          }
        });

        unlistenClose = await appWindow.onCloseRequested(async (event) => {
          const state = useEditorStore.getState();
          const dirtyTabs = state.tabs.filter(tab => tab.isDirty);
          
          if (dirtyTabs.length > 0) {
            event.preventDefault();
            state.showModal({
              title: "是否保存窗口",
              message: `有 ${dirtyTabs.length} 个文件尚未保存，关闭将丢失所有更改。确定要退出吗？`,
              kind: "warning",
              onConfirm: () => {
                appWindow.destroy();
              }
            });
          }
        });

        // 5. 准备就绪，显示窗口
        clearTimeout(timeoutId);
        if (isMounted) {
          setIsAppReady(true);
          await appWindow.show();
          await appWindow.setFocus();
        }
      } catch (e) {
        clearTimeout(timeoutId);
        console.error("Tauri API Error:", e);
        if (isMounted) {
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
    }

    setupApp();

    return () => {
      isMounted = false;
      if (unlistenResize) unlistenResize();
      if (unlistenMoved) unlistenMoved();
      if (unlistenDrop) unlistenDrop();
      if (unlistenClose) unlistenClose();
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
      <div className={`flex-1 flex overflow-hidden transition-transform duration-300 ${isDragging && !isDraggingOverTerminal && !isDraggingOverEditor ? 'scale-[0.98] opacity-50 blur-[2px]' : 'scale-100 opacity-100 blur-0'}`}>
        {/* Left Sidebar */}
        {!isLeftSidebarCollapsed && <Sidebar />}

        {/* Center Main Area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div ref={editorWorkspaceRef} className="flex-1 overflow-hidden relative z-0 flex flex-col">
            {isSplit ? (
              <div ref={splitWorkspaceRef} className="flex-1 flex overflow-hidden">
                {/* Primary Pane */}
                <div className="flex flex-col overflow-hidden min-w-0" style={{ width: `${splitRatio * 100}%` }} onMouseDown={() => setFocusedPane('primary')}>
                  <Toolbar pane="primary" />
                  <div className="flex-1 overflow-hidden">
                    <Editor />
                  </div>
                </div>
                {/* Resize Handle */}
                <div
                  onMouseDown={startResizingSplit}
                  className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-accent/60 active:bg-accent transition-colors relative z-20"
                >
                  <div className="absolute inset-y-0 -left-1 -right-1" />
                </div>
                {/* Secondary Pane */}
                <div className="flex flex-col overflow-hidden min-w-0 flex-1" onMouseDown={() => setFocusedPane('secondary')}>
                  <Toolbar pane="secondary" />
                  <div className="flex-1 overflow-hidden">
                    <Editor tabId={secondaryActiveTabId} pane="secondary" />
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-hidden relative flex flex-col">
                <Toolbar />
                <div ref={editorRef} className="flex-1 overflow-hidden">
                  <Editor />
                </div>
              </div>
            )}

            {/* Integrated Terminal */}
            {isTerminalVisible && (
              <div
                ref={terminalDropZoneRef}
                style={isTerminalExpanded ? undefined : { height: terminalHeight }}
                className={`border-t border-border bg-deepest flex flex-col ${
                  isTerminalExpanded ? "absolute inset-0 z-20 shadow-2xl" : "relative"
                }`}
              >
                {/* Resize Handle */}
                {!isTerminalExpanded && (
                  <div
                    onMouseDown={startResizingTerminal}
                    className="absolute -top-1 left-0 right-0 h-2 cursor-row-resize z-50 hover:bg-accent/30 active:bg-accent/50 transition-colors"
                  />
                )}

                {/* Terminal Header/Handle */}
                <div className="h-8 bg-surface border-b border-border flex items-center justify-between shrink-0 select-none">
                  <div
                    className="flex items-center flex-1 overflow-x-auto h-full scrollbar-hide"
                    onDoubleClick={handleTerminalTabBarDoubleClick}
                  >
                    <div
                      className="flex items-center h-full px-1 gap-0.5"
                      onDoubleClick={handleTerminalTabBarDoubleClick}
                    >
                      {terminals.map((t) => (
                        <div
                          key={t.id}
                          onClick={() => setActiveTerminal(t.id)}
                          onDoubleClick={(e) => e.stopPropagation()}
                          onContextMenu={(e) => handleTerminalContextMenu(e, t.id)}
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
                              handleCloseTerminal(e, t.id);
                            }}
                            onDoubleClick={(e) => e.stopPropagation()}
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
                      onClick={toggleTerminalExpanded}
                      className="p-1.5 hover:bg-white/5 rounded transition-colors text-text-muted hover:text-accent cursor-pointer"
                      title={isTerminalExpanded ? "还原终端高度" : "向上伸展并覆盖编辑区"}
                    >
                      {isTerminalExpanded ? <Minimize2 size={14} /> : <ChevronsUp size={14} />}
                    </button>
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
                <div className={`flex-1 overflow-hidden relative ${isDraggingOverTerminal ? "ring-2 ring-inset ring-accent/70 bg-accent/5" : ""}`}>
                  {terminals.map((t) => (
                    <TerminalView
                      key={t.id}
                      id={t.id}
                      path={t.path}
                      isVisible={t.id === activeTerminalId}
                      isExpanded={isTerminalExpanded}
                    />
                  ))}
                  {isDraggingOverTerminal && (
                    <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center bg-deepest/70 backdrop-blur-sm">
                      <div className="px-4 py-2 rounded-lg border border-accent/60 bg-surface/90 text-sm text-text shadow-lg">
                        释放文件以将路径插入当前终端
                      </div>
                    </div>
                  )}
                </div>
                {terminalContextMenu && (
                  <ContextMenu
                    x={terminalContextMenu.x}
                    y={terminalContextMenu.y}
                    items={terminalContextMenuItems}
                    onClose={() => setTerminalContextMenu(null)}
                  />
                )}
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
            <button
              onClick={() => setShowUpgradePanel(true)}
              className="p-1 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer"
              title="升级日志"
            >
              <ListChecks size={14} />
            </button>

            <span className="text-border mx-1">|</span>

            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-accent/60 status-dot" />
              <span>就绪</span>
            </div>
            <span className="text-border">|</span>
            <span>Oops Editor</span>
            <div className="flex-1 flex items-center px-4 overflow-hidden">
              {(() => {
                // Show hovered path first (from tab hover or sidebar hover)
                // Otherwise show active tab path based on focused pane
                let displayPath = hoveredPath ?? null;

                if (!displayPath) {
                  let activeTab = null;
                  if (isSplit && focusedPane === 'secondary') {
                    activeTab = secondaryTabs.find(t => t.id === secondaryActiveTabId);
                  } else {
                    activeTab = tabs.find(t => t.id === activeTabId);
                  }
                  displayPath = activeTab?.path ?? null;
                }

                if (displayPath) {
                  return (
                    <span className="text-accent/70 truncate animate-in fade-in slide-in-from-left-2 duration-200 font-mono text-[10px]">
                      {displayPath}
                    </span>
                  );
                }
                return null;
              })()}
            </div>
            <span className="hidden sm:inline text-text-muted/60">拖拽文件到窗口打开</span>
          </div>
        </div>

        {/* Right Sidebar */}
        {!isRightSidebarCollapsed && <RightSidebar />}
      </div>

      {/* Drag and Drop Overlay — different hints per drop zone */}
      {isDragging && !isDraggingOverTerminal && !isDraggingOverEditor && (
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
              释放以打开文件
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

      {/* Editor drop zone overlay — Markdown editing mode */}
      {isDragging && isDraggingOverEditor && (
        <div className="absolute inset-0 z-[100] bg-accent/5 backdrop-blur-[2px] flex flex-col items-center justify-center pointer-events-none animate-in fade-in duration-300">
          <div className="relative flex flex-col items-center justify-center p-12 rounded-3xl border-2 border-dashed border-accent bg-deepest/90 shadow-[0_0_50px_rgba(var(--accent-rgb),0.2)] animate-in zoom-in duration-300">
            <div className="absolute inset-0 rounded-3xl border-2 border-accent/30 animate-ping pointer-events-none" />

            <div className="w-24 h-24 rounded-2xl bg-accent/10 flex items-center justify-center text-accent mb-6 shadow-inner relative overflow-hidden group">
              <div className="absolute inset-0 bg-gradient-to-tr from-accent/20 to-transparent opacity-50" />
              <FileText size={48} className="relative z-10" />
            </div>

            <h2 className="text-2xl font-bold text-text mb-3 tracking-tight">
              释放以插入 Markdown 引用
            </h2>
            <div className="flex items-center gap-4 text-text-secondary text-sm">
              <div className="flex items-center gap-1.5">
                <Image size={16} className="text-accent" />
                <span>图片 → ![](path)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Link size={16} className="text-accent" />
                <span>文件 → [name](path)</span>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal />
      <SettingsModal />
      {showUpgradePanel && <UpgradePanel onClose={() => setShowUpgradePanel(false)} />}
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
    const { language, unsupportedReason } = detectLanguage(name);

    if (language === "unsupported") {
      useEditorStore.getState().showNotification(unsupportedReason || `不支持打开该类型的文件: ${name}`, "info");
      return;
    }

    let content = "";

    if (!isPreviewOnlyLanguage(language)) {
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
    useEditorStore.getState().showNotification(`无法打开文件: ${path.split(/[/\\]/).pop()} (${String(err)})`, "error");
  }
}

function quotePathForPowerShell(path: string) {
  return `'${path.replace(/'/g, "''")}'`;
}

export default App;
