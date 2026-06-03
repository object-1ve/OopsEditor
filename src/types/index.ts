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
}

export type SupportedLanguage = "plaintext" | "markdown" | "json" | "yaml" | "xml" | "toml" | "javascript" | "typescript" | "css" | "html" | "rust" | "python" | "sql" | "shell" | "image" | "pdf" | "word";

export function detectLanguage(filename: string): SupportedLanguage {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, SupportedLanguage> = {
    txt: "plaintext",
    md: "markdown",
    markdown: "markdown",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    xml: "xml",
    toml: "toml",
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    css: "css",
    html: "html",
    rs: "rust",
    py: "python",
    sql: "sql",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    png: "image",
    jpg: "image",
    jpeg: "image",
    gif: "image",
    webp: "image",
    svg: "image",
    ico: "image",
    bmp: "image",
    tiff: "image",
    tif: "image",
    avif: "image",
    apng: "image",
    pdf: "pdf",
    doc: "word",
    docx: "word",
    docm: "word",
    dotx: "word",
    dotm: "word",
  };
  return map[ext ?? ""] ?? "plaintext";
}

export function isPreviewOnlyLanguage(language: string): boolean {
  return language === "image" || language === "pdf" || language === "word";
}
