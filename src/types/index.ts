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
  // 每次外部文件变更并重新加载时 +1，用于强制预览类模式（图片/PDF/Word/SQLite）重新加载
  revision?: number;
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

  // 3. 其他所有文件：优先匹配常见语言 ID，否则直接返回后缀名（Monaco 会尝试匹配或回退到纯文本）
  return { language: EXTENSION_TO_MONACO[ext] ?? ext };
}

export function isPreviewOnlyLanguage(language: string): boolean {
  return language === "image" || language === "pdf" || language === "word" || language === "sqlite";
}
