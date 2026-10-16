export type FileTabKind = "file" | "chat";

export interface FileTab {
  id: string;
  name: string;
  path: string;
  language: string;
  content: string;
  isDirty: boolean;
  size?: number;
  isPreviewMode?: boolean;
  isLivePreviewMode?: boolean;
  viewMode?: "text" | "base64";
  isReadOnly?: boolean;
  /**
   * 标签种类：file = 本地文件；chat = 会话（path 为 `chat:<sessionId>` 伪路径，
   * 不对应磁盘文件，主区渲染对话视图）。缺省按 file 处理。
   */
  kind?: FileTabKind;
  // 每次外部文件变更并重新加载时 +1，用于强制预览类模式（图片/PDF/Word/SQLite）重新加载
  revision?: number;
}

export function isChatTab(tab: Pick<FileTab, "kind" | "language"> | undefined | null): boolean {
  return tab?.kind === "chat" || tab?.language === "chat";
}

export type SupportedLanguage = string;

export interface LanguageDetectionResult {
  language: SupportedLanguage;
  unsupportedReason?: string;
}

const VIDEO_EXTENSIONS = new Set([
  "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "3gp", "rmvb", "vob"
]);

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tiff", "tif", "avif", "apng"
]);

const WORD_EXTENSIONS = new Set([
  "doc", "docx", "docm", "dotx", "dotm"
]);

const SQLITE_EXTENSIONS = new Set([
  "db", "sqlite"
]);

// Excel 工作簿（Open XML 格式）：可读写单元格，由 ExcelMode 负责解析与保存。
// 旧版二进制 .xls 不在其中，仍按普通文本打开。
// 用 `=== true` 判断，避免 `constructor` 之类的原型键被误判为命中。
const EXCEL_EXTENSIONS: Record<string, true> = {
  xlsx: true,
  xlsm: true,
  xltx: true,
  xltm: true,
  xlam: true,
};

// 旧版/二进制 Excel：exceljs 只支持 Open XML 工作簿，这类文件交给系统程序打开
const LEGACY_EXCEL_EXTENSIONS: Record<string, true> = {
  xls: true,
  xlsb: true,
};

// 常见的后缀名到 Monaco 语言 ID 的映射，保证主流语言高亮正常
const EXTENSION_TO_MONACO: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rs: "rust",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  md: "markdown",
  txt: "plaintext",
};

export function detectLanguage(filename: string): LanguageDetectionResult {
  const ext = filename.split(".").pop()?.toLowerCase();

  // 如果没有后缀名，默认作为纯文本处理
  if (!filename.includes(".") || !ext) {
    return { language: "plaintext" };
  }

  // 1. 排除法：视频文件不支持
  if (VIDEO_EXTENSIONS.has(ext)) {
    return {
      language: "unsupported",
      unsupportedReason: `文件 "${filename}" 是视频格式 (.${ext})，暂不支持在编辑器中预览或编辑。`
    };
  }

  // 2. 特殊预览器判断
  if (IMAGE_EXTENSIONS.has(ext)) return { language: "image" };
  if (ext === "pdf") return { language: "pdf" };
  if (WORD_EXTENSIONS.has(ext)) return { language: "word" };
  if (SQLITE_EXTENSIONS.has(ext)) return { language: "sqlite" };
  if (EXCEL_EXTENSIONS[ext] === true) return { language: "excel" };
  if (LEGACY_EXCEL_EXTENSIONS[ext] === true) {
    return {
      language: "unsupported",
      unsupportedReason: `文件 "${filename}" 是旧版 Excel 格式 (.${ext})，编辑器只支持 .xlsx / .xlsm，请另存为新格式后再编辑。`
    };
  }

  // 3. 其他所有文件：优先匹配常见语言 ID，否则直接返回后缀名（Monaco 会尝试匹配或回退到纯文本）
  return { language: EXTENSION_TO_MONACO[ext] ?? ext };
}

export function isPreviewOnlyLanguage(language: string): boolean {
  return (
    language === "image" ||
    language === "pdf" ||
    language === "word" ||
    language === "sqlite" ||
    // Excel 的二进制内容由 ExcelMode 自行读盘解析，不预读成文本
    language === "excel"
  );
}
