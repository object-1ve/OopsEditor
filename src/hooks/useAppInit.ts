/**
 * useAppInit - Window initialization and Monaco setup
 */
import { useEffect, useRef } from "react";
import { useEditorStore } from "@/store/editor";
import { loadSettings, saveSetting } from "@/utils/settings";
import { monacoReady } from "@/monaco";

export const DEFAULT_WINDOW_SIZE = { width: 1200, height: 800 };
export const DEFAULT_WINDOW_POSITION = { x: 100, y: 100 };
const MIN_RESTORABLE_WINDOW_SIZE = { width: 800, height: 600 };
const MAX_ABSOLUTE_WINDOW_POSITION = 10000;

export function isValidRestoredWindowSize(
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

export function isValidRestoredWindowPosition(
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


export function useAppInit() {
  const init = useEditorStore((s) => s.init);
  const isAppReadyRef = useRef(false);

  useEffect(() => {
    let unlistenResize: (() => void) | undefined;
    let unlistenMoved: (() => void) | undefined;
    let unlistenDrop: (() => void) | undefined;
    let unlistenClose: (() => void) | undefined;
    let isMounted = true;
    let ready = false;

    const setIsAppReady = (val: boolean) => {
      ready = val;
      isAppReadyRef.current = val;
    };

    async function setupApp() {
      const timeoutId = setTimeout(async () => {
        if (!ready && isMounted) {
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
      }, 5000);

      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const { LogicalSize, LogicalPosition } = await import("@tauri-apps/api/dpi");
        const appWindow = getCurrentWebviewWindow();

        await Promise.all([init(), monacoReady]);

        if (!isMounted) return;

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

        unlistenResize = await appWindow.onResized(async () => {
          const size = await appWindow.innerSize();
          const factor = await appWindow.scaleFactor();
          const logicalSize = size.toLogical(factor);
          await saveSetting("windowSize", { width: logicalSize.width, height: logicalSize.height });
        });

        unlistenMoved = await appWindow.onMoved(async () => {
          const pos = await appWindow.innerPosition();
          const factor = await appWindow.scaleFactor();
          const logicalPos = pos.toLogical(factor);
          await saveSetting("windowPosition", { x: logicalPos.x, y: logicalPos.y });
        });

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

      // Register drag-drop and close listeners after initialization
      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const appWindow = getCurrentWebviewWindow();

        // Close listener
        unlistenClose = await appWindow.onCloseRequested(async (event) => {
          const state = useEditorStore.getState();
          const dirtyTabs = state.tabs.filter((tab) => tab.isDirty);
          if (dirtyTabs.length > 0) {
            event.preventDefault();
            state.showModal({
              title: "是否保存窗口",
              message: `有 ${dirtyTabs.length} 个文件尚未保存，关闭将丢失所有更改。确定要退出吗？`,
              kind: "warning",
              onConfirm: () => {
                appWindow.destroy();
              },
            });
          }
        });
      } catch (e) {
        console.error("Failed to register close listener:", e);
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
  }, [init]);

  return isAppReadyRef;
}
