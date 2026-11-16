/**
 * markdownHover - Markdown 编辑器里的鼠标悬浮预览
 *
 * 覆盖 md 文件和 ipynb 里的 markdown 单元格（Language = markdown 共用一套 provider）：
 * - `![alt](图片)`：本地图片显示缩略图（notebook 的 `attachment:名字` 从单元格附件取）
 * - `[文本](路径)`：本地文本文件显示前几十行，图片同样显示缩略图，文件不存在时提示
 *
 * provider 按语言全局注册一次，文档路径/附件解析按 model.uri 存在注册表里，
 * 由各编辑器在 mount 时登记、卸载时释放（引用计数到 0 就 dispose）。
 */
import {
  languages,
  Range,
  type CancellationToken,
  type editor,
  type IMarkdownString,
  type IDisposable,
  type IRange,
  type Position,
} from "monaco-editor";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  findMarkdownLinkAtColumn,
  resolveMarkdownFilePath,
  resolveMarkdownImagePath,
} from "@/utils/markdown";
import { isImageFile } from "@/utils/editorInsert";

/** 文本文件预览上限：超过就不整份读进来 */
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_PREVIEW_LINES = 28;

export interface MarkdownHoverDoc {
  /** 当前文档路径（md 文件 / notebook 文件），相对路径按它的目录解析 */
  docPath: string;
  /** notebook 单元格附件：`attachment:名字` → 可渲染的 data URL */
  resolveAttachment?: (name: string) => string | null;
}

export type MarkdownHoverContext = () => MarkdownHoverDoc;

type HoverReturn = { contents: IMarkdownString[]; range: IRange } | null;

const contexts = new Map<string, MarkdownHoverContext>();
let providerDisposable: IDisposable | null = null;

const LANGUAGE_BY_EXT: Record<string, string> = {
  md: "markdown",
  markdown: "markdown",
  json: "json",
  jsonc: "json",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  ipynb: "json",
  tex: "latex",
  log: "plaintext",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 悬浮面板里的路径：用行内代码包住，并避免反引号破格式 */
function pathLine(path: string, suffix?: string): IMarkdownString {
  const label = path.replace(/`/g, "'").replace(/\\/g, "/");
  return { value: `\`${label}\`${suffix ? ` · ${suffix}` : ""}` };
}

function imageMarkdown(alt: string, url: string): IMarkdownString {
  const safeAlt = alt.replace(/[[\]]/g, "");
  // 括号/空格会把 Markdown 的地址截断，先转义
  const safeUrl = url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20");
  return { value: `![${safeAlt}](${safeUrl})` };
}

/**
 * 图片悬浮内容：本地文件/远程地址/单元格附件。
 *
 * @param alt 图片 alt（md 语法里写的说明）
 * @param src 原样的图片地址
 * @param context 文档上下文
 * @returns 悬浮内容；解析不到时返回 null（不弹面板）
 */
async function buildImageContents(
  alt: string,
  src: string,
  context: MarkdownHoverDoc,
): Promise<IMarkdownString[] | null> {
  const trimmed = src.trim();
  if (!trimmed) return null;

  if (/^attachment:/i.test(trimmed)) {
    let name = trimmed.slice("attachment:".length);
    try {
      name = decodeURIComponent(name);
    } catch {
      // 保持原样
    }
    const url = context.resolveAttachment?.(name) ?? null;
    if (!url) return null;
    return [imageMarkdown(alt, url)];
  }

  if (/^(https?|data|blob|asset):/i.test(trimmed)) {
    return [imageMarkdown(alt, trimmed)];
  }

  const absolute = resolveMarkdownImagePath(trimmed, context.docPath);
  if (!absolute) return null;
  const exists = await invoke<boolean>("path_exists", { path: absolute }).catch(() => false);
  if (!exists) return null;
  return [imageMarkdown(alt, convertFileSrc(absolute))];
}

/**
 * 链接悬浮内容：图片链接给缩略图，文本文件给前几行，找不到给提示。
 *
 * @param text 链接文本
 * @param target 原样的链接目标
 * @param context 文档上下文
 * @returns 悬浮内容；不处理的地址（http/anchor/attachment 等）返回 null
 */
async function buildLinkContents(
  text: string,
  target: string,
  context: MarkdownHoverDoc,
): Promise<IMarkdownString[] | null> {
  const trimmed = target.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^(https?|mailto|tel|ftp|data|blob|asset|attachment|command|vscode):/i.test(trimmed)) {
    return null;
  }

  const absolute = resolveMarkdownFilePath(trimmed, context.docPath);
  if (!absolute) return null;
  const label = text.trim() || "文件";

  if (isImageFile(absolute)) {
    const contents = await buildImageContents(label, trimmed, context);
    if (contents) return contents;
    return [{ value: `**${label}**` }, pathLine(absolute, "图片不存在")];
  }

  const info = await invoke<{ size: number; modified_at: number }>("get_file_info", {
    path: absolute,
  }).catch(() => null);
  if (!info) {
    return [{ value: `**${label}**` }, pathLine(absolute, "文件不存在")];
  }

  const fileName = absolute.split(/[/\\]/).pop() ?? absolute;
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  if (info.size > MAX_PREVIEW_BYTES) {
    return [
      { value: `**${label}**` },
      pathLine(absolute, `${formatSize(info.size)}，文件过大不预览`),
    ];
  }

  let content: string;
  try {
    content = await invoke<string>("read_file", { path: absolute });
  } catch (err) {
    return [
      { value: `**${label}**` },
      pathLine(absolute, `无法预览：${String(err).slice(0, 120)}`),
    ];
  }

  const allLines = content.split(/\r?\n/);
  const truncated = allLines.length > MAX_PREVIEW_LINES;
  const preview = allLines.slice(0, MAX_PREVIEW_LINES).join("\n");
  const fence = preview.includes("```") ? "````" : "```";
  const suffix = truncated ? `前 ${MAX_PREVIEW_LINES} 行 / 共 ${allLines.length} 行` : `${allLines.length} 行`;

  return [
    { value: `${fence}${LANGUAGE_BY_EXT[ext] ?? "plaintext"}\n${preview}\n${fence}` },
    pathLine(absolute, suffix),
  ];
}

async function provideHover(
  model: editor.ITextModel,
  position: Position,
  _token: CancellationToken,
): Promise<HoverReturn> {
  const context = contexts.get(model.uri.toString())?.();
  if (!context) return null;

  const line = model.getLineContent(position.lineNumber);
  const column = position.column - 1;

  // 图片语法由 markdownImageHover 的自定义面板负责（缩略图可点击放大），这里只管链接
  const link = findMarkdownLinkAtColumn(line, column);
  if (!link) return null;
  const contents = await buildLinkContents(link.text, link.target, context);
  if (!contents) return null;
  return {
    range: new Range(position.lineNumber, link.start + 1, position.lineNumber, link.end + 1),
    contents,
  };
}

/**
 * 为某个 markdown model 登记悬浮预览上下文。
 *
 * @param model 编辑器当前 model（可能为 null）
 * @param getContext 每次悬浮时重新求值，保证文档路径/附件是最新的
 * @returns 释放函数；最后一个使用者释放时 provider 一并 dispose
 */
export function registerMarkdownHover(
  model: editor.ITextModel | null,
  getContext: MarkdownHoverContext,
): () => void {
  if (!model) return () => {};
  const key = model.uri.toString();
  contexts.set(key, getContext);
  if (!providerDisposable) {
    providerDisposable = languages.registerHoverProvider("markdown", { provideHover });
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (contexts.get(key) === getContext) contexts.delete(key);
    if (contexts.size === 0 && providerDisposable) {
      providerDisposable.dispose();
      providerDisposable = null;
    }
  };
}
