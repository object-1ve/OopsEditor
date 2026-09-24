/**
 * 会话面板的文件名 / 字节数展示：图片要渲染缩略图，其余走文件卡片，
 * 气泡标题与拖放附件命名都需要同一套判定。
 */

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tiff", "tif", "avif",
]);

export function isImageFileName(name: string | null | undefined): boolean {
  if (!name) return false;
  const ext = name.split(".").pop()?.toLowerCase();
  return !!ext && IMAGE_EXTENSIONS.has(ext);
}

/** 文件名去掉扩展名，用作气泡里的文字摘要 */
export function chatFileStem(name: string | null | undefined): string {
  const display = chatDisplayName(name);
  const dot = display.lastIndexOf(".");
  return dot > 0 ? display.slice(0, dot) : display;
}

/**
 * 展示用文件名：附件落盘时会在词干后拼内容哈希（`报告-6e53ea5eca217306.pdf`），
 * 那是存储层去重用的，展示时按后端同一约定摘掉，避免把哈希噪音给用户看。
 */
export function chatDisplayName(name: string | null | undefined): string {
  if (!name) return "未命名文件";
  const base = name.split(/[/\\]/).pop() ?? name;
  const stripped = base.replace(/-([0-9a-f]{16}|[0-9a-f]{64})(\.[^.]+)?$/, "$2");
  return stripped || base;
}

/** 字节数展示：0 B / 12 KB / 3.4 MB */
export function formatChatSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
