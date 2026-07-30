import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type OnMount } from "@monaco-editor/react";
import "highlight.js/styles/github.css";
import {
  Clipboard,
  Columns2,
  Copy,
  FilePenLine,
  Redo2,
  Save,
  Scissors,
  Undo2,
} from "lucide-react";
import { useEditorStore } from "@/store/editor";
import {
  registerEditorInsert,
  unregisterEditorInsert,
  insertAtCursor,
  isImageFile,
  buildImageSyntax,
  buildLinkSyntax,
} from "@/utils/editorInsert";
import ContextMenu from "./ContextMenu";
import { resolveEditorMode } from "./editor-modes";
import { saveTab } from "@/services/editorSave";
import { clipboardToMarkdownTable, tsvToMarkdownTable } from "@/utils/clipboardTable";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { detectLanguage, isPreviewOnlyLanguage } from "@/types";

/* Bright terracotta-themed Monaco editor */
const TERRACOTTA_THEME = {
  base: "vs" as const,
  inherit: true,
  rules: [
    { token: "", foreground: "2c241e", background: "fdfaf7" },
    { token: "comment", foreground: "9a8a7a", fontStyle: "italic" },
    { token: "keyword", foreground: "c86a4e" },
    { token: "keyword.control", foreground: "c86a4e" },
    { token: "string", foreground: "6a9a82" },
    { token: "string.quoted", foreground: "6a9a82" },
    { token: "number", foreground: "b8844a" },
    { token: "type", foreground: "4a9a8a" },
    { token: "type.identifier", foreground: "4a9a8a" },
    { token: "function", foreground: "b85a3e" },
    { token: "variable", foreground: "2c241e" },
    { token: "variable.other", foreground: "2c241e" },
    { token: "tag", foreground: "b88a7a" },
    { token: "attribute.name", foreground: "5c4c42" },
    { token: "attribute.value", foreground: "6a9a82" },
    { token: "delimiter", foreground: "8a7a6a" },
    { token: "delimiter.html", foreground: "8a7a6a" },
    { token: "metatag", foreground: "b88a7a" },
    { token: "constant", foreground: "b8844a" },
    { token: "constant.language", foreground: "c86a4e" },
  ],
  colors: {
    "editor.background": "#fdfaf7",
    "editor.foreground": "#2c241e",
    "editor.lineHighlightBackground": "#f0e8e0",
    "editor.selectionBackground": "#d4c5b880",
    "editor.inactiveSelectionBackground": "#e5dbd060",
    "editorCursor.foreground": "#c86a4e",
    "editorLineNumber.foreground": "#bfae9e",
    "editorLineNumber.activeForeground": "#8a7a6a",
    "editor.selectionHighlightBackground": "#d9cdc080",
    "editorBracketMatch.background": "#d9cdc080",
    "editorBracketMatch.border": "#bfae9e",
    "editorWidget.background": "#fdfaf7",
    "editorWidget.border": "#d4c5b8",
    "editorSuggestWidget.background": "#fdfaf7",
    "editorSuggestWidget.border": "#d4c5b8",
    "editorSuggestWidget.selectedBackground": "#f0e8e0",
    "editorHoverWidget.background": "#fdfaf7",
    "editorHoverWidget.border": "#d4c5b8",
    "focusBorder": "#d4785c",
    "editorIndentGuide.background": "#f0e8e0",
    "editorIndentGuide.activeBackground": "#e5dbd0",
    "editorRuler.foreground": "#e5dbd0",
    "editorWhitespace.foreground": "#d4c5b8",
    "menu.background": "#fffaf4",
    "menu.foreground": "#3b3027",
    "menu.border": "#dccabc",
    "menu.selectionBackground": "#f3e3d6",
    "menu.selectionForeground": "#b85a3e",
    "menu.selectionBorder": "#e2b89d",
    "menu.separatorBackground": "#ead8cb",
    "widget.shadow": "#7b4b3920",
    "scrollbarSlider.background": "#ccb9aa66",
    "scrollbarSlider.hoverBackground": "#bfa79288",
    "scrollbarSlider.activeBackground": "#b08d7699",
    "minimap.background": "#f5f0eb",
  },
};

function applyTerracottaTheme(monaco: Parameters<OnMount>[1]) {
  monaco.editor.defineTheme("terracotta-dark", TERRACOTTA_THEME);
  monaco.editor.setTheme("terracotta-dark");
}

function FloatingImagePreview({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, baseX: 0, baseY: 0 });

  // Reset on new image
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [src]);

  // Escape to close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom(z => clamp(z + (e.deltaY < 0 ? 0.15 : -0.15), 0.2, 5));
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, baseX: pan.x, baseY: pan.y };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current.dragging) return;
    setPan({
      x: dragRef.current.baseX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.baseY + (e.clientY - dragRef.current.startY),
    });
  };

  const handlePointerUp = () => { dragRef.current.dragging = false; };

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center overflow-hidden"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
    >
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} />

      <img
        src={src}
        alt={name}
        className="relative select-none rounded-lg shadow-2xl"
        style={{
          transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
          maxWidth: "90vw",
          maxHeight: "90vh",
          objectFit: "contain",
          cursor: dragRef.current.dragging ? "grabbing" : "grab",
        }}
        draggable={false}
        onPointerDown={handlePointerDown}
        onClick={(e) => e.stopPropagation()}
      />

      <button onClick={onClose} className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white text-xl leading-none transition-colors">×</button>

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-2 rounded-full bg-black/40 backdrop-blur-sm">
        <button onClick={() => setZoom(z => clamp(z - 0.25, 0.2, 5))} className="w-6 h-6 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/25 text-white text-sm leading-none">−</button>
        <span className="text-white/60 text-xs tabular-nums min-w-[3.5em] text-center">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(z => clamp(z + 0.25, 0.2, 5))} className="w-6 h-6 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/25 text-white text-sm leading-none">+</button>
        <span className="w-px h-4 bg-white/15" />
        <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} className="text-white/50 hover:text-white/80 text-xs transition-colors">重置</button>
        <span className="text-white/30 text-xs ml-1">{name}</span>
      </div>
    </div>
  );
}

export default function Editor({ tabId, pane = "primary" }: { tabId?: string | null; pane?: "primary" | "secondary" } = {}) {
  const tabs = useEditorStore(s => s.tabs);
  const secondaryTabs = useEditorStore(s => s.secondaryTabs);
  const activeTabId = useEditorStore(s => s.activeTabId);
  const updateContent = useEditorStore(s => s.updateContent);
  const togglePreviewMode = useEditorStore(s => s.togglePreviewMode);
  const toggleLivePreviewMode = useEditorStore(s => s.toggleLivePreviewMode);
  const showNotification = useEditorStore(s => s.showNotification);
  const markdownOutlineTarget = useEditorStore(s => s.markdownOutlineTarget);
  const clearMarkdownOutlineTarget = useEditorStore(s => s.clearMarkdownOutlineTarget);
  const editorWordWrap = useEditorStore(s => s.editorWordWrap);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const pasteCleanupRef = useRef<(() => void) | null>(null);
  const ctrlClickCleanupRef = useRef<{ dispose(): void } | null>(null);
  // tabId 显式为 null 表示该窗口无标签（分屏副窗口）；undefined 时回退到全局活动标签
  const currentTabId = tabId !== undefined ? tabId : activeTabId;
  // 分屏副窗口的标签可能在 secondaryTabs 而非全局 tabs
  const activeTab = tabId !== undefined
    ? (tabs.find((t) => t.id === currentTabId) ?? secondaryTabs.find((t) => t.id === currentTabId))
    : tabs.find((t) => t.id === currentTabId);
  // 保持 Monaco action 闭包内能读到最新的 currentTabId
  const currentTabIdRef = useRef(currentTabId);
  currentTabIdRef.current = currentTabId;
  const [editorContextMenu, setEditorContextMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
  } | null>(null);
  const [floatingImage, setFloatingImage] = useState<{ src: string; name: string } | null>(null);
  useEffect(() => {
    setEditorContextMenu(null);
  }, [activeTab?.id, activeTab?.isLivePreviewMode, activeTab?.isPreviewMode]);

  useEffect(() => {
    if (
      !markdownOutlineTarget ||
      !activeTab ||
      activeTab.id !== markdownOutlineTarget.tabId ||
      activeTab.language !== "markdown" ||
      activeTab.isPreviewMode
    ) {
      return;
    }

    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    editor.revealLineInCenter(markdownOutlineTarget.line);
    editor.setPosition({ lineNumber: markdownOutlineTarget.line, column: 1 });
    editor.focus();
    clearMarkdownOutlineTarget();
  }, [activeTab, clearMarkdownOutlineTarget, markdownOutlineTarget]);

  // 监听 App 层发起的文件拖放事件（来自 Tauri onDragDropEvent）
  useEffect(() => {
    const handleFileDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail as { paths: string[] } | undefined;
      if (!detail?.paths?.length) return;

      const state = useEditorStore.getState();
      // 分屏时只处理焦点窗口对应的标签，避免两个 Editor 实例重复插入
      // tabId !== undefined 表示这是分屏副窗口实例
      if (state.isSplit && state.focusedPane !== (tabId !== undefined ? 'secondary' : 'primary')) {
        return;
      }
      const id = currentTabIdRef.current;
      const tab = state.tabs.find((t) => t.id === id)
        ?? state.secondaryTabs.find((t) => t.id === id);
      if (
        !tab ||
        tab.language !== "markdown" ||
        tab.isPreviewMode ||
        tab.isReadOnly
      ) {
        return;
      }

      let insertedCount = 0;
      for (const path of detail.paths) {
        const text = isImageFile(path)
          ? buildImageSyntax(path)
          : buildLinkSyntax(path);
        if (insertAtCursor(text)) insertedCount++;
      }

      if (insertedCount > 0) {
        state.showNotification(
          `已插入 ${insertedCount} 个文件引用到 Markdown`,
          "success",
        );
      }
    };

    window.addEventListener("file-drop-into-editor", handleFileDrop);
    return () => {
      window.removeEventListener("file-drop-into-editor", handleFileDrop);
    };
  }, []);

  const persistTab = useCallback(async (id: string) => {
    const state = useEditorStore.getState();
    // 兼顾主窗口 tabs 与副窗口 secondaryTabs
    const tab = state.tabs.find((item) => item.id === id)
      ?? state.secondaryTabs.find((item) => item.id === id);
    if (!tab) {
      return;
    }

    await saveTab(tab);
    state.markClean(id);
    
    // 发送刷新事件，让 Git 面板等组件自动更新
    window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path: tab.path } }));
  }, []);

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;

    // 注册编辑器插入回调，供拖放等其他模块使用
    registerEditorInsert((text: string) => {
      const selection = editor.getSelection();
      if (!selection) {
        editor.executeEdits("external-insert", [
          { range: new monaco.Range(1, 1, 1, 1), text, forceMoveMarkers: true },
        ]);
        return;
      }
      editor.executeEdits("external-insert", [
        {
          range: new monaco.Range(
            selection.startLineNumber,
            selection.startColumn,
            selection.endLineNumber,
            selection.endColumn,
          ),
          text,
          forceMoveMarkers: true,
        },
      ]);
      editor.focus();
    });

    editor.onContextMenu((event) => {
      const browserEvent = event.event.browserEvent;
      browserEvent.preventDefault();

      const selection = editor.getSelection();
      const hasSelection = Boolean(selection && !selection.isEmpty());

      setEditorContextMenu({
        x: browserEvent.clientX,
        y: browserEvent.clientY,
        hasSelection,
      });
    });

    // Markdown 编辑模式下，把粘贴的表格（HTML <table> 或 TSV）转为 GFM 表格语法
    // 同时检测剪贴板中的图片，保存到 md 文件同级 Attachment 目录
    const domNode = editor.getDomNode();
    console.log("[PasteImage] domNode:", domNode);
    if (domNode) {
      const handlePaste = async (e: ClipboardEvent) => {
        // 只处理发生在 Monaco 编辑器内的粘贴事件，不拦截其他输入框
        if (domNode && !domNode.contains(e.target as Node)) {
          return;
        }
        const state = useEditorStore.getState();
        const id = currentTabIdRef.current;
        if (!id) return;
        const tab = state.tabs.find((t) => t.id === id)
          ?? state.secondaryTabs.find((t) => t.id === id);
        if (!tab || tab.language !== "markdown" || tab.isPreviewMode || tab.isLivePreviewMode || tab.isReadOnly) {
          return;
        }

        // 检测剪贴板中的图片文件（截图、复制图片等）
        console.log("[PasteImage] paste event fired, clipboardData:", e.clipboardData);
        const items = e.clipboardData?.items;
        console.log("[PasteImage] items:", items, "length:", items?.length);
        if (items) {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            console.log(`[PasteImage] item[${i}] kind=${item.kind} type=${item.type}`);
            if (item.kind === "file" && item.type.startsWith("image/")) {
              console.log("[PasteImage] image file item detected!");
              const file = item.getAsFile();
              console.log("[PasteImage] getAsFile:", file, "name:", file?.name, "size:", file?.size);
              if (file) {
                e.preventDefault();
                e.stopPropagation();
                console.log("[PasteImage] reading file as data URL...");

                // 读取图片为 base64
                const reader = new FileReader();
                reader.onload = async () => {
                  try {
                    console.log("[PasteImage] FileReader onload fired, result length:", (reader.result as string)?.length);
                    const base64 = (reader.result as string).split(",")[1];
                    console.log("[PasteImage] base64 length:", base64?.length);

                    // 获取当前 md 文件所在目录
                    const mdPath = (tab.path || "").replace(/\\/g, "/");
                    const lastSlash = mdPath.lastIndexOf("/");
                    console.log("[PasteImage] mdPath:", mdPath, "lastSlash:", lastSlash);
                    if (lastSlash < 0) {
                      console.log("[PasteImage] no parent dir — tab not saved yet");
                      useEditorStore.getState().showNotification(
                        "当前文件尚未保存到磁盘，请先保存文件",
                        "error",
                      );
                      return;
                    }
                    const parentDir = mdPath.substring(0, lastSlash);
                    const saveDir = parentDir + "/Attachment";
                    console.log("[PasteImage] parentDir:", parentDir, "saveDir:", saveDir);

                    // 生成文件名：image_YYYYMMDD_HHMMSS.ext
                    const ext = (file.name || "image.png").split(".").pop() || "png";
                    const now = new Date();
                    const pad = (n: number) => String(n).padStart(2, "0");
                    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
                    const filename = `image_${ts}.${ext}`;
                    const savePath = saveDir + "/" + filename;
                    console.log("[PasteImage] filename:", filename, "savePath:", savePath);

                    console.log("[PasteImage] creating dir:", saveDir);
                    try { await invoke("create_dir", { path: saveDir }); } catch (e) {
                      const msg = String(e);
                      if (!msg.includes("目录已存在") && !msg.includes("exists")) throw e;
                      console.log("[PasteImage] dir already exists, continuing:", saveDir);
                    }
                    console.log("[PasteImage] invoking save_file_from_base64...");
                    await invoke("save_file_from_base64", {
                      path: savePath,
                      content: base64,
                    });
                    console.log("[PasteImage] save_file_from_base64 succeeded");
                    window.dispatchEvent(
                      new CustomEvent("file-refresh", { detail: { path: saveDir } }),
                    );

                    // 插入 markdown 图片语法
                    const selection = editor.getSelection();
                    const range = selection
                      ? new monaco.Range(
                          selection.startLineNumber,
                          selection.startColumn,
                          selection.endLineNumber,
                          selection.endColumn,
                        )
                      : new monaco.Range(1, 1, 1, 1);
                    editor.executeEdits("paste-image", [
                      { range, text: `![](Attachment/${filename})\n`, forceMoveMarkers: true },
                    ]);
                    console.log("[PasteImage] inserted markdown image syntax");
                    editor.focus();
                    useEditorStore.getState().showNotification(
                      `图片已保存到 ${filename}`,
                      "success",
                    );
                  } catch (err) {
                    console.error("[PasteImage] error:", err);
                    useEditorStore.getState().showNotification(
                      `保存剪贴板图片失败: ${String(err)}`,
                      "error",
                    );
                  }
                };
                reader.onerror = (ev) => {
                  console.error("[PasteImage] FileReader error:", ev);
                  useEditorStore.getState().showNotification(
                    "读取剪贴板图片失败",
                    "error",
                  );
                };
                reader.readAsDataURL(file);
                return;
              } else {
                console.log("[PasteImage] getAsFile returned null/undefined");
              }
            }
          }
          console.log("[PasteImage] no image file found in items");
        } else {
          console.log("[PasteImage] clipboardData.items is null/undefined");
        }

        // 原有的表格粘贴处理
        const md = clipboardToMarkdownTable(e.clipboardData);
        if (!md) return;

        e.preventDefault();
        e.stopPropagation();
        const selection = editor.getSelection();
        const range = selection
          ? new monaco.Range(
              selection.startLineNumber,
              selection.startColumn,
              selection.endLineNumber,
              selection.endColumn,
            )
          : new monaco.Range(1, 1, 1, 1);
        editor.executeEdits("paste-table", [{ range, text: md, forceMoveMarkers: true }]);
        editor.focus();
      };
      console.log("[PasteImage] ✅ registering capture-phase paste listener on document");
      document.addEventListener("paste", handlePaste, true);
      pasteCleanupRef.current = () => document.removeEventListener("paste", handlePaste, true);
    }

    // Ctrl+Click on ![](path) opens the image in a new tab
    const ctrlClickDisposable = editor.onMouseDown((e) => {
      if (!e.event.ctrlKey && !e.event.metaKey) return;
      if (!e.target.position) return;

      const model = editor.getModel();
      if (!model) return;

      const line = model.getLineContent(e.target.position.lineNumber);
      const col = e.target.position.column - 1; // 0-indexed

      // Find all ![](...) patterns and check if click lies within one
      const pattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const fullMatch = match[0];
        const startIdx = match.index;
        const endIdx = match.index + fullMatch.length;

        if (col >= startIdx && col < endIdx) {
          e.event.preventDefault();
          e.event.stopPropagation();

          const matchedPath = match[2];
          const state = useEditorStore.getState();
          const tabId = currentTabIdRef.current;
          const currentTab = tabId
            ? (state.tabs.find((t) => t.id === tabId) ?? state.secondaryTabs.find((t) => t.id === tabId))
            : null;

          // Resolve relative path against the current md file's directory
          let resolvedPath = matchedPath;
          if (currentTab?.path && !matchedPath.startsWith("/") && !matchedPath.includes(":")) {
            const mdDir = currentTab.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
            resolvedPath = mdDir + "/" + matchedPath;
          }

          // Open the image in floating preview
          (async () => {
            try {
              const exists = await invoke<boolean>("path_exists", { path: resolvedPath });
              if (!exists) {
                useEditorStore.getState().showNotification(
                  `文件不存在: ${matchedPath}`,
                  "error",
                );
                return;
              }

              const name = resolvedPath.split(/[/\\]/).pop() ?? resolvedPath;
              const src = convertFileSrc(resolvedPath);
              setFloatingImage({ src, name });
              useEditorStore.getState().setFloatingImageOpen(true);
            } catch (err) {
              useEditorStore.getState().showNotification(
                `无法打开文件: ${String(err)}`,
                "error",
              );
            }
          })();
          break;
        }
      }
    });
    ctrlClickCleanupRef.current = ctrlClickDisposable;

    editor.addAction({
      id: "save-file",
      label: "保存文件",
      keybindings: [2048 | 49],
      run: () => {
        const state = useEditorStore.getState();
        const id = currentTabIdRef.current;
        if (id) {
          void persistTab(id)
            .then(() => {
              state.showNotification("文件已保存", "success");
            })
            .catch((err) => {
              state.showNotification(`保存失败: ${String(err)}`, "error");
            });
        }
      },
    });

    editor.addAction({
      id: "toggle-markdown-preview",
      label: "切换预览模式",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP],
      precondition: "editorLangId == 'markdown'",
      contextMenuGroupId: "navigation",
      run: () => {
        const state = useEditorStore.getState();
        const id = currentTabIdRef.current;
        if (id) {
          state.togglePreviewMode(id);
        }
      },
    });
  }, [persistTab]);

  // 组件卸载时清理编辑器插入回调
  useEffect(() => {
    return () => {
      unregisterEditorInsert();
      pasteCleanupRef.current?.();
      pasteCleanupRef.current = null;
      ctrlClickCleanupRef.current?.dispose();
      ctrlClickCleanupRef.current = null;
    };
  }, []);

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (currentTabId && value !== undefined) {
        updateContent(currentTabId, value);
      }
    },
    [currentTabId, updateContent],
  );

  const handleEditorUndo = useCallback(() => {
    editorRef.current?.trigger("context-menu", "undo", null);
  }, []);

  const handleEditorRedo = useCallback(() => {
    editorRef.current?.trigger("context-menu", "redo", null);
  }, []);

  const handleEditorSave = useCallback(() => {
    const id = currentTabIdRef.current;
    if (!id) {
      return;
    }

    void persistTab(id)
      .then(() => {
        showNotification("文件已保存", "success");
      })
      .catch((err) => {
        showNotification(`保存失败: ${String(err)}`, "error");
      });
  }, [persistTab, showNotification]);

  const getEditorSelectionText = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      return "";
    }

    const selection = editor.getSelection();
    const model = editor.getModel();
    if (!selection || selection.isEmpty() || !model) {
      return "";
    }

    return model.getValueInRange(selection);
  }, []);

  const handleEditorCopy = useCallback(async () => {
    const selectedText = getEditorSelectionText();
    if (!selectedText) {
      showNotification("请先选择要复制的内容", "info");
      return;
    }

    try {
      await navigator.clipboard.writeText(selectedText);
      showNotification("已复制选中内容", "success");
    } catch {
      showNotification("复制失败", "error");
    }
  }, [getEditorSelectionText, showNotification]);

  const handleEditorCut = useCallback(async () => {
    const editor = editorRef.current;
    const selectedText = getEditorSelectionText();
    if (!editor || !selectedText) {
      showNotification("请先选择要剪切的内容", "info");
      return;
    }

    try {
      await navigator.clipboard.writeText(selectedText);
      editor.trigger("context-menu", "editor.action.clipboardCutAction", undefined);
      showNotification("已剪切选中内容", "success");
    } catch {
      showNotification("剪切失败", "error");
    }
  }, [getEditorSelectionText, showNotification]);

  const handleEditorPaste = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      // Markdown 编辑模式下，把 TSV 表格转为 GFM 语法（右键粘贴拿不到 HTML，仅处理 TSV）
      const state = useEditorStore.getState();
      const id = currentTabIdRef.current;
      const tab = id ? (state.tabs.find((t) => t.id === id) ?? state.secondaryTabs.find((t) => t.id === id)) : null;
      const md = tab && tab.language === "markdown" && !tab.isPreviewMode && !tab.isLivePreviewMode && !tab.isReadOnly
        ? tsvToMarkdownTable(text)
        : null;
      editor.trigger("context-menu", "type", { text: md ?? text });
    } catch {
      showNotification("粘贴失败，请检查剪贴板权限", "error");
    }
  }, [showNotification]);

  const editorContextMenuItems = useMemo(() => {
    const isReadOnlyTab = Boolean(activeTab?.isReadOnly);
    const items = [
      ...(activeTab?.language === "markdown"
        ? [
            {
              label: activeTab.isPreviewMode ? "返回编辑模式" : "切换预览模式",
              icon: <FilePenLine size={14} />,
              onClick: () => currentTabId && togglePreviewMode(currentTabId),
            },
            {
              label: activeTab.isLivePreviewMode ? "关闭实时模式" : "开启实时模式",
              icon: <Columns2 size={14} />,
              onClick: () => currentTabId && toggleLivePreviewMode(currentTabId),
            },
            { separator: true, label: "", onClick: () => {} },
          ]
        : []),
      ...(!isReadOnlyTab
        ? [
            {
              label: "撤销",
              icon: <Undo2 size={14} />,
              onClick: handleEditorUndo,
            },
            {
              label: "重做",
              icon: <Redo2 size={14} />,
              onClick: handleEditorRedo,
            },
            { separator: true, label: "", onClick: () => {} },
          ]
        : []),
    ];

    if (editorContextMenu?.hasSelection) {
      items.push(
        ...(!isReadOnlyTab
          ? [
              {
                label: "剪切",
                icon: <Scissors size={14} />,
                onClick: () => {
                  void handleEditorCut();
                },
              },
            ]
          : []),
        {
          label: "复制",
          icon: <Copy size={14} />,
          onClick: () => {
            void handleEditorCopy();
          },
        },
      );
    }

    if (!isReadOnlyTab) {
      items.push(
        {
          label: "粘贴",
          icon: <Clipboard size={14} />,
          onClick: () => {
            void handleEditorPaste();
          },
        },
        { separator: true, label: "", onClick: () => {} },
        {
          label: "保存文件",
          icon: <Save size={14} />,
          onClick: handleEditorSave,
        },
      );
    }

    return items;
  }, [
    activeTab?.isReadOnly,
    activeTab?.language,
    currentTabId,
    editorContextMenu?.hasSelection,
    handleEditorCopy,
    handleEditorCut,
    handleEditorPaste,
    handleEditorRedo,
    handleEditorSave,
    handleEditorUndo,
    toggleLivePreviewMode,
    togglePreviewMode,
  ]);

  const mode = activeTab ? resolveEditorMode(activeTab) : null;

  if (!activeTab || !mode) {
    // 分屏副窗口无标签时显示简洁提示
    if (pane === "secondary") {
      return (
        <div className="flex items-center justify-center h-full select-none">
          <div className="text-center space-y-3 relative">
            <div className="w-12 h-12 mx-auto rounded-xl bg-surface border border-border flex items-center justify-center text-text-muted">
              <Columns2 size={20} />
            </div>
            <p className="text-sm text-text-muted">在此面板打开文件</p>
            <p className="text-xs text-text-muted/50">从左侧文件树打开，或拖拽文件到此区域</p>
          </div>
        </div>
      );
    }

    return (
      <div className="flex items-center justify-center h-full select-none">
        <div className="text-center space-y-6 relative">
          <div className="absolute -top-20 left-1/2 -translate-x-1/2 w-64 h-64 rounded-full bg-accent-glow blur-3xl pointer-events-none" />

          {/* Logo — terracotta clay tablet feel */}
          <div className="relative">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-accent to-accent-bright flex items-center justify-center shadow-lg shadow-accent/20">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <rect x="6" y="7" width="20" height="18" rx="3" stroke="white" strokeWidth="1.5" fill="none" />
                <path d="M10 13h12M10 17h8M10 21h6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
          </div>

          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight shimmer-text">Oops Editor</h1>
            <p className="text-text-secondary">万能编辑器，开始你的创作</p>
          </div>

          <div className="pt-4">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-dashed border-border text-text-muted text-xs">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 3v12m0 0l-4-4m4 4l4-4M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4" />
              </svg>
              拖拽文件到窗口打开
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {mode.render({
        activeTab,
        editorWordWrap,
        onChange: handleChange,
        onEditorMount: handleMount,
        applyTheme: applyTerracottaTheme,
        togglePreviewMode,
        toggleLivePreviewMode,
        markdownOutlineTarget,
        clearMarkdownOutlineTarget,
        showNotification,
      })}
      {editorContextMenu && (
        <ContextMenu
          x={editorContextMenu.x}
          y={editorContextMenu.y}
          items={editorContextMenuItems}
          onClose={() => setEditorContextMenu(null)}
        />
      )}
      {floatingImage && (
        <FloatingImagePreview
          src={floatingImage.src}
          name={floatingImage.name}
          onClose={() => { setFloatingImage(null); useEditorStore.getState().setFloatingImageOpen(false); }}
        />
      )}
    </>
  );
}
