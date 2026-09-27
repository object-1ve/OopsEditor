/**
 * 格式化工具函数
 */

/**
 * 时间戳命名：`2026-09-27_10-30-15`。
 * 新建文件与新建会话共用同一口径，保证同一天里两类默认名可读且可排序；
 * 不用 `:` 是因为它不能出现在文件名里。
 */
export function formatTimestampName(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(
    date.getHours(),
  )}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

export function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined) return "未知";
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function formatModifiedTime(timestamp: number | undefined): string {
  if (!timestamp) return "未知";

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}
