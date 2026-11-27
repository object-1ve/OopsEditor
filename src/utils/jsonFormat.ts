/**
 * JSON 格式化工具
 *
 * 纯函数实现（不依赖 Monaco），便于离线验证：解析失败时返回错误文案与行列号，
 * 成功时按原文件的缩进偏好、换行符与末尾换行重建文本。
 */

export type JsonFormatResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; error: string; line: number; column: number };

export interface JsonFormatOptions {
  /** 缩进宽度，默认 2 */
  tabSize?: number;
  /** true（默认）用空格缩进，false 用制表符 */
  insertSpaces?: boolean;
}

const POSITION_RE = /position\s+(\d+)/i;
const LINE_COLUMN_RE = /line\s+(\d+)\s+column\s+(\d+)/i;

/** 把字符偏移换算成 1 起始的行列号 */
function lineColumnAt(text: string, position: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(position, text.length));
  const before = text.slice(0, clamped);
  return {
    line: before.split("\n").length,
    column: clamped - before.lastIndexOf("\n"),
  };
}

export function formatJsonText(
  source: string,
  options: JsonFormatOptions = {},
): JsonFormatResult {
  // 部分工具写出的 JSON 带 UTF-8 BOM，JSON.parse 不认识，解析前摘掉、成功后原样拼回
  const hasBom = source.charCodeAt(0) === 0xfeff;
  const body = hasBom ? source.slice(1) : source;

  if (body.trim().length === 0) {
    return { ok: false, error: "内容为空，没有可格式化的 JSON", line: 1, column: 1 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    let line = 1;
    let column = 1;
    const lineColumn = LINE_COLUMN_RE.exec(raw);
    if (lineColumn) {
      line = Number(lineColumn[1]);
      column = Number(lineColumn[2]);
    } else {
      const position = POSITION_RE.exec(raw);
      if (position) {
        ({ line, column } = lineColumnAt(body, Number(position[1])));
      }
    }
    // 去掉 V8 自带的位置尾巴，统一用「第 X 行第 Y 列」表达
    const detail = raw
      .replace(/\s+in JSON at position \d+.*$/i, "")
      .replace(/\s*\(line \d+ column \d+\)\s*$/i, "")
      .trim();
    return { ok: false, error: `${detail}（第 ${line} 行第 ${column} 列）`, line, column };
  }

  const insertSpaces = options.insertSpaces !== false;
  const tabSize = Math.max(1, Math.min(8, Math.trunc(options.tabSize ?? 2)));
  const indent = insertSpaces ? " ".repeat(tabSize) : "\t";
  // Windows 文件是 CRLF：沿用原文件的换行符，避免整份 diff
  const eol = body.includes("\r\n") ? "\r\n" : "\n";

  let formatted = JSON.stringify(parsed, null, indent);
  if (eol !== "\n") {
    formatted = formatted.replace(/\n/g, eol);
  }
  // JSON.stringify 总是丢掉结尾换行，原文件有则保留
  if (/\r?\n$/.test(body)) {
    formatted += eol;
  }

  const text = (hasBom ? "\uFEFF" : "") + formatted;
  return { ok: true, text, changed: text !== source };
}
