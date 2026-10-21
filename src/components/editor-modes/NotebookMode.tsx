/**
 * Jupyter Notebook 模式 - 单元格列表 + Monaco 编辑 + 输出渲染
 *
 * 只负责读写 .ipynb 文件内容（结构、源码、已有输出），不启动 Python 内核，
 * 因此不提供“运行单元格”。单元格对象常驻 notebookDocs 缓存，切标签/分屏不丢改动。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import MonacoEditor from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowDown,
  ArrowUp,
  Code2,
  Eraser,
  Eye,
  FileCode2,
  Info,
  Loader2,
  Plus,
  Trash2,
  Type,
} from "lucide-react";
import { useEditorStore } from "@/store/editor";
import {
  clearAllNotebookOutputs,
  clearNotebookOutputs,
  insertNotebookCell,
  loadNotebookDoc,
  moveNotebookCell,
  notebookKernelLabel,
  notebookLanguage,
  parseAnsi,
  removeNotebookCell,
  setNotebookCellType,
  updateNotebookCellSource,
  type NotebookCell,
  type NotebookCellType,
  type NotebookDoc,
  type NotebookOutputJson,
} from "@/services/notebookDocs";
import type { EditorModeAdapter, EditorModeContext } from "./types";

type MonacoEditorInstance = Parameters<OnMount>[0];
type MonacoApi = Parameters<OnMount>[1];

const MIN_EDITOR_HEIGHT = 34;

const NOTEBOOK_EDITOR_OPTIONS = {
  fontSize: 12.5,
  fontFamily: "var(--font-mono)",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  lineNumbers: "on",
  lineNumbersMinChars: 2,
  lineDecorationsWidth: 6,
  renderLineHighlight: "none",
  folding: false,
  glyphMargin: false,
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  automaticLayout: true,
  tabSize: 4,
  padding: { top: 8, bottom: 8 },
  scrollbar: {
    vertical: "auto",
    horizontal: "auto",
    alwaysConsumeMouseWheel: false,
    verticalScrollbarSize: 8,
    horizontalScrollbarSize: 8,
  },
  // 单元格是“内嵌小编辑器”，补全弹层不能被 overflow 容器裁掉
  fixedOverflowWidgets: true,
  suggest: { showWords: true },
} as const;

interface NotebookCellEditorProps {
  cellId: string;
  initialValue: string;
  language: string;
  readOnly: boolean;
  wordWrap: boolean;
  applyTheme: (monaco: MonacoApi) => void;
  onSourceChange: (cellId: string, value: string) => void;
  onSave: () => void;
  onReady: (cellId: string, editor: MonacoEditorInstance) => void;
}

/** 单个单元格的 Monaco 编辑器：按内容行数自动增高，不出现内部滚动条 */
const NotebookCellEditor = memo(function NotebookCellEditor({
  cellId,
  initialValue,
  language,
  readOnly,
  wordWrap,
  applyTheme,
  onSourceChange,
  onSave,
  onReady,
}: NotebookCellEditorProps) {
  const [height, setHeight] = useState(MIN_EDITOR_HEIGHT);

  const options = useMemo(
    () => ({
      ...NOTEBOOK_EDITOR_OPTIONS,
      readOnly,
      wordWrap: wordWrap ? ("on" as const) : ("off" as const),
      // 换行按真实字宽计算，避免中英混排时折行偏宽冒出横向滚动条
      wrappingStrategy: wordWrap ? ("advanced" as const) : ("simple" as const),
    }),
    [readOnly, wordWrap],
  );

  return (
    <MonacoEditor
      height={height}
      language={language}
      theme="terracotta-dark"
      defaultValue={initialValue}
      onChange={(next) => onSourceChange(cellId, next ?? "")}
      onMount={(editor, monaco) => {
        applyTheme(monaco);
        const syncHeight = () =>
          setHeight(Math.max(editor.getContentHeight(), MIN_EDITOR_HEIGHT));
        syncHeight();
        const disposable = editor.onDidContentSizeChange(syncHeight);
        editor.onDidDispose(() => disposable.dispose());
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave());
        onReady(cellId, editor);
      }}
      options={options}
    />
  );
});

/** 渲染 traceback / stdout 里的 ANSI 颜色 */
function AnsiText({ text, className }: { text: string; className?: string }) {
  const spans = useMemo(() => parseAnsi(text), [text]);
  return (
    <pre className={className}>
      {spans.map((span, index) => (
        <span
          key={index}
          style={{ color: span.color, fontWeight: span.bold ? 600 : undefined }}
        >
          {span.text}
        </span>
      ))}
    </pre>
  );
}

function joinMimeText(value: unknown): string {
  if (Array.isArray(value)) return value.map((line) => String(line)).join("");
  return value == null ? "" : String(value);
}

/** nbformat 的 traceback 每行通常自带换行；不自带时补 \n，避免粘成一行 */
function joinTraceback(lines: string[]): string {
  if (lines.length === 0) return "";
  return lines.join(lines.every((line) => line.endsWith("\n")) ? "" : "\n");
}

/** text/html 输出：sandbox 里不允许脚本，同源后测量高度自适应 */
function HtmlOutput({ html }: { html: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(60);

  const measure = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    try {
      const body = frame.contentDocument?.body;
      if (!body) return;
      setHeight(Math.min(Math.max(body.scrollHeight + 8, 24), 900));
    } catch {
      // 某些 WebView 下取不到 document，保持默认高度
    }
  }, []);

  return (
    <iframe
      ref={frameRef}
      title="Notebook HTML 输出"
      sandbox="allow-same-origin"
      srcDoc={html}
      onLoad={() => requestAnimationFrame(measure)}
      style={{ height }}
      className="w-full rounded-lg border border-border bg-white"
    />
  );
}

const MIME_PRIORITY = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "text/html",
  "text/markdown",
  "application/json",
  "text/latex",
  "text/plain",
] as const;

function renderMimeValue(
  mime: string,
  value: unknown,
  onImageClick: (url: string) => void,
) {
  if (mime.startsWith("image/")) {
    const url =
      mime === "image/svg+xml"
        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(joinMimeText(value))}`
        : `data:${mime};base64,${joinMimeText(value)}`;
    return (
      <button
        type="button"
        onClick={() => onImageClick(url)}
        title="点击查看大图"
        className="block max-w-full cursor-zoom-in"
      >
        <img
          src={url}
          alt="Notebook 输出图片"
          className="max-h-[420px] max-w-full rounded-lg border border-border bg-white object-contain"
        />
      </button>
    );
  }

  if (mime === "text/html") {
    return <HtmlOutput html={joinMimeText(value)} />;
  }

  if (mime === "application/json") {
    const pretty = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-primary">
        {pretty}
      </pre>
    );
  }

  if (mime === "text/markdown") {
    return (
      <div className="markdown-preview px-1 py-0.5">
        <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(uri) => uri}>
          {joinMimeText(value)}
        </ReactMarkdown>
      </div>
    );
  }

  if (mime === "text/latex") {
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-secondary">
        {joinMimeText(value)}
      </pre>
    );
  }

  return (
    <AnsiText
      text={joinMimeText(value)}
      className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-primary"
    />
  );
}

/** 一个输出块：流输出 / 执行结果 / 展示数据 / 错误 */
function NotebookOutputView({
  output,
  onImageClick,
}: {
  output: NotebookOutputJson;
  onImageClick: (url: string) => void;
}) {
  const outputType = typeof output.output_type === "string" ? output.output_type : "";

  if (outputType === "stream") {
    const text = joinMimeText(output.text);
    if (!text) return null;
    const isStderr = output.name === "stderr";
    return (
      <div
        className={`rounded-lg border px-3 py-2 ${
          isStderr ? "border-error/25 bg-error/5" : "border-border bg-surface/20"
        }`}
      >
        <AnsiText
          text={text}
          className={`whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed ${
            isStderr ? "text-error" : "text-text-primary"
          }`}
        />
      </div>
    );
  }

  if (outputType === "error") {
    const traceback = Array.isArray(output.traceback)
      ? joinTraceback(output.traceback.map((line) => String(line)))
      : `${output.ename ?? "Error"}: ${output.evalue ?? ""}`;
    return (
      <div className="rounded-lg border border-error/25 bg-error/5 px-3 py-2">
        <AnsiText
          text={traceback}
          className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-error"
        />
      </div>
    );
  }

  if (outputType === "execute_result" || outputType === "display_data") {
    const data = output.data;
    if (!data || typeof data !== "object") return null;
    const mime = MIME_PRIORITY.find((key) => data[key] !== undefined);
    if (!mime) return null;
    return (
      <div className="rounded-lg border border-border bg-surface/20 px-3 py-2">
        {renderMimeValue(mime, data[mime], onImageClick)}
      </div>
    );
  }

  return null;
}

/** cell.attachments → { 名字: { mime: base64 } }，只保留字符串值 */
function readCellAttachments(cell: NotebookCell) {
  const value = cell.raw.attachments;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const attachments: Record<string, Record<string, string>> = {};
  for (const [name, bundle] of Object.entries(value as Record<string, unknown>)) {
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) continue;
    const mimes: Record<string, string> = {};
    for (const [mime, data] of Object.entries(bundle as Record<string, unknown>)) {
      if (typeof data === "string") mimes[mime] = data;
    }
    attachments[name] = mimes;
  }
  return Object.keys(attachments).length > 0 ? attachments : undefined;
}

/** Markdown 单元格的渲染结果（双击进入编辑） */
function NotebookMarkdownCell({
  source,
  attachments,
}: {
  source: string;
  attachments?: Record<string, Record<string, string>>;
}) {
  const components = useMemo(
    () => ({
      a: function LinkRenderer({
        href,
        children,
        ...props
      }: React.ComponentPropsWithoutRef<"a">) {
        return (
          <a
            {...props}
            href={href}
            onClick={(event) => {
              if (!href || href.startsWith("#")) return;
              event.preventDefault();
              void openUrl(href);
            }}
          >
            {children}
          </a>
        );
      },
      // Jupyter 把粘贴的图片存在 cell.attachments 里，用 ![](attachment:名字) 引用
      img: function ImageRenderer({
        src,
        alt,
        node: _node,
        ...props
      }: React.ComponentPropsWithoutRef<"img"> & { node?: unknown }) {
        if (src && src.startsWith("attachment:")) {
          const name = decodeURIComponent(src.slice("attachment:".length));
          const bundle = attachments?.[name];
          const mime = bundle ? Object.keys(bundle)[0] : undefined;
          if (bundle && mime) {
            const url =
              mime === "image/svg+xml"
                ? `data:${mime};charset=utf-8,${encodeURIComponent(bundle[mime])}`
                : `data:${mime};base64,${bundle[mime]}`;
            return <img {...props} src={url} alt={alt ?? ""} />;
          }
          return alt ? <span>{alt}</span> : null;
        }
        return <img {...props} src={src} alt={alt ?? ""} />;
      },
    }),
    [attachments],
  );

  if (!source.trim()) {
    return (
      <p className="px-4 py-3 text-xs text-text-muted/85">
        空 Markdown 单元格（双击编辑）
      </p>
    );
  }

  return (
    <div className="markdown-preview px-4 py-3">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={(uri) => uri}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

function ToolbarButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="flex h-5 w-5 items-center justify-center rounded text-text-muted/85 transition-colors hover:bg-hover hover:text-accent disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function NotebookModeView({
  activeTab,
  editorWordWrap,
  applyTheme,
  showNotification,
  saveActiveTab,
}: Pick<
  EditorModeContext,
  "activeTab" | "editorWordWrap" | "applyTheme" | "showNotification" | "saveActiveTab"
>) {
  const markTabDirty = useEditorStore((state) => state.markTabDirty);
  const openImagePreview = useEditorStore((state) => state.openImagePreview);
  const [doc, setDoc] = useState<NotebookDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, bumpVersion] = useState(0);
  const [editingMarkdownId, setEditingMarkdownId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const editorsRef = useRef(new Map<string, MonacoEditorInstance>());
  const pendingFocusRef = useRef<string | null>(null);
  const revision = activeTab.revision ?? 0;
  const isReadOnly = Boolean(activeTab.isReadOnly);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setDoc(null);
    setEditingMarkdownId(null);
    editorsRef.current.clear();

    void loadNotebookDoc(activeTab.id, activeTab.path, revision)
      .then((loaded) => {
        if (cancelled) return;
        setDoc(loaded);
        bumpVersion((version) => version + 1);
      })
      .catch((err) => {
        if (cancelled) return;
        const detail = err instanceof Error ? err.message : String(err);
        setError(detail || "无法解析该 Notebook 文件");
        showNotification(`Notebook 加载失败: ${detail}`, "error");
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab.id, activeTab.path, revision, showNotification]);

  /** 结构类改动（增删/移动/改类型/清输出）后重绘列表并标脏 */
  const commitChange = useCallback(() => {
    markTabDirty(activeTab.id);
    bumpVersion((version) => version + 1);
  }, [activeTab.id, markTabDirty]);

  const handleSourceChange = useCallback(
    (cellId: string, value: string) => {
      if (!doc) return;
      // 每个按键都会走到这里：只更新缓存 + 标脏，不触发整页重绘（Monaco 自己持有文本）
      if (!updateNotebookCellSource(doc, cellId, value)) return;
      markTabDirty(activeTab.id);
    },
    [activeTab.id, doc, markTabDirty],
  );

  const handleSave = useCallback(() => {
    void saveActiveTab(activeTab.id);
  }, [activeTab.id, saveActiveTab]);

  const handleEditorReady = useCallback((cellId: string, editor: MonacoEditorInstance) => {
    editorsRef.current.set(cellId, editor);
    if (pendingFocusRef.current === cellId) {
      pendingFocusRef.current = null;
      editor.focus();
    }
  }, []);

  const scrollCellIntoView = useCallback((cellId: string) => {
    requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector(`[data-cell-id="${cellId}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }, []);

  const handleAddCell = useCallback(
    (index: number, cellType: NotebookCellType) => {
      if (!doc || isReadOnly) return;
      const cell = insertNotebookCell(doc, index, cellType);
      setEditingMarkdownId(cellType === "markdown" ? cell.id : null);
      // 新增的单元格挂载后自动聚焦（Markdown 单元格也会先进入编辑态）
      pendingFocusRef.current = cell.id;
      commitChange();
      scrollCellIntoView(cell.id);
    },
    [commitChange, doc, isReadOnly, scrollCellIntoView],
  );

  const handleDeleteCell = useCallback(
    (cellId: string) => {
      if (!doc || isReadOnly) return;
      removeNotebookCell(doc, cellId);
      editorsRef.current.delete(cellId);
      if (editingMarkdownId === cellId) setEditingMarkdownId(null);
      commitChange();
    },
    [commitChange, doc, editingMarkdownId, isReadOnly],
  );

  const handleMoveCell = useCallback(
    (cellId: string, delta: number) => {
      if (!doc || isReadOnly) return;
      if (moveNotebookCell(doc, cellId, delta) === -1) return;
      commitChange();
    },
    [commitChange, doc, isReadOnly],
  );

  const handleToggleType = useCallback(
    (cell: NotebookCell) => {
      if (!doc || isReadOnly) return;
      const next: NotebookCellType = cell.cellType === "code" ? "markdown" : "code";
      if (!setNotebookCellType(doc, cell.id, next)) return;
      if (editingMarkdownId === cell.id) setEditingMarkdownId(null);
      commitChange();
    },
    [commitChange, doc, editingMarkdownId, isReadOnly],
  );

  const handleClearOutputs = useCallback(
    (cellId: string) => {
      if (!doc || isReadOnly) return;
      if (!clearNotebookOutputs(doc, cellId)) return;
      commitChange();
    },
    [commitChange, doc, isReadOnly],
  );

  const handleClearAllOutputs = useCallback(() => {
    if (!doc || isReadOnly) return;
    const cleared = clearAllNotebookOutputs(doc);
    if (cleared === 0) {
      showNotification("没有可清除的输出", "info");
      return;
    }
    commitChange();
  }, [commitChange, doc, isReadOnly, showNotification]);

  const handleImageClick = useCallback(
    (url: string) => {
      openImagePreview({
        path: `${activeTab.path}#notebook-output`,
        name: `${activeTab.name} 输出`,
        url,
      });
    },
    [activeTab.name, activeTab.path, openImagePreview],
  );

  const handleRootKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveActiveTab(activeTab.id);
      }
    },
    [activeTab.id, saveActiveTab],
  );

  const language = doc ? notebookLanguage(doc) : "python";
  const kernelLabel = doc ? notebookKernelLabel(doc) : "";
  const outputCount = doc
    ? doc.cells.reduce((total, cell) => total + (cell.outputs.length > 0 ? 1 : 0), 0)
    : 0;

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-deepest p-6">
        <div className="max-w-md rounded-xl border border-error/30 bg-error/5 px-4 py-3 text-sm leading-relaxed text-error">
          {error}
        </div>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-deepest text-text-muted">
        <Loader2 size={20} className="animate-spin" />
        <span className="text-xs">正在解析 Notebook...</span>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={handleRootKeyDown}
      className="flex h-full min-h-0 flex-col bg-primary outline-none"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface/20 px-3 py-1.5">
        <FileCode2 size={14} className="shrink-0 text-accent" />
        <span className="max-w-[220px] truncate text-xs font-medium text-text-primary">
          {activeTab.name}
        </span>
        <span className="shrink-0 text-[10px] text-text-muted">
          {doc.cells.length} 个单元格 · {kernelLabel}
        </span>
        {isReadOnly && <span className="shrink-0 text-[10px] text-text-muted">只读</span>}
        <span
          className="shrink-0 cursor-help text-text-muted/85"
          title="这里只读写 .ipynb 文件内容，不会启动 Python 内核；需要执行代码请用 Jupyter / Tern 打开，执行结果会随文件一起显示。"
        >
          <Info size={12} />
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={isReadOnly}
            onClick={() => handleAddCell(doc.cells.length, "code")}
            title="在末尾添加代码单元格"
            className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-accent/50 hover:text-accent disabled:opacity-40"
          >
            <Plus size={11} />
            <Code2 size={11} />
            代码
          </button>
          <button
            type="button"
            disabled={isReadOnly}
            onClick={() => handleAddCell(doc.cells.length, "markdown")}
            title="在末尾添加 Markdown 单元格"
            className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-accent/50 hover:text-accent disabled:opacity-40"
          >
            <Plus size={11} />
            <Type size={11} />
            文本
          </button>
          {outputCount > 0 && (
            <button
              type="button"
              disabled={isReadOnly}
              onClick={handleClearAllOutputs}
              title="清空所有单元格的输出"
              className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-accent/50 hover:text-accent disabled:opacity-40"
            >
              <Eraser size={11} />
              清空输出
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-4">
          {doc.cells.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
              <FileCode2 size={28} className="text-accent/70" />
              <p className="text-sm text-text-secondary">这个 Notebook 还没有单元格</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isReadOnly}
                  onClick={() => handleAddCell(0, "code")}
                  className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-accent/50 hover:text-accent disabled:opacity-40"
                >
                  <Plus size={12} />
                  添加代码单元格
                </button>
                <button
                  type="button"
                  disabled={isReadOnly}
                  onClick={() => handleAddCell(0, "markdown")}
                  className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-accent/50 hover:text-accent disabled:opacity-40"
                >
                  <Plus size={12} />
                  添加 Markdown 单元格
                </button>
              </div>
            </div>
          )}

          {doc.cells.map((cell, index) => {
            const isMarkdownEditing =
              cell.cellType === "markdown" && editingMarkdownId === cell.id;
            return (
              <div
                key={cell.id}
                data-cell-id={cell.id}
                className="group/cell flex gap-2.5"
              >
                <div className="w-11 shrink-0 select-none pt-2.5 text-right font-mono text-[11px] text-text-muted/85">
                  {cell.cellType === "code" ? `[${cell.executionCount ?? " "}]:` : ""}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="relative rounded-xl border border-border bg-surface/20 transition-colors focus-within:border-accent/50">
                    <div className="absolute -top-3 right-2 z-10 flex items-center gap-0.5 rounded-md border border-border bg-primary px-0.5 py-0.5 opacity-0 shadow-sm transition-opacity group-hover/cell:opacity-100 focus-within:opacity-100">
                      <ToolbarButton
                        title="上移单元格"
                        disabled={isReadOnly || index === 0}
                        onClick={() => handleMoveCell(cell.id, -1)}
                      >
                        <ArrowUp size={12} />
                      </ToolbarButton>
                      <ToolbarButton
                        title="下移单元格"
                        disabled={isReadOnly || index === doc.cells.length - 1}
                        onClick={() => handleMoveCell(cell.id, 1)}
                      >
                        <ArrowDown size={12} />
                      </ToolbarButton>
                      <ToolbarButton
                        title={
                          cell.cellType === "code"
                            ? "转为 Markdown 单元格"
                            : "转为代码单元格"
                        }
                        disabled={isReadOnly}
                        onClick={() => handleToggleType(cell)}
                      >
                        {cell.cellType === "code" ? <Type size={12} /> : <Code2 size={12} />}
                      </ToolbarButton>
                      {cell.outputs.length > 0 && (
                        <ToolbarButton
                          title="清除该单元格的输出"
                          disabled={isReadOnly}
                          onClick={() => handleClearOutputs(cell.id)}
                        >
                          <Eraser size={12} />
                        </ToolbarButton>
                      )}
                      {isMarkdownEditing && (
                        <ToolbarButton
                          title="完成编辑（回到预览）"
                          onClick={() => setEditingMarkdownId(null)}
                        >
                          <Eye size={12} />
                        </ToolbarButton>
                      )}
                      <ToolbarButton
                        title="在下方插入代码单元格"
                        disabled={isReadOnly}
                        onClick={() => handleAddCell(index + 1, "code")}
                      >
                        <Plus size={12} />
                      </ToolbarButton>
                      <ToolbarButton
                        title="删除单元格"
                        disabled={isReadOnly}
                        onClick={() => handleDeleteCell(cell.id)}
                      >
                        <Trash2 size={12} />
                      </ToolbarButton>
                    </div>

                    {cell.cellType === "markdown" && !isMarkdownEditing ? (
                      <div
                        onDoubleClick={() => {
                          if (!isReadOnly) setEditingMarkdownId(cell.id);
                        }}
                        title={isReadOnly ? undefined : "双击编辑该 Markdown 单元格"}
                        className={isReadOnly ? undefined : "cursor-text"}
                      >
                        <NotebookMarkdownCell
                          source={cell.source}
                          attachments={readCellAttachments(cell)}
                        />
                      </div>
                    ) : (
                      <NotebookCellEditor
                        cellId={cell.id}
                        initialValue={cell.source}
                        language={
                          cell.cellType === "code"
                            ? language
                            : cell.cellType === "markdown"
                              ? "markdown"
                              : "plaintext"
                        }
                        readOnly={isReadOnly}
                        wordWrap={editorWordWrap}
                        applyTheme={applyTheme}
                        onSourceChange={handleSourceChange}
                        onSave={handleSave}
                        onReady={handleEditorReady}
                      />
                    )}
                  </div>

                  {cell.outputs.length > 0 && (
                    <div className="mt-2 flex flex-col gap-2">
                      {cell.outputs.map((output, outputIndex) => (
                        <NotebookOutputView
                          key={`${cell.id}-out-${outputIndex}`}
                          output={output}
                          onImageClick={handleImageClick}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {doc.cells.length > 0 && (
            <div className="flex justify-center gap-2 pt-1 opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100">
              <button
                type="button"
                disabled={isReadOnly}
                onClick={() => handleAddCell(doc.cells.length, "code")}
                className="flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1 text-[11px] text-text-muted transition-colors hover:border-accent/50 hover:text-accent disabled:opacity-40"
              >
                <Plus size={11} />
                代码单元格
              </button>
              <button
                type="button"
                disabled={isReadOnly}
                onClick={() => handleAddCell(doc.cells.length, "markdown")}
                className="flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1 text-[11px] text-text-muted transition-colors hover:border-accent/50 hover:text-accent disabled:opacity-40"
              >
                <Plus size={11} />
                Markdown 单元格
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const notebookMode: EditorModeAdapter = {
  id: "notebook",
  match: (tab) => tab.language === "notebook",
  render: (context) => (
    <NotebookModeView
      activeTab={context.activeTab}
      editorWordWrap={context.editorWordWrap}
      applyTheme={context.applyTheme}
      showNotification={context.showNotification}
      saveActiveTab={context.saveActiveTab}
    />
  ),
};
