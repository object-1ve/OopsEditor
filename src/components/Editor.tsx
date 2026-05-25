import { useCallback, useRef, useState, useEffect } from "react";
import MonacoEditor, { OnMount, type EditorProps } from "@monaco-editor/react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";
import { useEditorStore } from "../store/editor";
import { convertFileSrc } from "@tauri-apps/api/core";

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
    "editorIndentGuide.background": "#f0e8e0",
    "editorIndentGuide.activeBackground": "#e5dbd0",
    "editorRuler.foreground": "#e5dbd0",
    "editorWhitespace.foreground": "#d4c5b8",
    "minimap.background": "#f5f0eb",
  },
};

export default function Editor() {
  const { tabs, activeTabId, updateContent, togglePreviewMode } = useEditorStore();
  const editorRef = useRef<Parameters<OnMount>[0]>(null);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (activeTab?.language === "image") {
      try {
        setImageUrl(convertFileSrc(activeTab.path));
      } catch {
        setImageUrl(null);
      }
    } else {
      setImageUrl(null);
    }
  }, [activeTab]);

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    editor.addAction({
      id: "save-file",
      label: "Save File",
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
    return (
      <div className="flex-1 h-full flex items-center justify-center bg-deepest overflow-auto p-8">
        {imageUrl ? (
          <div className="relative group">
            <div className="absolute -inset-4 bg-accent/5 blur-xl rounded-[2rem] opacity-0 group-hover:opacity-100 transition-opacity" />
            <img
              src={imageUrl}
              alt={activeTab.name}
              className="max-w-full max-h-full object-contain shadow-2xl rounded-lg relative z-10 border border-border"
            />
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-surface/80 backdrop-blur-md border border-border text-text-muted text-xs opacity-0 group-hover:opacity-100 transition-opacity z-20">
              {activeTab.name}
            </div>
          </div>
        ) : (
          <div className="text-text-muted">无法加载图片</div>
        )}
      </div>
    );
  }

  if (activeTab.language === "markdown" && activeTab.isPreviewMode) {
    return (
      <div 
        className="h-full overflow-auto p-8 bg-primary markdown-preview prose max-w-none"
        onContextMenu={(e) => {
          e.preventDefault();
          if (activeTabId) {
            togglePreviewMode(activeTabId);
          }
        }}
      >
        <div className="max-w-4xl mx-auto">
          <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
            {activeTab.content}
          </ReactMarkdown>
        </div>
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
