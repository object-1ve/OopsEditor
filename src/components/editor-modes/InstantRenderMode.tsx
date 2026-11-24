/**
 * 即时渲染模式（Markdown）：单栏内边写边渲染。
 *
 * 由 Vditor 的 IR（instant rendering）模式承载：正在编辑的块保留源码，
 * 其余块直接渲染成排版结果——输入 `**粗体**`、`# 标题`、`- 列表`、表格等
 * 立即原地成形，不再需要「源码 / 预览」两栏来回对照。
 *
 * 文档内容始终以标准 Markdown 为准：编辑结果通过 onChange 写回标签内容，
 * 落盘格式不变，随时可以切回 Monaco 源码模式继续编辑。
 */
import { useCallback, useEffect, useRef } from "react";
import Vditor from "vditor";
import "vditor/dist/index.css";
import "./instantRender.css";
import "./tableChrome.css";
import { TableChrome } from "./tableChrome";
import { FilePenLine } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  registerEditorInsert,
  unregisterEditorInsert,
} from "@/utils/editorInsert";
import {
  resolveMarkdownImagePath,
  splitMarkdownFrontMatter,
} from "@/utils/markdown";
import { useEditorStore } from "@/store/editor";
import type { EditorModeContext } from "./types";

/** 已经是可直接加载的地址（网络 / data / asset 协议）时不再转本地文件 */
const DIRECT_SRC = /^(https?:|data:|blob:|asset:)/i;

/** 输入后多久把内容写回标签（毫秒）：赶在自动保存 1s 之前落地 */
const EMIT_DELAY = 120;

/**
 * 往返会改写写法的结构：HTML 块（`<details>` 等）会被拍平成普通段落，
 * 脚注会被改写成上标链接。只在这里提示一次，不阻止编辑。
 */
const REWRITE_PRONE_PATTERN = /<\/?(details|summary|div|section|figure|table)[\s>]/i;
const FOOTNOTE_PATTERN = /\[\^[^\]]+\]/;

export function InstantRenderModeView({
  activeTab,
  onChange,
  toggleInstantRenderMode,
  showNotification,
  saveActiveTab,
}: Pick<
  EditorModeContext,
  | "activeTab"
  | "onChange"
  | "toggleInstantRenderMode"
  | "showNotification"
  | "saveActiveTab"
>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const vditorRef = useRef<Vditor | null>(null);
  const tableChromeRef = useRef<TableChrome | null>(null);
  const readyRef = useRef(false);
  const destroyedRef = useRef(false);
  /** 最后一次「写回标签」的内容，用来分辨外部改动与我们自己的回写 */
  const lastEmittedRef = useRef(activeTab.content);
  /** 上一次观察到的标签内容，判断 effect 里的 content 是否真的变了 */
  const lastSeenRef = useRef(activeTab.content);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observerRef = useRef<MutationObserver | null>(null);
  /**
   * 用户是否真的改过内容：只进入看一眼再退出不该把整份文档重排写回。
   * Vditor 的 input 事件只在内容真正变化时触发。
   */
  const touchedRef = useRef(false);

  // 回调与文档路径都走 ref：Vditor 实例只创建一次，不能捕获旧闭包
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const saveRef = useRef(saveActiveTab);
  saveRef.current = saveActiveTab;
  const notifyRef = useRef(showNotification);
  notifyRef.current = showNotification;
  const docPathRef = useRef(activeTab.path);
  docPathRef.current = activeTab.path;
  const readOnlyRef = useRef(Boolean(activeTab.isReadOnly));
  readOnlyRef.current = Boolean(activeTab.isReadOnly);
  /**
   * YAML Front Matter：Lute 的 HTML ⇄ Markdown 往返会把它改写成代码块，
   * 所以编辑器里不加载它，写回时再把原文原样拼回开头。
   */
  const frontMatterRef = useRef(splitMarkdownFrontMatter(activeTab.content).frontMatter);
  /** 初始化时读取一次，之后内容变化由 effect 同步 */
  const initialContentRef = useRef(splitMarkdownFrontMatter(activeTab.content).body);

  /** 立即把编辑器里的 Markdown 写回标签内容 */
  const flush = useCallback(() => {
    if (pendingRef.current) {
      clearTimeout(pendingRef.current);
      pendingRef.current = null;
    }
    const vditor = vditorRef.current;
    if (!vditor || !readyRef.current) return;
    if (!touchedRef.current) return;
    const markdown = vditor.getValue();
    const next = frontMatterRef.current ? `${frontMatterRef.current}${markdown}` : markdown;
    if (next === lastEmittedRef.current) return;
    lastEmittedRef.current = next;
    onChangeRef.current(next);
  }, []);

  /**
   * 本地相对路径图片在 WebView 里按页面地址解析会 404，
   * 统一换成 asset 协议地址；原始 Markdown 保持不动（保存时仍是相对路径）。
   */
  const resolveLocalImages = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    host.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      const raw = img.getAttribute("data-oops-src") ?? img.getAttribute("src") ?? "";
      if (!raw || DIRECT_SRC.test(raw)) return;
      const absolute = resolveMarkdownImagePath(raw, docPathRef.current);
      if (!absolute) return;
      const next = convertFileSrc(absolute);
      img.setAttribute("data-oops-src", raw);
      if (img.getAttribute("src") !== next) img.setAttribute("src", next);
    });
  }, []);

  // 创建 Vditor（IR 模式）；标签切换时由适配器传 key，保证整实例重建
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    destroyedRef.current = false;
    const vditor = new Vditor(host, {
      cdn: "/vditor",
      mode: "ir",
      value: initialContentRef.current,
      lang: "zh_CN",
      icon: "ant",
      theme: "classic",
      height: "100%",
      placeholder: "开始书写…",
      // 高度由外层布局决定，关掉 Vditor 自带的拖拽缩放条
      resize: { enable: false },
      // 编辑器自己不做缓存，内容由标签状态统一管理
      cache: { enable: false },
      counter: { enable: false },
      outline: { enable: false, position: "left" },
      toolbar: [
        "headings",
        "bold",
        "italic",
        "strike",
        "|",
        "list",
        "ordered-list",
        "check",
        "quote",
        "|",
        "code",
        "inline-code",
        "link",
        "table",
        "|",
        "undo",
        "redo",
      ],
      preview: {
        theme: { current: "light", path: "/vditor/dist/css/content-theme" },
        hljs: { enable: true, style: "github", lineNumber: false },
        math: { engine: "KaTeX", inlineDigit: true },
        markdown: { toc: false, mark: false },
      },
      link: {
        // 链接交给系统浏览器打开，别让 WebView 自己跳转
        isOpen: false,
        click: (element) => {
          // IR 模式传进来的是链接地址的标记片段：<a> 本身不存在，
          // 地址就是这段标记的文字（源码态里显示的 `[文本](地址)` 括号内部分）
          const href = (element.getAttribute("href") ?? element.textContent ?? "").trim();
          if (!href || href.startsWith("#")) return;
          if (/^(https?|mailto):/i.test(href)) void openUrl(href);
        },
      },
      image: {
        isPreview: false,
        preview: (element) => {
          const img = element as HTMLImageElement;
          const raw =
            img.getAttribute("data-oops-src") ?? img.getAttribute("src") ?? "";
          if (!raw) return;
          const store = useEditorStore.getState();
          const name = img.alt || "图片";
          if (DIRECT_SRC.test(raw)) {
            store.openImagePreview({ path: raw, name, url: raw });
            return;
          }
          const absolute = resolveMarkdownImagePath(raw, docPathRef.current);
          if (absolute) store.openImagePreview({ path: absolute, name });
        },
      },
      input: () => {
        touchedRef.current = true;
        // 每次输入都从 Lute 取一次序列化结果，但按帧合并后再写回标签
        if (pendingRef.current) return;
        pendingRef.current = setTimeout(() => {
          pendingRef.current = null;
          flush();
        }, EMIT_DELAY);
      },
      blur: () => {
        flush();
      },
      after: () => {
        if (destroyedRef.current) return;
        readyRef.current = true;
        if (readOnlyRef.current) {
          vditor.disabled();
        } else {
          // 一次性提示：这份文档里有往返会被改写的写法
          const body = initialContentRef.current;
          if (
            REWRITE_PRONE_PATTERN.test(body) ||
            FOOTNOTE_PATTERN.test(body)
          ) {
            notifyRef.current(
              "即时渲染会按标准 Markdown 重排：HTML 块、脚注等写法可能被改写",
              "info",
            );
          }
        }
        resolveLocalImages();
        // 表格交互层：条 / 引脚 / 选中工具条，挂在整个编辑区外层，不污染编辑器 DOM
        const container = containerRef.current;
        const scroller = host.querySelector<HTMLElement>(".vditor-ir pre.vditor-reset");
        if (container && scroller) {
          tableChromeRef.current = new TableChrome({
            host: container,
            scroller,
            onCommit: () => {
              touchedRef.current = true;
              flush();
            },
            isReadOnly: () => readOnlyRef.current,
          });
          tableChromeRef.current.setDisabled(readOnlyRef.current);
        }
        // IR 模式会随输入重建块 DOM，图片地址在每次重建后都要重新解析
        const observer = new MutationObserver(() => resolveLocalImages());
        const content = host.querySelector(".vditor-ir");
        if (content) {
          observer.observe(content, { childList: true, subtree: true });
        }
        observerRef.current = observer;
      },
    });
    vditorRef.current = vditor;

    return () => {
      // 切标签 / 切模式瞬间的输入先落地，再销毁实例
      flush();
      destroyedRef.current = true;
      readyRef.current = false;
      if (pendingRef.current) {
        clearTimeout(pendingRef.current);
        pendingRef.current = null;
      }
      tableChromeRef.current?.destroy();
      tableChromeRef.current = null;
      observerRef.current?.disconnect();
      observerRef.current = null;
      try {
        vditor.destroy();
      } catch {
        // 尚未初始化完成时销毁会抛错，忽略即可
      }
      vditorRef.current = null;
    };
  }, [flush, resolveLocalImages]);

  // 外部内容变化（重新读盘 / 另存为 / 程序改写）时同步进编辑器
  useEffect(() => {
    const next = activeTab.content;
    const previous = lastSeenRef.current;
    lastSeenRef.current = next;
    if (next === previous) return;
    // 自己刚写回去的内容：不用回灌
    if (next === lastEmittedRef.current) return;
    // 还有未落地的输入：等它写回后再比对，避免把正在输入的内容冲掉
    if (pendingRef.current) return;
    const vditor = vditorRef.current;
    if (!vditor || !readyRef.current) return;
    const { frontMatter, body } = splitMarkdownFrontMatter(next);
    frontMatterRef.current = frontMatter;
    lastEmittedRef.current = next;
    touchedRef.current = false;
    vditor.setValue(body, true);
    resolveLocalImages();
  }, [activeTab.content, resolveLocalImages]);

  // 只读状态跟随标签（外部替换文件后可能变只读）
  useEffect(() => {
    const vditor = vditorRef.current;
    if (!vditor || !readyRef.current) return;
    tableChromeRef.current?.setDisabled(Boolean(activeTab.isReadOnly));
    if (activeTab.isReadOnly) vditor.disabled();
    else vditor.enable();
  }, [activeTab.isReadOnly]);

  // 拖入文件时按光标位置插入 Markdown（App 层的拖放通道）
  useEffect(() => {
    registerEditorInsert((text: string) => {
      const vditor = vditorRef.current;
      if (!vditor || !readyRef.current) return;
      touchedRef.current = true;
      vditor.insertMD(text);
      flush();
    });
    return () => {
      unregisterEditorInsert();
    };
  }, [flush]);

  // Ctrl/Cmd+S 保存、Ctrl+Alt+M 退出即时渲染；组件只在当前标签的编辑器里存在
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const host = hostRef.current;
      // Vditor 自己也在编辑区上监听按键，挂在文档捕获阶段最稳
      if (!host || !(event.target instanceof Node) || !host.contains(event.target)) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.altKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        event.stopPropagation();
        flush();
        toggleInstantRenderMode(activeTab.id);
        return;
      }
      if (event.altKey || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      flush();
      void saveRef
        .current(activeTab.id)
        .then(() => notifyRef.current("文件已保存", "success"))
        .catch((err) => notifyRef.current(`保存失败: ${String(err)}`, "error"));
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [activeTab.id, flush, toggleInstantRenderMode]);

  return (
    <div
      ref={containerRef}
      className="instant-render-mode relative h-full min-h-0 overflow-hidden bg-primary"
    >
      <div ref={hostRef} className="h-full min-h-0" />
      <button
        onClick={() => {
          flush();
          toggleInstantRenderMode(activeTab.id);
        }}
        className="absolute bottom-6 right-6 z-10 flex items-center gap-1.5 rounded-full bg-accent px-3 py-2 text-xs font-medium text-white shadow-lg transition-colors hover:bg-accent-bright"
        title="退出即时渲染，回到源码编辑"
      >
        <FilePenLine size={14} />
        退出即时渲染
      </button>
    </div>
  );
}
