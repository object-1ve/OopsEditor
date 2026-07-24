import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";
import MonacoEditor, { type EditorProps, type OnMount } from "@monaco-editor/react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import { Copy, FilePenLine, Database, Table, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
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
import {
  getMonacoViewState,
  getPreviewScrollTop,
  setMonacoViewState,
  setPreviewScrollTop,
} from "../../utils/scrollMemory";
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
  const lineOffset = byteIndex % 16;
  // 4字符一组，组内紧密，组间双空格
  // 组0: cols 1-4, 组1: cols 7-10, 组2: cols 13-16, 组3: cols 19-22
  const groupIndex = Math.floor(lineOffset / 4);
  const posInGroup = lineOffset % 4;
  const column = groupIndex * 6 + posInGroup + 1; // group*6: 4chars + 2spaces
  return {
    lineNumber: Math.floor(byteIndex / 16) + 1,
    column,
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

// 在 Monaco onMount 中恢复该标签页保存的视图状态（滚动位置 + 光标 + 折叠），
// 并在滚动/光标变化时持续保存，保证切换标签页后能回到上次位置。
// 不在卸载时保存：Monaco editor 在 key 变化卸载后会被 dispose，
// 此时 saveViewState() 返回 null 会覆盖此前滚动时已保存的正确状态。
function useMonacoScrollMemory(tabId: string) {
  return useCallback(
    (editor: any) => {
      const saved = getMonacoViewState(tabId);
      if (saved) {
        editor.restoreViewState(saved);
      }

      const save = () => {
        try {
          const state = editor.saveViewState();
          if (state) {
            setMonacoViewState(tabId, state);
          }
        } catch {
          // editor 已 dispose 时 saveViewState 会抛错，忽略即可。
        }
      };

      const scrollDisposable = editor.onDidScrollChange(save);
      const cursorDisposable = editor.onDidChangeCursorSelection(save);

      return () => {
        scrollDisposable.dispose();
        cursorDisposable.dispose();
      };
    },
    [tabId],
  );
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
  return useMemo<Components>(() => {
    if (activeTab.language !== "markdown") {
      return {};
    }

    const nextHeadingId = createMarkdownHeadingIdFactory();

    // 基础渲染函数，为元素添加 data-line 属性
    const createBaseRenderer = (tag: string) =>
      function BaseRenderer({ children, node, ...props }: any) {
        const line = node?.position?.start?.line;
        const extraProps: any = {};
        if (line !== undefined) {
          extraProps["data-line"] = line;
        }

        // 处理标题的特殊逻辑（保持原有 ID 生成）
        if (/^h[1-6]$/.test(tag)) {
          const headingText = extractTextFromReactNode(children);
          extraProps["id"] = nextHeadingId(headingText, line);
        }

        return createElement(tag, { ...props, ...extraProps }, children);
      };

    return {
      h1: createBaseRenderer("h1"),
      h2: createBaseRenderer("h2"),
      h3: createBaseRenderer("h3"),
      h4: createBaseRenderer("h4"),
      h5: createBaseRenderer("h5"),
      h6: createBaseRenderer("h6"),
      p: createBaseRenderer("p"),
      li: createBaseRenderer("li"),
      blockquote: createBaseRenderer("blockquote"),
      pre: createBaseRenderer("pre"),
      table: createBaseRenderer("table"),
      // 防止空字符串 src 导致浏览器重新下载当前页面
      // 将本地文件路径转为 Tauri asset 协议 URL，使 Markdown 中的本地图片可正常显示
      img: function ImgRenderer({ src: rawSrc, alt, node, ...props }: any) {
        if (!rawSrc) return alt ? createElement("span", null, alt) : null;

        let src = rawSrc;
        // 1. 处理 file:// 协议，将其转为普通路径
        if (src.startsWith("file://")) {
          src = src.replace(/^file:\/\/\/?/, "");
        }

        // 2. 尝试解码，处理 ![](image%20name.png)
        try {
          if (src.includes("%")) {
            src = decodeURIComponent(src);
          }
        } catch (e) {
          // ignore
        }

        const line = node?.position?.start?.line;
        const extraProps: any = {};
        if (line !== undefined) {
          extraProps["data-line"] = line;
        }

        // 3. 如果已经是网络图片或 asset 协议，直接返回
        if (/^(https?|data|asset):/.test(src)) {
          return createElement("img", {
            alt,
            ...props,
            ...extraProps,
            src,
            style: { maxWidth: "100%", display: "block" },
          });
        }

        let resolvedSrc = src;
        // 4. 判断是否为绝对路径（Windows: C:\..., D:\... 等，Unix: /...）
        const isAbsolute = /^(?:[A-Za-z]:[/\\]?|[/\\])/.test(src);

        if (isAbsolute) {
          let absolutePath = src;
          // 如果盘符后面缺少分隔符（可能被 Markdown 转义了），补上
          if (/^[A-Za-z]:[^/\\]/.test(src)) {
            absolutePath = src.substring(0, 2) + "\\" + src.substring(2);
          }
          const normalizedPath = absolutePath.replace(/\\/g, "/");
          resolvedSrc = convertFileSrc(normalizedPath);
        } else if (activeTab.path) {
          // 5. 处理相对路径
          try {
            const lastSeparatorIndex = Math.max(
              activeTab.path.lastIndexOf("/"),
              activeTab.path.lastIndexOf("\\"),
            );
            if (lastSeparatorIndex !== -1) {
              const dir = activeTab.path.substring(0, lastSeparatorIndex);
              const separator = activeTab.path.includes("\\") ? "\\" : "/";
              const absolutePath = `${dir}${separator}${src}`;
              const normalizedPath = absolutePath.replace(/\\/g, "/");
              resolvedSrc = convertFileSrc(normalizedPath);
            }
          } catch (e) {
            console.error("Failed to resolve relative image path:", e);
          }
        }

        return createElement("img", {
          alt: alt || "image",
          ...props,
          ...extraProps,
          src: resolvedSrc,
          style: { maxWidth: "100%", display: "block" },
          onError: () => {
            console.error("Image load error:", resolvedSrc);
            // 如果加载失败，尝试在 alt 位置显示路径信息（可选）
          },
        });
      },
    };
  }, [activeTab.content, activeTab.language, activeTab.path]);
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
  onScroll?: (event: UIEvent<HTMLDivElement>) => void;
  containerRef?: RefObject<HTMLDivElement | null>;
  // 切换标签页后恢复预览上次的滚动位置；关闭仅在预览模式 / 实时模式间切换标签时启用。
  persistScroll?: boolean;
  showLineNumbers?: boolean;
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
  onScroll,
  containerRef,
  persistScroll = false,
}: MarkdownPreviewPaneProps) {
  const internalRef = useRef<HTMLDivElement>(null);
  const markdownPreviewRef = containerRef || internalRef;
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

  // 切换标签页后，恢复该预览容器上次的滚动位置。
  // Markdown 内含异步加载的图片会持续撑高容器，需要多帧重试直到 scrollHeight 足够。
  useEffect(() => {
    if (!persistScroll) return;
    const container = markdownPreviewRef.current;
    if (!container) return;

    const savedTop = getPreviewScrollTop(activeTab.id);
    if (savedTop == null || savedTop <= 0) return;

    let cancelled = false;
    let attempts = 0;

    const restore = () => {
      if (cancelled) return;
      attempts += 1;

      // 仅在容器已足够高时恢复，避免内容未渲染完导致位置被夹到 maxScrollTop。
      if (container.scrollHeight - container.clientHeight >= savedTop) {
        container.scrollTop = savedTop;
        return;
      }

      if (attempts < 10) {
        requestAnimationFrame(restore);
      }
    };

    requestAnimationFrame(restore);
    return () => {
      cancelled = true;
    };
  }, [activeTab.id, activeTab.content, persistScroll]);

  const handlePersistScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (persistScroll) {
        const container = markdownPreviewRef.current;
        if (container) {
          setPreviewScrollTop(activeTab.id, container.scrollTop);
        }
      }
      onScroll?.(event);
    },
    [activeTab.id, onScroll, persistScroll],
  );

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
      onScroll={handlePersistScroll}
    >
      <div className={contentClassName}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, rehypeHighlight]}
          components={markdownComponents}
          urlTransform={(uri: string) => uri}
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
        persistScroll
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
  const restoreHexScroll = useMonacoScrollMemory(`${activeTab.id}:base64`);
  const hexMemoryCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      hexMemoryCleanupRef.current?.();
      hexMemoryCleanupRef.current = null;
    };
  }, []);

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
              hexMemoryCleanupRef.current?.();
              hexMemoryCleanupRef.current = restoreHexScroll(editor);
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
                lineNumbers: getHexOffsetLabel,
                lineNumbersMinChars: 6,
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

function SqliteModeView({
  activeTab,
  showNotification,
}: Pick<EditorModeContext, "activeTab" | "showNotification">) {
  const [tables, setTables] = useState<{ name: string }[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableData, setTableData] = useState<{ columns: string[]; rows: any[][] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const pageSize = 50;

  const loadTables = useCallback(async () => {
    try {
      setLoading(true);
      console.log("SQLite: 正在加载表, 路径:", activeTab.path);
      const result = await invoke<{ name: string }[]>("get_sqlite_tables", { path: activeTab.path });
      console.log("SQLite: 加载到表:", result);
      setTables(result);
      if (result.length > 0 && !selectedTable) {
        setSelectedTable(result[0].name);
      }
    } catch (err) {
      console.error("SQLite: 加载表失败:", err);
      showNotification(`加载表失败: ${err}`, "error");
    } finally {
      setLoading(false);
    }
  }, [activeTab.path, showNotification]);

  const loadTableData = useCallback(async () => {
    if (!selectedTable) return;
    try {
      setLoading(true);
      console.log("SQLite: 正在加载表数据, 表:", selectedTable, "页:", page);
      const result = await invoke<{ columns: string[]; rows: any[][] }>("get_sqlite_table_data", {
        path: activeTab.path,
        table: selectedTable,
        limit: pageSize,
        offset: page * pageSize,
      });
      setTableData(result);
    } catch (err) {
      console.error("SQLite: 加载数据失败:", err);
      showNotification(`加载数据失败: ${err}`, "error");
    } finally {
      setLoading(false);
    }
  }, [activeTab.path, selectedTable, page, showNotification]);


  useEffect(() => {
    loadTables();
  }, [loadTables]);

  useEffect(() => {
    loadTableData();
  }, [loadTableData]);

  return (
    <div className="flex h-full bg-primary overflow-hidden">
      {/* Sidebar for tables */}
      <div className="w-64 border-r border-border flex flex-col bg-deepest shrink-0">
        <div className="p-3 border-b border-border flex items-center justify-between bg-surface/40">
          <div className="flex items-center gap-2 text-xs font-bold text-text-secondary uppercase tracking-wider">
            <Database size={14} />
            <span>数据库表</span>
          </div>
          <button
            onClick={loadTables}
            className="p-1 hover:bg-surface rounded text-text-muted hover:text-accent transition-colors"
            title="刷新表列表"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-1 space-y-0.5">
          {tables.map((table) => (
            <button
              key={table.name}
              onClick={() => {
                setSelectedTable(table.name);
                setPage(0);
              }}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded text-sm transition-all text-left ${
                selectedTable === table.name
                  ? "bg-accent/10 text-accent font-medium shadow-sm"
                  : "text-text-secondary hover:bg-surface/50"
              }`}
            >
              <Table size={14} className={selectedTable === table.name ? "text-accent" : "text-text-muted"} />
              <span className="truncate">{table.name}</span>
            </button>
          ))}
          {tables.length === 0 && !loading && (
            <div className="p-4 text-center text-xs text-text-muted italic">
              无可用表
            </div>
          )}
        </div>
      </div>

      {/* Main content for data */}
      <div className="flex-1 flex flex-col min-w-0 bg-primary">
        <div className="p-3 border-b border-border flex items-center justify-between bg-surface/20 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Table size={14} className="text-accent shrink-0" />
            <span className="font-medium text-sm truncate">
              {selectedTable || "未选择表"}
            </span>
            {tableData && (
              <span className="text-[10px] bg-accent/10 text-accent px-1.5 py-0.5 rounded-full font-bold">
                {tableData.rows.length} 条记录
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            <div className="flex items-center bg-deepest rounded-md border border-border p-0.5 shadow-sm">
              <button
                disabled={page === 0 || loading}
                onClick={() => setPage(p => Math.max(0, p - 1))}
                className="p-1 hover:bg-surface disabled:opacity-30 disabled:hover:bg-transparent rounded transition-colors text-text-secondary"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="text-[10px] px-2 font-mono font-bold text-text-muted">
                P.{page + 1}
              </span>
              <button
                disabled={(tableData?.rows.length || 0) < pageSize || loading}
                onClick={() => setPage(p => p + 1)}
                className="p-1 hover:bg-surface disabled:opacity-30 disabled:hover:bg-transparent rounded transition-colors text-text-secondary"
              >
                <ChevronRight size={14} />
              </button>
            </div>
            <button
              onClick={loadTableData}
              className="p-1.5 hover:bg-surface rounded border border-border bg-deepest text-text-muted hover:text-accent transition-all shadow-sm"
              title="刷新数据"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto relative scrollbar-thin">
          {tableData ? (
            <div className="inline-block min-w-full align-middle">
              <table className="min-w-full divide-y divide-border border-separate border-spacing-0">
                <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur-sm shadow-sm">
                  <tr>
                    {tableData.columns.map((col) => (
                      <th
                        key={col}
                        className="px-4 py-2.5 text-left text-xs font-bold text-text uppercase tracking-wider border-b border-border border-r last:border-r-0 whitespace-nowrap"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="bg-primary divide-y divide-border">
                  {tableData.rows.map((row, i) => (
                    <tr key={i} className="hover:bg-surface/30 transition-colors group">
                      {row.map((val, j) => (
                        <td
                          key={j}
                          className="px-4 py-2 text-sm text-text-secondary border-r border-border last:border-r-0 whitespace-nowrap max-w-xs truncate"
                          title={val === null ? "NULL" : String(val)}
                        >
                          {val === null ? (
                            <span className="text-text-muted/40 italic text-xs">NULL</span>
                          ) : typeof val === 'boolean' ? (
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${val ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>
                              {val ? 'TRUE' : 'FALSE'}
                            </span>
                          ) : (
                            String(val)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {tableData.rows.length === 0 && (
                    <tr>
                      <td colSpan={tableData.columns.length} className="px-6 py-12 text-center text-text-muted italic bg-surface/5">
                        <div className="flex flex-col items-center gap-2">
                          <Database size={24} className="opacity-20" />
                          <span>此表中没有数据</span>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-text-muted gap-4 bg-surface/5">
              {loading ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="w-8 h-8 border-2 border-accent/20 border-t-accent rounded-full animate-spin" />
                  <span className="text-xs font-medium animate-pulse">正在查询数据...</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 max-w-xs text-center">
                  <Table size={32} className="opacity-20 mb-2" />
                  <p className="text-sm font-medium">请从左侧选择一个表</p>
                  <p className="text-xs text-text-muted/60">SQLite 数据库已就绪，点击左侧表名开始查看数据</p>
                </div>
              )}
            </div>
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

      editor.revealLine(topLine, 1); // 1 为 ScrollType.Immediate（同步触发，避免异步竞争导致二次回跳）
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

const sqliteMode: EditorModeAdapter = {
  id: "sqlite",
  match: (tab) => tab.language === "sqlite",
  render: (context) => (
    <SqliteModeView
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
  sqliteMode,
  markdownPreviewMode,
  base64Mode,
  textMode,
];

export function resolveEditorMode(tab: FileTab) {
  return editorModes.find((mode) => mode.match(tab)) ?? textMode;
}
