/**
 * 粘贴表格 → Markdown 表格语法转换。
 *
 * 从网页复制的表格，剪贴板 text/plain 通常是 TSV（制表符分隔），
 * text/html 含 <table> 结构。两种来源都还原为 GFM 表格语法。
 */

function escapeTableCell(text: string): string {
  // 单元格内的 | 需转义；去掉首尾空白；换行转为 <br> 保持单行
  return text
    .replace(/\r\n|\r|\n/g, "<br>")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\|/g, "\\|");
}

function htmlToPlainText(html: string): string {
  // 将 <br> 与块级标签转为换行，再去标签、解码实体
  const withBreaks = html
    .replace(/<br\s*\/?>(?!\w)/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|td|th)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ");
  const withoutTags = withBreaks.replace(/<[^>]+>/g, "");
  const textarea = document.createElement("textarea");
  textarea.innerHTML = withoutTags;
  return textarea.value;
}

interface ParsedTable {
  rows: string[][];
}

function parseHtmlTable(tableEl: HTMLElement): ParsedTable | null {
  const rows: string[][] = [];
  const seen = new Set<HTMLElement>();

  const trList = Array.from(tableEl.querySelectorAll("tr"));
  if (trList.length === 0) return null;

  for (const tr of trList) {
    if (seen.has(tr)) continue;
    const cells: string[] = [];
    for (const cell of Array.from(tr.querySelectorAll("td,th"))) {
      cells.push(escapeTableCell(htmlToPlainText(cell.innerHTML)));
    }
    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  return rows.length > 0 ? { rows } : null;
}

export function htmlToMarkdownTable(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;

  const parsed = parseHtmlTable(table);
  if (!parsed) return null;

  return tableRowsToMarkdown(parsed.rows);
}

export function tsvToMarkdownTable(text: string): string | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return null;

  // 至少有一行含制表符才视为表格
  const hasTabs = lines.some((line) => line.includes("\t"));
  if (!hasTabs) return null;

  const rows = lines.map((line) =>
    line.split("\t").map((cell) => escapeTableCell(cell)),
  );

  // 列数需对齐；取最大列数，缺列补空
  const maxCols = Math.max(...rows.map((r) => r.length));
  const aligned = rows.map((r) =>
    r.length === maxCols ? r : [...r, ...Array(maxCols - r.length).fill("")],
  );

  return tableRowsToMarkdown(aligned);
}

function tableRowsToMarkdown(rows: string[][]): string {
  const colCount = Math.max(...rows.map((r) => r.length));
  const header = rows[0];
  const body = rows.slice(1);

  const normalizeRow = (r: string[]) =>
    r.length === colCount ? r : [...r, ...Array(colCount - r.length).fill("")];

  const headerCells = normalizeRow(header);
  const separator = headerCells.map(() => "---");
  const bodyRows = body.map(normalizeRow);

  const render = (cells: string[]) => `| ${cells.join(" | ")} |`;

  return [render(headerCells), render(separator), ...bodyRows.map(render)].join("\n");
}

/**
 * 尝试把剪贴板内容转为 Markdown 表格。返回 null 表示不是表格，走原生粘贴。
 */
export function clipboardToMarkdownTable(
  clipboardData: DataTransfer | null,
): string | null {
  if (!clipboardData) return null;

  const html = clipboardData.getData("text/html");
  if (html && /<table[\s>]/i.test(html)) {
    const md = htmlToMarkdownTable(html);
    if (md) return md;
  }

  const text = clipboardData.getData("text/plain");
  if (text) {
    const md = tsvToMarkdownTable(text);
    if (md) return md;
  }

  return null;
}
