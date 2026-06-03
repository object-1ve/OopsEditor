import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import MonacoEditor, { type EditorProps, type OnMount } from "@monaco-editor/react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { Copy, FilePenLine } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import type { MarkdownOutlineTarget } from "../../store/editor";
import type { FileTab } from "../../types";
import {
  bytesToAsciiView,
  getHexOffsetLabel,
  parseHexView,
} from "../../utils/hexView";
import {
  createMarkdownHeadingIdFactory,
  extractTextFromReactNode,
} from "../../utils/markdown";
import ContextMenu from "../ContextMenu";
import ImagePreview from "../ImagePreview";
import WordPreview from "../WordPreview";

type SharedContextMenuItem = {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  separator?: boolean;
};

export interface EditorModeContext {
  activeTab: FileTab;
  editorWordWrap: boolean;
  onChange: (value: string | undefined) => void;
  onEditorMount: OnMount;
  applyTheme: (monaco: Parameters<OnMount>[1]) => void;
  togglePreviewMode: (id: string) => void;
  toggleLivePreviewMode: (id: string) => void;
  markdownOutlineTarget: MarkdownOutlineTarget | null;
  clearMarkdownOutlineTarget: () => void;
  showNotification: (message: string, type?: "info" | "error" | "success") => void;
}

export interface EditorModeAdapter {
  id: string;
  match: (tab: FileTab) => boolean;
  render: (context: EditorModeContext) => ReactNode;
}

function decodeHexPreview(content: string) {
  const parsed = parseHexView(content);
  if (parsed.error || !parsed.bytes) {
    return {
      text: "",
      byteLength: 0,
      error: parsed.error ?? "当前十六进制内容无法解析。",
    };
  }

  return {
    text: bytesToAsciiView(parsed.bytes),
    byteLength: parsed.bytes.length,
    error: null as string | null,
  };
}

function countHexDigits(text: string) {
  const matches = text.match(/[0-9A-Fa-f]/g);
  return matches ? matches.length : 0;
}

function getSelectedByteRange(
  text: string,
  startOffset: number,
  endOffset: number,
) {
  const startHexDigits = countHexDigits(text.slice(0, startOffset));
  const endHexDigits = countHexDigits(text.slice(0, endOffset));
  const startByte = Math.floor(startHexDigits / 2);
  const endByte = Math.ceil(endHexDigits / 2);

  if (endByte <= startByte) {
    return null;
  }

  return { startByte, endByte };
}

function byteIndexToAsciiPosition(byteIndex: number) {
  return {
    lineNumber: Math.floor(byteIndex / 16) + 1,
    column: (byteIndex % 16) + 1,
  };
}

function usePreviewResource(
  activeTab: FileTab,
  showNotification: EditorModeContext["showNotification"],
) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
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
        if (isCancelled) {
          return;
        }

        const message = activeTab.language === "pdf"
          ? "当前文件没有读取权限，或文件内容无法作为 PDF 打开"
          : "当前预览资源加载失败";
        setPreviewUrl(null);
        setPreviewError(message);
        if (activeTab.language === "pdf") {
          showNotification(`PDF 加载失败: ${message}`, "error");
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
  }, [activeTab.language, activeTab.path, showNotification]);

  return { previewUrl, previewError };
}

function ImageModeView({
  activeTab,
  showNotification,
}: Pick<EditorModeContext, "activeTab" | "showNotification">) {
  const { previewUrl } = usePreviewResource(activeTab, showNotification);

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

function PdfModeView({
  activeTab,
  showNotification,
}: Pick<EditorModeContext, "activeTab" | "showNotification">) {
  const { previewUrl, previewError } = usePreviewResource(activeTab, showNotification);

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

function WordModeView({
  activeTab,
  showNotification,
}: Pick<EditorModeContext, "activeTab" | "showNotification">) {
  return (
    <WordPreview
      name={activeTab.name}
      path={activeTab.path}
      showNotification={showNotification}
    />
  );
}

function useMarkdownComponents(activeTab: FileTab) {
  return useMemo<Components | undefined>(() => {
    if (activeTab.language !== "markdown") {
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
  }, [activeTab.content, activeTab.language]);
}

interface MarkdownPreviewPaneProps {
  activeTab: FileTab;
  markdownOutlineTarget: MarkdownOutlineTarget | null;
  clearMarkdownOutlineTarget: () => void;
  showNotification: EditorModeContext["showNotification"];
  contextMenuItems: SharedContextMenuItem[];
  wrapperClassName: string;
  contentClassName: string;
  syncOutlineTarget?: boolean;
}

function MarkdownPreviewPane({
  activeTab,
  markdownOutlineTarget,
  clearMarkdownOutlineTarget,
  showNotification,
  contextMenuItems,
  wrapperClassName,
  contentClassName,
  syncOutlineTarget = true,
}: MarkdownPreviewPaneProps) {
  const markdownPreviewRef = useRef<HTMLDivElement>(null);
  const [previewContextMenu, setPreviewContextMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
  } | null>(null);
  const markdownComponents = useMarkdownComponents(activeTab);

  useEffect(() => {
    if (
      !syncOutlineTarget ||
      !markdownOutlineTarget ||
      activeTab.id !== markdownOutlineTarget.tabId ||
      activeTab.language !== "markdown"
    ) {
      return;
    }

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
  }, [
    activeTab.id,
    activeTab.language,
    clearMarkdownOutlineTarget,
    markdownOutlineTarget,
    syncOutlineTarget,
  ]);

  useEffect(() => {
    setPreviewContextMenu(null);
  }, [activeTab.id, contextMenuItems]);

  const getPreviewSelectionText = useCallback(() => {
    const container = markdownPreviewRef.current;
    const selection = window.getSelection();
    if (!container || !selection || selection.rangeCount === 0) {
      return "";
    }

    const range = selection.getRangeAt(0);
    const commonAncestor = range.commonAncestorContainer;
    if (!container.contains(commonAncestor)) {
      return "";
    }

    return selection.toString().trim();
  }, []);

  const handlePreviewContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setPreviewContextMenu({
      x: event.clientX,
      y: event.clientY,
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

  const previewContextMenuItems = useMemo<SharedContextMenuItem[]>(() => {
    const items: SharedContextMenuItem[] = [...contextMenuItems];

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
  }, [contextMenuItems, handleCopyFromPreview, previewContextMenu?.hasSelection]);

  return (
    <div
      ref={markdownPreviewRef}
      className={wrapperClassName}
      onContextMenu={handlePreviewContextMenu}
    >
      <div className={contentClassName}>
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
    </div>
  );
}

function MarkdownPreviewModeView({
  activeTab,
  togglePreviewMode,
  markdownOutlineTarget,
  clearMarkdownOutlineTarget,
  showNotification,
}: Pick<
  EditorModeContext,
  | "activeTab"
  | "togglePreviewMode"
  | "markdownOutlineTarget"
  | "clearMarkdownOutlineTarget"
  | "showNotification"
>) {
  const previewContextMenuItems = useMemo<SharedContextMenuItem[]>(() => [
    {
      label: "切换到编辑模式",
      icon: <FilePenLine size={14} />,
      onClick: () => togglePreviewMode(activeTab.id),
    },
  ], [activeTab.id, togglePreviewMode]);

  return (
    <>
      <MarkdownPreviewPane
        activeTab={activeTab}
        markdownOutlineTarget={markdownOutlineTarget}
        clearMarkdownOutlineTarget={clearMarkdownOutlineTarget}
        showNotification={showNotification}
        contextMenuItems={previewContextMenuItems}
        wrapperClassName="h-full overflow-auto p-8 bg-primary markdown-preview prose max-w-none relative"
        contentClassName="mx-auto max-w-4xl"
      />
      <button
        onClick={() => togglePreviewMode(activeTab.id)}
        className="fixed bottom-8 right-8 p-3 rounded-full bg-accent text-white shadow-lg hover:bg-accent-bright transition-colors z-50 group"
        title="切换到编辑模式"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </button>
    </>
  );
}

function Base64ModeView({
  activeTab,
  onChange,
  onEditorMount,
  applyTheme,
}: Pick<EditorModeContext, "activeTab" | "onChange" | "onEditorMount" | "applyTheme">) {
  const asciiEditorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const asciiDecorationIdsRef = useRef<string[]>([]);
  const [linkedByteRange, setLinkedByteRange] = useState<{
    startByte: number;
    endByte: number;
  } | null>(null);
  const base64Preview = useMemo(() => decodeHexPreview(activeTab.content), [activeTab.content]);

  const syncAsciiSelectionHighlight = useCallback((nextRange: {
    startByte: number;
    endByte: number;
  } | null) => {
    const asciiEditor = asciiEditorRef.current;
    const monaco = monacoRef.current;

    if (!asciiEditor || !monaco) {
      return;
    }

    if (!nextRange) {
      asciiDecorationIdsRef.current = asciiEditor.deltaDecorations(
        asciiDecorationIdsRef.current,
        [],
      );
      return;
    }

    const start = byteIndexToAsciiPosition(nextRange.startByte);
    const end = byteIndexToAsciiPosition(nextRange.endByte);

    asciiDecorationIdsRef.current = asciiEditor.deltaDecorations(
      asciiDecorationIdsRef.current,
      [
        {
          range: new monaco.Range(
            start.lineNumber,
            start.column,
            end.lineNumber,
            end.column,
          ),
          options: {
            inlineClassName: "ascii-linked-selection",
            inlineClassNameAffectsLetterSpacing: true,
          },
        },
      ],
    );

    asciiEditor.revealLineInCenterIfOutsideViewport(start.lineNumber);
  }, []);

  useEffect(() => {
    if (base64Preview.error) {
      syncAsciiSelectionHighlight(null);
      return;
    }

    syncAsciiSelectionHighlight(linkedByteRange);
  }, [base64Preview.error, base64Preview.text, linkedByteRange, syncAsciiSelectionHighlight]);

  useEffect(() => {
    setLinkedByteRange(null);
    if (asciiEditorRef.current) {
      asciiDecorationIdsRef.current = asciiEditorRef.current.deltaDecorations(
        asciiDecorationIdsRef.current,
        [],
      );
    }
  }, [activeTab.id]);

  return (
    <div className="flex h-full bg-primary">
      <div className="flex min-w-0 flex-1 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border bg-surface/40 px-3 py-2 text-xs text-text-secondary">
          <span className="font-medium uppercase tracking-wider text-text">Hex</span>
          <span>每行 16 字节，4 字节分组</span>
        </div>
        <div className="min-h-0 flex-1">
          <MonacoEditor
            key={`${activeTab.id}:base64`}
            theme="terracotta-dark"
            language={activeTab.language}
            value={activeTab.content}
            onChange={onChange}
            onMount={(editor, monaco) => {
              applyTheme(monaco);
              monacoRef.current = monaco;
              onEditorMount(editor, monaco);
              editor.onDidChangeCursorSelection((event) => {
                const model = editor.getModel();
                const selection = event.selection;
                if (!model || !selection || selection.isEmpty()) {
                  setLinkedByteRange(null);
                  return;
                }

                const startOffset = model.getOffsetAt(selection.getStartPosition());
                const endOffset = model.getOffsetAt(selection.getEndPosition());
                setLinkedByteRange(
                  getSelectedByteRange(model.getValue(), startOffset, endOffset),
                );
              });
            }}
            options={{
              fontSize: 14,
              fontFamily: "var(--font-mono)",
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              lineNumbers: getHexOffsetLabel,
              lineNumbersMinChars: 6,
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
              wordWrap: "off",
              readOnly: false,
            } satisfies EditorProps["options"]}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border bg-surface/20 px-3 py-2 text-xs text-text-secondary">
          <span className="font-medium uppercase tracking-wider text-text">Ascii</span>
          <span>
            {base64Preview.error
              ? "解析失败"
              : linkedByteRange
                ? `选中 ${(linkedByteRange.endByte - linkedByteRange.startByte).toLocaleString()} B`
                : `${base64Preview.byteLength.toLocaleString()} B`}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          {base64Preview.error ? (
            <div className="flex h-full items-center justify-center bg-deepest p-6">
              <div className="max-w-md rounded-xl border border-error/30 bg-error/5 px-4 py-3 text-sm leading-relaxed text-error">
                {base64Preview.error}
              </div>
            </div>
          ) : (
            <MonacoEditor
              key={`${activeTab.id}:decoded`}
              theme="terracotta-dark"
              language="plaintext"
              value={base64Preview.text}
              onMount={(editor, monaco) => {
                asciiEditorRef.current = editor;
                monacoRef.current = monaco;
                applyTheme(monaco);
              }}
              options={{
                fontSize: 14,
                fontFamily: "var(--font-mono)",
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                lineNumbers: "off",
                renderLineHighlight: "none",
                smoothScrolling: true,
                padding: { top: 12 },
                automaticLayout: true,
                contextmenu: false,
                tabSize: 2,
                wordWrap: "off",
                readOnly: true,
              } satisfies EditorProps["options"]}
            />
          )}
        </div>
      </div>
    </div>
  );
}

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
  const editor = (
    <MonacoEditor
      key={activeTab.id}
      theme="terracotta-dark"
      language={activeTab.language}
      value={activeTab.content}
      onChange={onChange}
      onMount={(editor, monaco) => {
        applyTheme(monaco);
        onEditorMount(editor, monaco);
      }}
      options={{
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
        wordWrap: editorWordWrap ? "on" : "off",
        readOnly: activeTab.isReadOnly ?? false,
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
          <div className="flex items-center justify-between border-b border-border bg-surface/30 px-4 py-2 text-xs text-text-secondary">
            <span className="font-medium text-text-primary">实时预览</span>
            <button
              type="button"
              onClick={() => toggleLivePreviewMode(activeTab.id)}
              className="rounded-md px-2 py-1 text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
            >
              关闭
            </button>
          </div>
          <MarkdownPreviewPane
            activeTab={activeTab}
            markdownOutlineTarget={markdownOutlineTarget}
            clearMarkdownOutlineTarget={clearMarkdownOutlineTarget}
            showNotification={showNotification}
            contextMenuItems={previewContextMenuItems}
            wrapperClassName="min-h-0 flex-1 overflow-auto p-6 markdown-preview prose max-w-none relative"
            contentClassName="mx-auto max-w-3xl"
            syncOutlineTarget={false}
          />
        </div>
      </div>
    );
  }

  return editor;
}

const imageMode: EditorModeAdapter = {
  id: "image",
  match: (tab) => tab.language === "image",
  render: (context) => (
    <ImageModeView
      activeTab={context.activeTab}
      showNotification={context.showNotification}
    />
  ),
};

const pdfMode: EditorModeAdapter = {
  id: "pdf",
  match: (tab) => tab.language === "pdf",
  render: (context) => (
    <PdfModeView
      activeTab={context.activeTab}
      showNotification={context.showNotification}
    />
  ),
};

const wordMode: EditorModeAdapter = {
  id: "word",
  match: (tab) => tab.language === "word",
  render: (context) => (
    <WordModeView
      activeTab={context.activeTab}
      showNotification={context.showNotification}
    />
  ),
};

const markdownPreviewMode: EditorModeAdapter = {
  id: "markdown-preview",
  match: (tab) => tab.language === "markdown" && Boolean(tab.isPreviewMode),
  render: (context) => (
    <MarkdownPreviewModeView
      activeTab={context.activeTab}
      togglePreviewMode={context.togglePreviewMode}
      markdownOutlineTarget={context.markdownOutlineTarget}
      clearMarkdownOutlineTarget={context.clearMarkdownOutlineTarget}
      showNotification={context.showNotification}
    />
  ),
};

const base64Mode: EditorModeAdapter = {
  id: "base64",
  match: (tab) => tab.viewMode === "base64",
  render: (context) => (
    <Base64ModeView
      activeTab={context.activeTab}
      onChange={context.onChange}
      onEditorMount={context.onEditorMount}
      applyTheme={context.applyTheme}
    />
  ),
};

const textMode: EditorModeAdapter = {
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

export const editorModes: EditorModeAdapter[] = [
  imageMode,
  pdfMode,
  wordMode,
  markdownPreviewMode,
  base64Mode,
  textMode,
];

export function resolveEditorMode(tab: FileTab) {
  return editorModes.find((mode) => mode.match(tab)) ?? textMode;
}
