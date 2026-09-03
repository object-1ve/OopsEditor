/**
 * Markdown preview mode - rendered preview with context menu
 */
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type UIEvent,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import { Copy, FilePenLine } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getPreviewScrollTop, setPreviewScrollTop } from "@/utils/scrollMemory";
import { createMarkdownHeadingIdFactory, extractTextFromReactNode } from "@/utils/markdown";
import ContextMenu from "@/components/ContextMenu";
import type { MarkdownOutlineTarget } from "@/store/types";
import type { FileTab } from "@/types";
import type { EditorModeContext, EditorModeAdapter, SharedContextMenuItem } from "./types";

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
      // 链接：阻止 WebView 默认跳转，改用系统浏览器打开；#anchor 保留预览内跳转
      a: function LinkRenderer({ children, href, node: _node, ...props }: React.ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
        const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
          if (!href || href.startsWith("#")) return;
          e.preventDefault();
          e.stopPropagation();
          void openUrl(href);
        };
        return createElement("a", { ...props, href, onClick: handleClick }, children);
      },
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
  containerRef?: React.RefObject<HTMLDivElement | null>;
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

export { MarkdownPreviewPane };
export const markdownPreviewMode: EditorModeAdapter = {
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
