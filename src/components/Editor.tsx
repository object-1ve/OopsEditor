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
import { useEditorStore } from "../store/editor";
import {
  registerEditorInsert,
  unregisterEditorInsert,
  insertAtCursor,
  isImageFile,
  buildImageSyntax,
  buildLinkSyntax,
} from "../utils/editorInsert";
import ContextMenu from "./ContextMenu";
import { resolveEditorMode } from "./editor-modes";
import { saveTab } from "../services/editorSave";

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

export default function Editor() {
  const {
    tabs,
    activeTabId,
    updateContent,
    togglePreviewMode,
    toggleLivePreviewMode,
    showNotification,
    markdownOutlineTarget,
    clearMarkdownOutlineTarget,
    editorWordWrap,
  } = useEditorStore();
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const [editorContextMenu, setEditorContextMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
  } | null>(null);
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
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
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
    const tab = state.tabs.find((item) => item.id === id);
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

    editor.addAction({
      id: "save-file",
      label: "保存文件",
      keybindings: [2048 | 49],
      run: () => {
        const state = useEditorStore.getState();
        const id = state.activeTabId;
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
        if (state.activeTabId) {
          state.togglePreviewMode(state.activeTabId);
        }
      },
    });
  }, [persistTab]);

  // 组件卸载时清理编辑器插入回调
  useEffect(() => {
    return () => {
      unregisterEditorInsert();
    };
  }, []);

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (activeTabId && value !== undefined) {
        updateContent(activeTabId, value);
      }
    },
    [activeTabId, updateContent],
  );

  const handleEditorUndo = useCallback(() => {
    editorRef.current?.trigger("context-menu", "undo", null);
  }, []);

  const handleEditorRedo = useCallback(() => {
    editorRef.current?.trigger("context-menu", "redo", null);
  }, []);

  const handleEditorSave = useCallback(() => {
    const state = useEditorStore.getState();
    const id = state.activeTabId;
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
      editor.trigger("context-menu", "type", { text });
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
              label: activeTab.isLivePreviewMode ? "关闭实时模式" : "开启实时模式",
              icon: <Columns2 size={14} />,
              onClick: () => activeTabId && toggleLivePreviewMode(activeTabId),
            },
            {
              label: activeTab.isPreviewMode ? "返回编辑模式" : "切换预览模式",
              icon: <FilePenLine size={14} />,
              onClick: () => activeTabId && togglePreviewMode(activeTabId),
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
    activeTabId,
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
    </>
  );
}
