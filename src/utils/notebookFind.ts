/**
 * Notebook 全文件搜索：跨单元格匹配源码文本（代码 / Markdown / Raw 一视同仁）。
 *
 * 单元格是各自独立的 Monaco 实例，Monaco 自带的查找只能搜当前单元格；
 * 这里把匹配结果统一编号，交给 NotebookMode 的查找框按顺序跳转。
 */

export interface NotebookFindCell {
  id: string;
  source: string;
}

export interface NotebookFindMatch {
  cellId: string;
  /** 单元格在 notebook 里的下标（提示文案用） */
  cellIndex: number;
  /** 匹配在单元格源码里的偏移（用于编辑后重新定位） */
  start: number;
  end: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  /** 命中行（去掉首尾空白，过长截断） */
  preview: string;
}

const PREVIEW_LIMIT = 100;

/** 每一行的起始偏移，二分定位行列时复用 */
function collectLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

/** 偏移 → Monaco 的 1-based 行列 */
function locate(lineStarts: number[], offset: number) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - lineStarts[low] + 1 };
}

/**
 * 在全部单元格源码里查找（大小写不敏感，和 Excel 查找面板一致）。
 * 空查询返回空数组；匹配不重叠。
 */
export function findNotebookMatches(
  cells: readonly NotebookFindCell[],
  query: string,
): NotebookFindMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const matches: NotebookFindMatch[] = [];
  cells.forEach((cell, cellIndex) => {
    const text = cell.source;
    const haystack = text.toLowerCase();
    const lineStarts = collectLineStarts(text);

    for (let from = 0; ; ) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      const start = locate(lineStarts, at);
      const end = locate(lineStarts, at + needle.length);
      const lineStart = lineStarts[start.line - 1];
      const lineEnd = start.line < lineStarts.length ? lineStarts[start.line] - 1 : text.length;
      const rawLine = text.slice(lineStart, lineEnd).trim();
      matches.push({
        cellId: cell.id,
        cellIndex,
        start: at,
        end: at + needle.length,
        startLine: start.line,
        startColumn: start.column,
        endLine: end.line,
        endColumn: end.column,
        preview:
          rawLine.length > PREVIEW_LIMIT ? `${rawLine.slice(0, PREVIEW_LIMIT)}…` : rawLine,
      });
      from = at + needle.length;
    }
  });
  return matches;
}

/** 命中在内容编辑前后的身份（单元格 + 偏移） */
export function notebookMatchKey(match: NotebookFindMatch): string {
  return `${match.cellId}:${match.start}`;
}
