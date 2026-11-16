/**
 * markdownImageHover - 源码态 Markdown 图片的悬浮缩略图（可点击放大）
 *
 * 覆盖 md 文件与 ipynb 的 markdown 单元格：鼠标悬在 `![alt](图片)` 上显示图片本身，
 * 只显示图、不显示文件名；点击缩略图直接打开全屏图片查看器（与 Ctrl+点击一致）。
 *
 * 不用 Monaco 的 HoverProvider：它的悬浮面板里的图片无法绑定点击事件、也没法按需隐藏。
 */
import type { editor } from "monaco-editor";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { findMarkdownImageAtColumn, resolveMarkdownImagePath } from "@/utils/markdown";
import { useEditorStore } from "@/store/editor";
import type { MarkdownHoverDoc } from "./markdownHover";

interface Overlay {
  element: HTMLDivElement;
  image: HTMLImageElement;
  /** 当前缩略图对应的放大动作；点击图片时执行 */
  open: (() => void) | null;
}

let overlay: Overlay | null = null;

function ensureOverlay(): Overlay {
  if (overlay) return overlay;

  const element = document.createElement("div");
  element.setAttribute("data-md-image-hover", "");
  element.style.cssText = [
    "position:fixed",
    "z-index:250",
    "display:none",
    "padding:4px",
    "border:1px solid var(--border)",
    "border-radius:8px",
    "background:var(--bg-primary)",
    "box-shadow:0 10px 30px rgba(0,0,0,0.28)",
    "pointer-events:auto",
  ].join(";");

  const image = document.createElement("img");
  image.alt = "";
  image.draggable = false;
  image.style.cssText = [
    "display:block",
    "max-width:min(360px,80vw)",
    "max-height:280px",
    "object-fit:contain",
    "border-radius:5px",
    "cursor:zoom-in",
  ].join(";");

  const state: Overlay = { element, image, open: null };
  image.addEventListener("mousedown", (event) => {
    // 别让点击落到编辑器上（否则会顺带移动光标）
    event.preventDefault();
    event.stopPropagation();
  });
  image.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.open?.();
    hideImageHover();
  });
  element.addEventListener("mouseleave", () => hideImageHover());
  element.appendChild(image);
  document.body.appendChild(element);

  overlay = state;
  return state;
}

/** 收起悬浮缩略图（各编辑器共用同一块面板，因此是全局唯一） */
export function hideImageHover(): void {
  if (!overlay) return;
  overlay.element.style.display = "none";
  overlay.open = null;
}

/** 图片地址 → 缩略图 src + 点击放大时的预览请求 */
interface ResolvedImage {
  src: string;
  name: string;
  open: () => void;
}

function showPreview(path: string, name: string, url?: string) {
  useEditorStore.getState().openImagePreview({ path, name, url });
}

/**
 * 解析 Markdown 图片地址：attachment 取单元格附件，本地文件转 asset 协议，URL 原样。
 *
 * @param alt 图片 alt，作为预览器里的名字
 * @param rawSrc 原样的图片地址
 * @param context 当前文档上下文
 * @returns 可显示的 src 与点击动作；解析不到返回 null
 */
async function resolveImage(
  alt: string,
  rawSrc: string,
  context: MarkdownHoverDoc,
): Promise<ResolvedImage | null> {
  const trimmed = rawSrc.trim();
  if (!trimmed) return null;
  const name = alt.trim() || "图片";

  if (/^attachment:/i.test(trimmed)) {
    let attachmentName = trimmed.slice("attachment:".length);
    try {
      attachmentName = decodeURIComponent(attachmentName);
    } catch {
      // 保持原样
    }
    const url = context.resolveAttachment?.(attachmentName) ?? null;
    if (!url) return null;
    return {
      src: url,
      name: alt.trim() || attachmentName,
      open: () => showPreview(`${context.docPath}#attachment:${attachmentName}`, alt.trim() || attachmentName, url),
    };
  }

  if (/^(https?|data|blob|asset):/i.test(trimmed)) {
    return { src: trimmed, name, open: () => showPreview(trimmed, name, trimmed) };
  }

  const absolute = resolveMarkdownImagePath(trimmed, context.docPath);
  if (!absolute) return null;
  const exists = await invoke<boolean>("path_exists", { path: absolute }).catch(() => false);
  if (!exists) return null;
  const fileName = absolute.split(/[/\\]/).pop() ?? name;
  return {
    src: convertFileSrc(absolute),
    name: alt.trim() || fileName,
    open: () => showPreview(absolute, alt.trim() || fileName),
  };
}

/**
 * 给一个 Markdown 编辑器挂上「悬浮看缩略图、点击放大」。
 *
 * @param editor Monaco 编辑器实例
 * @param getContext 每次悬浮时重新求值，保证文档路径/附件是最新的
 * @returns 释放函数
 */
export function attachMarkdownImageHover(
  editor: editor.IStandaloneCodeEditor,
  getContext: () => MarkdownHoverDoc,
): () => void {
  let token = 0;
  let currentKey: string | null = null;
  /** 面板显示时的滚动位置：只有真的滚动才收起（Monaco 的布局变化也会触发 onDidScrollChange） */
  let shownScroll = { left: 0, top: 0 };

  const hide = () => {
    currentKey = null;
    token += 1;
    hideImageHover();
  };

  const show = (resolved: ResolvedImage, lineNumber: number, endColumn: number) => {
    const state = ensureOverlay();
    const dom = editor.getDomNode();
    const visible = editor.getScrolledVisiblePosition({ lineNumber, column: endColumn });
    if (!dom || !visible) return;

    state.image.src = resolved.src;
    state.open = resolved.open;
    state.element.style.display = "block";
    shownScroll = { left: editor.getScrollLeft(), top: editor.getScrollTop() };

    const editorRect = dom.getBoundingClientRect();
    const panelWidth = state.element.offsetWidth;
    const panelHeight = state.element.offsetHeight;
    // 默认贴在语法后面；右侧/下方放不下就翻到左边、往上收
    let left = editorRect.left + visible.left + 16;
    let top = editorRect.top + visible.top;
    if (left + panelWidth > window.innerWidth - 8) {
      left = Math.max(8, editorRect.left + visible.left - panelWidth - 16);
    }
    if (top + panelHeight > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - panelHeight - 8);
    }
    state.element.style.left = `${Math.round(left)}px`;
    state.element.style.top = `${Math.round(top)}px`;
  };

  const onMouseMove = editor.onMouseMove((event) => {
    const position = event.target.position;
    const model = editor.getModel();
    // Ctrl/Cmd+点击走的是「打开大图」，不再叠一层缩略图
    if (!position || !model || event.event.ctrlKey || event.event.metaKey) {
      if (currentKey) hide();
      return;
    }
    const hit = findMarkdownImageAtColumn(
      model.getLineContent(position.lineNumber),
      position.column - 1,
    );
    if (!hit) {
      if (currentKey) hide();
      return;
    }

    const key = `${position.lineNumber}:${hit.start}`;
    if (key === currentKey) return;
    currentKey = key;
    const request = ++token;
    void resolveImage(hit.alt, hit.src, getContext()).then((resolved) => {
      // 解析期间鼠标已经移开 / 移到别的图片
      if (request !== token || !resolved) {
        if (request === token) {
          currentKey = null;
          hideImageHover();
        }
        return;
      }
      show(resolved, position.lineNumber, hit.end);
    });
  });

  // 指针移到缩略图面板上时要保持显示（面板在编辑器 DOM 之外），
  // 只有指针既不在编辑器、也不在面板里才收起
  const handleDocumentMove = (event: MouseEvent) => {
    if (!currentKey) return;
    const target = event.target as Node | null;
    if (target && overlay?.element.contains(target)) return;
    // Monaco 0.55 的 EditContext 是一个独立浮层，target 可能不在编辑器 DOM 里，
    // 用指针坐标判定是否仍在编辑器范围内；rect 必须每次现取（单元格高度会随内容变化）
    const dom = editor.getDomNode();
    if (dom) {
      const rect = dom.getBoundingClientRect();
      if (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      ) {
        return;
      }
    }
    hide();
  };
  const handleResize = () => hide();
  document.addEventListener("mousemove", handleDocumentMove, true);
  const scroll = editor.onDidScrollChange(() => {
    if (editor.getScrollLeft() !== shownScroll.left || editor.getScrollTop() !== shownScroll.top) {
      hide();
    }
  });
  const content = editor.onDidChangeModelContent(() => hide());
  window.addEventListener("resize", handleResize);

  return () => {
    hide();
    onMouseMove.dispose();
    scroll.dispose();
    content.dispose();
    document.removeEventListener("mousemove", handleDocumentMove, true);
    window.removeEventListener("resize", handleResize);
  };
}
