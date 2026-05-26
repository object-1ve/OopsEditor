import {
  createElement,
  useCallback,
  useRef,
  useState,
  useEffect,
  useMemo,
} from "react";
import MonacoEditor, { OnMount, type EditorProps } from "@monaco-editor/react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";
import {
  Clipboard,
  Copy,
  FilePenLine,
  Redo2,
  Save,
  Scissors,
  Undo2,
} from "lucide-react";
import { useEditorStore } from "../store/editor";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { isPreviewOnlyLanguage } from "../types";
import ImagePreview from "./ImagePreview";
import ContextMenu from "./ContextMenu";
import {
  createMarkdownHeadingIdFactory,
  extractTextFromReactNode,
} from "../utils/markdown";

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

export default function Editor() {
  const {
    tabs,
    activeTabId,
    updateContent,
    togglePreviewMode,
    showNotification,
    markdownOutlineTarget,
    clearMarkdownOutlineTarget,
  } = useEditorStore();
  const editorRef = useRef<Parameters<OnMount>[0]>(null);
  const markdownPreviewRef = useRef<HTMLDivElement>(null);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [editorContextMenu, setEditorContextMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
  } | null>(null);
  const [previewContextMenu, setPreviewContextMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
  } | null>(null);

  const markdownComponents = useMemo<Components | undefined>(() => {
    if (activeTab?.language !== "markdown") {
      return undefined;
    }

    const nextHeadingId = createMarkdownHeadingIdFactory();
    const createHeadingRenderer = (
      tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6",
    ) =>
      function HeadingRenderer({
        children,
        node,
        ...props
      }: any) {
        const headingText = extractTextFromReactNode(children);
        const line = node?.position?.start?.line;
        const headingId = nextHeadingId(headingText, line);
        return createElement(tag, { ...props, id: headingId }, children);
      };

    return {
      h1: createHeadingRenderer("h1"),
      h2: createHeadingRenderer("h2"),
      h3: createHeadingRenderer("h3"),
      h4: createHeadingRenderer("h4"),
      h5: createHeadingRenderer("h5"),
      h6: createHeadingRenderer("h6"),
    };
  }, [activeTab?.id, activeTab?.language, activeTab?.content]);

  useEffect(() => {
    if (!activeTab || !isPreviewOnlyLanguage(activeTab.language)) {
      setPreviewUrl(null);
      setPreviewError(null);
      return;
    }

    let isCancelled = false;
    let objectUrl: string | null = null;
    setPreviewUrl(null);
    setPreviewError(null);

    const loadPreview = async () => {
      try {
        if (activeTab.language === "image") {
          setPreviewUrl(convertFileSrc(activeTab.path));
          return;
        }

        if (activeTab.language === "pdf") {
          const pdfBytes = await readFile(activeTab.path);
          if (isCancelled) {
            return;
          }

          objectUrl = URL.createObjectURL(
            new Blob([pdfBytes], { type: "application/pdf" }),
          );
          setPreviewUrl(objectUrl);
          return;
        }

        setPreviewUrl(null);
      } catch {
        if (!isCancelled) {
          const message = activeTab.language === "pdf"
            ? "当前文件没有读取权限，或文件内容无法作为 PDF 打开"
            : "当前预览资源加载失败";
          setPreviewUrl(null);
          setPreviewError(message);
          if (activeTab.language === "pdf") {
            showNotification(`PDF 加载失败: ${message}`, "error");
          }
        }
      }
    };

    void loadPreview();

    return () => {
      isCancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [activeTab, showNotification]);

  useEffect(() => {
    setEditorContextMenu(null);
    setPreviewContextMenu(null);
  }, [activeTab?.id, activeTab?.isPreviewMode]);

  useEffect(() => {
    if (
      !markdownOutlineTarget ||
      !activeTab ||
      activeTab.id !== markdownOutlineTarget.tabId ||
      activeTab.language !== "markdown"
    ) {
      return;
    }

    if (activeTab.isPreviewMode) {
      const container = markdownPreviewRef.current;
      if (!container) {
        return;
      }

      const escapeSelector = (value: string) => {
        if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
          return CSS.escape(value);
        }
        return value.replace(/[^a-zA-Z0-9\-_]/g, "\\$&");
      };

      let attempts = 0;
      const scrollToHeading = () => {
        const selector = `#${escapeSelector(markdownOutlineTarget.headingId)}`;
        const heading = container.querySelector<HTMLElement>(selector);

        if (!heading) {
          attempts += 1;
          if (attempts < 3) {
            requestAnimationFrame(scrollToHeading);
            return;
          }
          clearMarkdownOutlineTarget();
          return;
        }

        const containerRect = container.getBoundingClientRect();
        const headingRect = heading.getBoundingClientRect();
        const nextScrollTop =
          container.scrollTop + (headingRect.top - containerRect.top) - 24;

        container.scrollTo({
          top: Math.max(0, nextScrollTop),
          behavior: "smooth",
        });
        clearMarkdownOutlineTarget();
      };

      requestAnimationFrame(scrollToHeading);
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

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;

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
          state.markClean(id);
          saveToBackend(id);
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

    state.markClean(id);
    void saveToBackend(id);
    showNotification("文件已保存", "success");
  }, [showNotification]);

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
    const items = [
      ...(activeTab?.language === "markdown"
        ? [
            {
              label: "切换预览模式",
              icon: <FilePenLine size={14} />,
              onClick: () => activeTabId && togglePreviewMode(activeTabId),
            },
            { separator: true, label: "", onClick: () => {} },
          ]
        : []),
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
    ];

    if (editorContextMenu?.hasSelection) {
      items.push(
        {
          label: "剪切",
          icon: <Scissors size={14} />,
          onClick: () => {
            void handleEditorCut();
          },
        },
        {
          label: "复制",
          icon: <Copy size={14} />,
          onClick: () => {
            void handleEditorCopy();
          },
        },
      );
    }

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

    return items;
  }, [
    activeTab?.language,
    activeTabId,
    editorContextMenu?.hasSelection,
    handleEditorCopy,
    handleEditorCut,
    handleEditorPaste,
    handleEditorRedo,
    handleEditorSave,
    handleEditorUndo,
    togglePreviewMode,
  ]);

  const getPreviewSelectionText = useCallback(() => {
    const container = markdownPreviewRef.current;
    const selection = window.getSelection();
    if (!container || !selection || selection.rangeCount === 0) {
      return "";
    }

    const range = selection.getRangeAt(0);
    const commonAncestor = range.commonAncestorContainer;
    const selectedInsidePreview = container.contains(commonAncestor);
    if (!selectedInsidePreview) {
      return "";
    }

    return selection.toString().trim();
  }, []);

  const handlePreviewContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setPreviewContextMenu({
      x: e.clientX,
      y: e.clientY,
      hasSelection: getPreviewSelectionText().length > 0,
    });
  }, [getPreviewSelectionText]);

  const handleCopyFromPreview = useCallback(async () => {
    const selectedText = getPreviewSelectionText();
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
  }, [getPreviewSelectionText, showNotification]);

  const previewContextMenuItems = useMemo(() => {
    if (!activeTabId) {
      return [];
    }

    const items = [
      {
        label: "切换到编辑模式",
        icon: <FilePenLine size={14} />,
        onClick: () => togglePreviewMode(activeTabId),
      },
    ];

    if (previewContextMenu?.hasSelection) {
      items.push({
        label: "复制选中内容",
        icon: <Copy size={14} />,
        onClick: () => {
          void handleCopyFromPreview();
        },
      });
    }

    return items;
  }, [activeTabId, handleCopyFromPreview, previewContextMenu?.hasSelection, togglePreviewMode]);

  if (!activeTab) {
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

  if (activeTab.language === "image") {
    return previewUrl ? (
      <ImagePreview 
        src={previewUrl} 
        name={activeTab.name} 
        path={activeTab.path} 
      />
    ) : (
      <div className="flex-1 h-full flex items-center justify-center bg-deepest">
        <div className="text-text-muted">无法加载图片</div>
      </div>
    );
  }

  if (activeTab.language === "pdf") {
    return previewUrl ? (
      <div className="flex-1 h-full bg-deepest p-4">
        <div className="h-full overflow-hidden rounded-xl border border-border bg-white shadow-xl">
          <iframe
            src={previewUrl}
            title={activeTab.name}
            className="h-full w-full"
          />
        </div>
      </div>
    ) : (
      <div className="flex-1 h-full flex items-center justify-center bg-deepest">
        <div className="text-text-muted">{previewError ?? "无法加载 PDF"}</div>
      </div>
    );
  }

  if (activeTab.language === "markdown" && activeTab.isPreviewMode) {
    return (
      <div
        ref={markdownPreviewRef}
        className="h-full overflow-auto p-8 bg-primary markdown-preview prose max-w-none relative"
        onContextMenu={handlePreviewContextMenu}
      >
        <div className="max-w-4xl mx-auto">
          <ReactMarkdown
            rehypePlugins={[rehypeHighlight]}
            components={markdownComponents}
          >
            {activeTab.content}
          </ReactMarkdown>
        </div>
        {previewContextMenu && (
          <ContextMenu
            x={previewContextMenu.x}
            y={previewContextMenu.y}
            items={previewContextMenuItems}
            onClose={() => setPreviewContextMenu(null)}
          />
        )}
        {/* Floating toggle button for easier discovery */}
        <button
          onClick={() => activeTabId && togglePreviewMode(activeTabId)}
          className="fixed bottom-8 right-8 p-3 rounded-full bg-accent text-white shadow-lg hover:bg-accent-bright transition-colors z-50 group"
          title="切换到编辑模式"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <>
      <MonacoEditor
        key={activeTab.id}
        theme="terracotta-dark"
        language={activeTab.language}
        value={activeTab.content}
        onChange={handleChange}
        onMount={(editor, monaco) => {
          monaco.editor.defineTheme("terracotta-dark", TERRACOTTA_THEME);
          monaco.editor.setTheme("terracotta-dark");
          handleMount(editor, monaco);
        }}
        options={
          {
            fontSize: 14,
            fontFamily: "var(--font-mono)",
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            lineNumbers: "on",
            renderLineHighlight: "line",
            cursorBlinking: "smooth",
            cursorSmoothCaretAnimation: "on",
            cursorWidth: 2,
            smoothScrolling: true,
            padding: { top: 12 },
            bracketPairColorization: { enabled: true },
            automaticLayout: true,
            contextmenu: false,
            tabSize: 2,
            wordWrap: activeTab.language === "markdown" ? "on" : "off",
            suggest: {
              showMethods: true, showFunctions: true, showConstructors: true,
              showFields: true, showVariables: true, showClasses: true,
              showStructs: true, showInterfaces: true, showModules: true,
              showProperties: true, showEvents: true, showOperators: true,
              showUnits: true, showValues: true, showConstants: true,
              showEnums: true, showEnumMembers: true, showKeywords: true,
              showWords: true, showColors: true, showFiles: true,
              showReferences: true, showSnippets: true,
            },
          } satisfies EditorProps["options"]
        }
      />
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

async function saveToBackend(id: string) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const state = useEditorStore.getState();
    const tab = state.tabs.find((t) => t.id === id);
    if (tab) {
      await invoke("save_file", { path: tab.path, content: tab.content });
    }
  } catch {
    // ignore
  }
}
