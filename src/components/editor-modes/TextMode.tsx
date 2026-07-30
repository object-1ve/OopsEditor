/**
 * Text editor mode - Monaco editor with optional live markdown preview
 */
import { useCallback, useEffect, useRef } from "react";
import MonacoEditor, { type EditorProps, type OnMount } from "@monaco-editor/react";
import { FilePenLine } from "lucide-react";
import { useMonacoScrollMemory } from "./sharedHooks";
import { MarkdownPreviewPane } from "./MarkdownMode";
import type { EditorModeContext, EditorModeAdapter, SharedContextMenuItem } from "./types";

function TextModeView({
  activeTab,
  editorWordWrap,
  onChange,
  onEditorMount,
  applyTheme,
  toggleLivePreviewMode,
  markdownOutlineTarget,
  clearMarkdownOutlineTarget,
  showNotification,
}: Pick<
  EditorModeContext,
  | "activeTab"
  | "editorWordWrap"
  | "onChange"
  | "onEditorMount"
  | "applyTheme"
  | "toggleLivePreviewMode"
  | "markdownOutlineTarget"
  | "clearMarkdownOutlineTarget"
  | "showNotification"
>) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const isSyncingRef = useRef(false);
  const restoreMonacoScroll = useMonacoScrollMemory(activeTab.id);
  const monacoMemoryCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      monacoMemoryCleanupRef.current?.();
      monacoMemoryCleanupRef.current = null;
    };
  }, []);

  // Editor -> Preview 同步
  const handleEditorScroll = useCallback(() => {
    if (isSyncingRef.current || !editorRef.current || !previewContainerRef.current) return;

    const editor = editorRef.current;
    const preview = previewContainerRef.current;

    isSyncingRef.current = true;

    try {
      const visibleRanges = editor.getVisibleRanges();
      if (visibleRanges.length > 0) {
        const topLine = visibleRanges[0].startLineNumber;
        // 查找预览中对应的行号元素
        const element = preview.querySelector(`[data-line="${topLine}"]`);
        if (element) {
          element.scrollIntoView({ behavior: "auto", block: "start" });
        } else {
          // 如果没找到精确行号，寻找最接近的前一个行号
          const elements = Array.from(preview.querySelectorAll("[data-line]"));
          let closest = null;
          for (const el of elements) {
            const line = parseInt(el.getAttribute("data-line") || "0");
            if (line <= topLine) {
              closest = el;
            } else {
              break;
            }
          }
          if (closest) {
            closest.scrollIntoView({ behavior: "auto", block: "start" });
          }
        }
      }
    } finally {
      isSyncingRef.current = false;
    }
  }, []);

  // Preview -> Editor 同步
  const handlePreviewScroll = useCallback(() => {
    if (isSyncingRef.current || !editorRef.current || !previewContainerRef.current) return;

    const editor = editorRef.current;
    const preview = previewContainerRef.current;

    isSyncingRef.current = true;

    try {
      const previewRect = preview.getBoundingClientRect();
      const elements = Array.from(preview.querySelectorAll("[data-line]"));
      
      // 找到位于预览窗口顶部的元素
      let topLine = 1;
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.top >= previewRect.top - 20) {
          topLine = parseInt(el.getAttribute("data-line") || "1");
          break;
        }
      }

      editor.revealLine(topLine, 1);
    } finally {
      isSyncingRef.current = false;
    }
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || activeTab.language !== "markdown" || !activeTab.isLivePreviewMode) {
      return;
    }

    const disposable = editor.onDidScrollChange(() => {
      handleEditorScroll();
    });

    return () => {
      disposable.dispose();
    };
  }, [activeTab.isLivePreviewMode, activeTab.language, handleEditorScroll]);

  const editor = (
    <MonacoEditor
      key={activeTab.id}
      theme="terracotta-dark"
      language={activeTab.language}
      value={activeTab.content}
      onChange={onChange}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        applyTheme(monaco);
        onEditorMount(editor, monaco);
        monacoMemoryCleanupRef.current?.();
        monacoMemoryCleanupRef.current = restoreMonacoScroll(editor);
      }}
      options={{
        fontSize: 14,
        fontFamily: "var(--font-mono)",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: "on",
        lineNumbersMinChars: 3,
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
        wordWrap: editorWordWrap ? "on" : "off",
        readOnly: activeTab.isReadOnly ?? false,
        dropIntoEditor: { enabled: false },
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
      } satisfies EditorProps["options"]}
    />
  );

  if (activeTab.language === "markdown" && activeTab.isLivePreviewMode) {
    const previewContextMenuItems: SharedContextMenuItem[] = [
      {
        label: "关闭实时模式",
        icon: <FilePenLine size={14} />,
        onClick: () => toggleLivePreviewMode(activeTab.id),
      },
    ];

    return (
      <div className="flex h-full bg-primary">
        <div className="min-w-0 flex-1 border-r border-border">
          {editor}
        </div>
        <div className="flex min-w-0 flex-1 flex-col bg-primary">
          <MarkdownPreviewPane
            activeTab={activeTab}
            markdownOutlineTarget={markdownOutlineTarget}
            clearMarkdownOutlineTarget={clearMarkdownOutlineTarget}
            showNotification={showNotification}
            contextMenuItems={previewContextMenuItems}
            wrapperClassName="min-h-0 flex-1 overflow-auto p-6 markdown-preview prose max-w-none relative"
            contentClassName="mx-auto max-w-3xl"
            syncOutlineTarget={false}
            onScroll={handlePreviewScroll}
            containerRef={previewContainerRef}
            persistScroll
          />
        </div>
      </div>
    );
  }

  return editor;
}

export const textMode: EditorModeAdapter = {
  id: "text",
  match: () => true,
  render: (context) => (
    <TextModeView
      activeTab={context.activeTab}
      editorWordWrap={context.editorWordWrap}
      onChange={context.onChange}
      onEditorMount={context.onEditorMount}
      applyTheme={context.applyTheme}
      toggleLivePreviewMode={context.toggleLivePreviewMode}
      markdownOutlineTarget={context.markdownOutlineTarget}
      clearMarkdownOutlineTarget={context.clearMarkdownOutlineTarget}
      showNotification={context.showNotification}
    />
  ),
};
