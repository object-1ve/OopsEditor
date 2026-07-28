/**
 * useAppDragDrop - Tauri-level drag and drop event handling
 */
import { useEffect, useCallback } from "react";
import { useEditorStore } from "@/store/editor";
import { detectLanguage, isPreviewOnlyLanguage } from "@/types";
import { dispatchFileDrop, isMarkdownEditable } from "@/utils/editorInsert";

export function useDragDrop(
  isSplit: boolean,
  isPointInsideTerminal: (pos?: { x: number; y: number }) => boolean,
  isPointInsideEditor: (pos?: { x: number; y: number }) => boolean,
  insertPathsIntoTerminal: (paths: string[]) => Promise<boolean>,
  setTerminalDragState: (v: boolean) => void,
  setEditorDragState: (v: boolean) => void,
  setIsDragging: (v: boolean) => void,
) {
  useEffect(() => {
    let unlistenDrop: (() => void) | undefined;

    async function setup() {
      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const appWindow = getCurrentWebviewWindow();

        unlistenDrop = await appWindow.onDragDropEvent((event) => {
          if (event.payload.type === "enter") {
            setIsDragging(true);
            setTerminalDragState(false);
            setEditorDragState(false);
          } else if (event.payload.type === "over") {
            const overTerminal = isPointInsideTerminal(event.payload.position);
            const dropState = useEditorStore.getState();
            const focusedTabId =
              dropState.isSplit && dropState.focusedPane === "secondary"
                ? dropState.secondaryActiveTabId
                : dropState.activeTabId;
            const allTabs =
              dropState.isSplit
                ? [...dropState.tabs, ...dropState.secondaryTabs]
                : dropState.tabs;
            const overEditor =
              !overTerminal && isPointInsideEditor(event.payload.position) && isMarkdownEditable(allTabs, focusedTabId);
            setTerminalDragState(overTerminal);
            setEditorDragState(overEditor);
          } else if (event.payload.type === "drop") {
            const droppedInTerminal = isPointInsideTerminal(event.payload.position);
            const dropState = useEditorStore.getState();
            const focusedTabId =
              dropState.isSplit && dropState.focusedPane === "secondary"
                ? dropState.secondaryActiveTabId
                : dropState.activeTabId;
            const allTabs =
              dropState.isSplit
                ? [...dropState.tabs, ...dropState.secondaryTabs]
                : dropState.tabs;
            const droppedInEditor =
              !droppedInTerminal && isPointInsideEditor(event.payload.position) && isMarkdownEditable(allTabs, focusedTabId);

            setIsDragging(false);
            setTerminalDragState(false);
            setEditorDragState(false);

            const paths = event.payload.paths;
            if (droppedInTerminal) {
              void insertPathsIntoTerminal(paths);
              return;
            }

            if (droppedInEditor) {
              dispatchFileDrop(paths);
              return;
            }

            for (const path of paths) {
              void handleDroppedPath(path);
            }
          } else {
            setIsDragging(false);
            setTerminalDragState(false);
            setEditorDragState(false);
          }
        });
      } catch (e) {
        console.error("Failed to register drag-drop listener:", e);
      }
    }

    setup();

    return () => {
      if (unlistenDrop) unlistenDrop();
    };
  }, [
    isSplit,
    isPointInsideTerminal,
    isPointInsideEditor,
    insertPathsIntoTerminal,
    setTerminalDragState,
    setEditorDragState,
    setIsDragging,
  ]);
}

export async function handleDroppedPath(path: string) {
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
      useEditorStore.getState().showNotification(
        unsupportedReason || `不支持打开该类型的文件: ${name}`,
        "info",
      );
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
    useEditorStore.getState().showNotification(
      `无法打开文件: ${path.split(/[/\\]/).pop()} (${String(err)})`,
      "error",
    );
  }
}
