/**
 * Jupyter Notebook（.ipynb）文档缓存与持久化。
 *
 * 解析后以原始 JSON 对象为准：每个 cell 都保留原始对象，编辑时只改写
 * source / cell_type / outputs，未建模的字段（id、attachments、metadata、
 * 未知顶层字段）原样写回。这样既不会“打开即丢字段”，也不需要依赖 nbformat。
 *
 * 文档按标签 id 常驻内存（切换标签/分屏不丢未保存改动），
 * 保存走既有的文本写入命令 `save_file`，无需新增 Rust 命令。
 */
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { stopNotebookKernel, type NotebookCellRunResult } from "@/services/notebookKernel";

export type NotebookCellType = "code" | "markdown" | "raw";

/** notebook 里的一个输出对象（stream / execute_result / display_data / error） */
export interface NotebookOutputJson {
  output_type?: string;
  name?: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  execution_count?: number | null;
  [key: string]: unknown;
}

/** notebook 里的一个 cell 原始对象，未建模字段原样保留 */
export interface NotebookCellJson {
  cell_type?: unknown;
  source?: unknown;
  execution_count?: unknown;
  outputs?: unknown;
  metadata?: unknown;
  id?: unknown;
  [key: string]: unknown;
}

export interface NotebookJson {
  cells?: unknown[];
  metadata?: unknown;
  nbformat?: unknown;
  nbformat_minor?: unknown;
  [key: string]: unknown;
}

export interface NotebookCell {
  /** 会话内稳定的本地 id：React key / 定位用，不写回文件 */
  id: string;
  cellType: NotebookCellType;
  /** 源码文本，行之间用 \n 分隔 */
  source: string;
  executionCount: number | null;
  /** 原始 JSON cell 对象，保存时直接序列化它 */
  raw: NotebookCellJson;
  /** 原始输出列表（未渲染），清空输出后随之清空 */
  outputs: NotebookOutputJson[];
}

export interface NotebookDoc {
  cells: NotebookCell[];
  /** 原始 notebook JSON（含 metadata 与未建模的顶层字段） */
  raw: NotebookJson;
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformatMinor: number;
  /** 下一次执行分配的 In[n] 编号（沿用文件里已有的最大值 +1） */
  executionSeq: number;
  /** 加载时对应的 FileTab.revision，外部修改后据此重新加载 */
  revision: number;
  /** 加载时的文件路径，另存为后随之更新 */
  path: string;
}

const docs = new Map<string, NotebookDoc>();
let localIdSeq = 0;

function nextLocalId() {
  localIdSeq += 1;
  return `nb-cell-${localIdSeq}`;
}

function normalizeCellType(value: unknown): NotebookCellType {
  return value === "markdown" || value === "raw" ? value : "code";
}

/** 源码可能是字符串，也可能是按行拆分的数组（Jupyter 默认写法） */
export function notebookSourceToText(value: unknown): string {
  if (Array.isArray(value)) return value.map((line) => String(line)).join("");
  return typeof value === "string" ? value : "";
}

/** 反向转换：保持原文件的行数组写法，字符串写法也保持字符串 */
function textToSource(text: string, previous: unknown): string | string[] {
  if (!Array.isArray(previous)) return text;
  if (!text) return [];
  const parts = text.split("\n");
  const lines: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const isLast = index === parts.length - 1;
    // 结尾换行会多切出一个空串，Jupyter 的行数组里不存在这种尾项
    if (isLast && parts[index] === "") break;
    lines.push(isLast ? parts[index] : `${parts[index]}\n`);
  }
  return lines;
}

function createEmptyNotebook(): NotebookJson {
  return {
    cells: [],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function createCellId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return random.padEnd(8, "0");
}

function readOutputs(value: unknown): NotebookOutputJson[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is NotebookOutputJson => Boolean(item) && typeof item === "object",
  );
}

/** 读取并解析 Notebook；已有同版本缓存时直接复用，避免重复解析 */
export async function loadNotebookDoc(
  tabId: string,
  path: string,
  revision: number,
): Promise<NotebookDoc> {
  const cached = docs.get(tabId);
  if (cached && cached.revision === revision && cached.path === path) {
    return cached;
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`无法读取文件（${detail}）`);
  }

  const text = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
  let raw: NotebookJson;
  if (!text.trim()) {
    // 空文件（例如编辑器里新建的 .ipynb）按空白 Notebook 打开，保存后才成为有效 JSON
    raw = createEmptyNotebook();
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`不是有效的 Jupyter Notebook（JSON 解析失败）：${detail}`);
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as NotebookJson).cells)) {
      throw new Error("不是有效的 Jupyter Notebook（缺少 cells 数组）");
    }
    raw = parsed as NotebookJson;
  }

  const nbformat = typeof raw.nbformat === "number" ? raw.nbformat : 4;
  const nbformatMinor =
    typeof raw.nbformat_minor === "number" ? raw.nbformat_minor : nbformat >= 4 ? 5 : 4;
  if (!raw.metadata || typeof raw.metadata !== "object" || Array.isArray(raw.metadata)) {
    raw.metadata = {};
  }
  raw.nbformat = nbformat;
  raw.nbformat_minor = nbformatMinor;

  const cells: NotebookCell[] = [];
  for (const item of raw.cells ?? []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const cellRaw = item as NotebookCellJson;
    cells.push({
      id: nextLocalId(),
      cellType: normalizeCellType(cellRaw.cell_type),
      source: notebookSourceToText(cellRaw.source),
      executionCount:
        typeof cellRaw.execution_count === "number" ? cellRaw.execution_count : null,
      raw: cellRaw,
      outputs: readOutputs(cellRaw.outputs),
    });
  }

  const doc: NotebookDoc = {
    cells,
    raw,
    metadata: raw.metadata as Record<string, unknown>,
    nbformat,
    nbformatMinor,
    executionSeq:
      cells.reduce(
        (max, cell) => (cell.executionCount !== null && cell.executionCount > max ? cell.executionCount : max),
        0,
      ) + 1,
    revision,
    path,
  };
  docs.set(tabId, doc);
  return doc;
}

/** 标签关闭时释放缓存，并终止该标签的 Python 内核；重复释放无副作用 */
export function evictNotebookDoc(tabId: string) {
  docs.delete(tabId);
  void stopNotebookKernel(tabId).catch(() => {});
}

function readMetadataText(metadata: Record<string, unknown>, group: string, key: string) {
  const section = metadata[group];
  if (!section || typeof section !== "object") return "";
  const value = (section as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/** Notebook 使用的语言（Monaco language id），缺省 python */
export function notebookLanguage(doc: NotebookDoc): string {
  const name =
    readMetadataText(doc.metadata, "language_info", "name") ||
    readMetadataText(doc.metadata, "kernelspec", "language");
  return name ? name.toLowerCase() : "python";
}

/** 头部展示用的内核名称 */
export function notebookKernelLabel(doc: NotebookDoc): string {
  return (
    readMetadataText(doc.metadata, "kernelspec", "display_name") || notebookLanguage(doc)
  );
}

/**
 * 序列化写盘（targetPath 用于“保存到默认文件夹”之类的另存）。
 * 行数组等写法沿用原文件，未知字段原样保留。
 */
export async function saveNotebookDoc(tabId: string, targetPath?: string): Promise<boolean> {
  const doc = docs.get(tabId);
  if (!doc) {
    throw new Error("Notebook 尚未加载完成");
  }

  // raw.cells 以内存中的单元格顺序为准（增删/移动都同步过）
  doc.raw.cells = doc.cells.map((cell) => cell.raw);
  doc.raw.nbformat = doc.nbformat;
  doc.raw.nbformat_minor = doc.nbformatMinor;

  const path = targetPath ?? doc.path;
  // 与 nbformat.write 一致：indent=1 + 结尾换行
  const content = `${JSON.stringify(doc.raw, null, 1)}\n`;
  await invoke("save_file", { path, content });
  doc.path = path;
  return true;
}

function findCell(doc: NotebookDoc, cellId: string) {
  return doc.cells.find((cell) => cell.id === cellId);
}

/** 更新单元格源码；返回是否真的发生变化 */
export function updateNotebookCellSource(
  doc: NotebookDoc,
  cellId: string,
  source: string,
): boolean {
  const cell = findCell(doc, cellId);
  if (!cell || cell.source === source) return false;
  cell.source = source;
  cell.raw.source = textToSource(source, cell.raw.source);
  return true;
}

/** 切换单元格类型（代码 / Markdown / Raw） */
export function setNotebookCellType(
  doc: NotebookDoc,
  cellId: string,
  cellType: NotebookCellType,
): boolean {
  const cell = findCell(doc, cellId);
  if (!cell || cell.cellType === cellType) return false;

  cell.cellType = cellType;
  cell.raw.cell_type = cellType;
  if (cellType === "code") {
    if (!Array.isArray(cell.raw.outputs)) cell.raw.outputs = [];
    if (cell.executionCount === null) cell.raw.execution_count = null;
    cell.outputs = readOutputs(cell.raw.outputs);
  } else {
    // 非代码单元格按 nbformat 不允许带执行计数与输出
    delete cell.raw.outputs;
    delete cell.raw.execution_count;
    cell.outputs = [];
    cell.executionCount = null;
  }
  return true;
}

/** 在 index 位置插入新单元格并返回它 */
export function insertNotebookCell(
  doc: NotebookDoc,
  index: number,
  cellType: NotebookCellType,
): NotebookCell {
  const raw: NotebookCellJson = { cell_type: cellType };
  if (cellType === "code") raw.execution_count = null;
  // nbformat 4.5 起每个 cell 必须有 id
  if (doc.nbformatMinor >= 5) raw.id = createCellId();
  raw.metadata = {};
  if (cellType === "code") raw.outputs = [];
  raw.source = "";

  const cell: NotebookCell = {
    id: nextLocalId(),
    cellType,
    source: "",
    executionCount: null,
    raw,
    outputs: [],
  };

  const at = Math.max(0, Math.min(index, doc.cells.length));
  doc.cells.splice(at, 0, cell);
  doc.raw.cells?.splice(at, 0, raw);
  return cell;
}

/** 删除单元格；返回它原来的位置（找不到时返回 -1） */
export function removeNotebookCell(doc: NotebookDoc, cellId: string): number {
  const index = doc.cells.findIndex((cell) => cell.id === cellId);
  if (index === -1) return -1;
  doc.cells.splice(index, 1);
  doc.raw.cells?.splice(index, 1);
  return index;
}

/** 上移/下移单元格；返回移动后的下标（未移动时返回 -1） */
export function moveNotebookCell(doc: NotebookDoc, cellId: string, delta: number): number {
  const index = doc.cells.findIndex((cell) => cell.id === cellId);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= doc.cells.length) return -1;

  const [cell] = doc.cells.splice(index, 1);
  doc.cells.splice(target, 0, cell);
  const rawCells = doc.raw.cells;
  if (rawCells) {
    const [rawCell] = rawCells.splice(index, 1);
    rawCells.splice(target, 0, rawCell);
  }
  return target;
}

/** 清空单元格输出；返回是否真的有输出被清掉 */
export function clearNotebookOutputs(doc: NotebookDoc, cellId: string): boolean {
  const cell = findCell(doc, cellId);
  if (!cell || cell.outputs.length === 0) return false;
  cell.outputs = [];
  cell.raw.outputs = [];
  return true;
}

/** 清空全部输出；返回清掉的单元格数量 */
export function clearAllNotebookOutputs(doc: NotebookDoc): number {
  let cleared = 0;
  for (const cell of doc.cells) {
    if (cell.outputs.length > 0) {
      cell.outputs = [];
      cell.raw.outputs = [];
      cleared += 1;
    }
  }
  return cleared;
}

/** 取下一个 In[n] 编号（Jupyter 语义：每次执行 +1，跨会话沿用文件里的最大值） */
export function nextExecutionCount(doc: NotebookDoc): number {
  const count = doc.executionSeq;
  doc.executionSeq += 1;
  return count;
}

/**
 * 把一次内核执行的结果写回单元格：替换旧输出、更新 In[n]。
 * 输出的形状与 nbformat 4 一致，保存后 Jupyter / Tern 也能直接显示。
 */
export function applyNotebookCellRun(
  doc: NotebookDoc,
  cellId: string,
  result: NotebookCellRunResult,
  executionCount: number,
): boolean {
  const cell = findCell(doc, cellId);
  if (!cell || cell.cellType !== "code") return false;

  const outputs: NotebookOutputJson[] = [];
  if (result.stdout) {
    outputs.push({ output_type: "stream", name: "stdout", text: result.stdout });
  }
  if (result.stderr) {
    outputs.push({ output_type: "stream", name: "stderr", text: result.stderr });
  }
  if (result.result !== null) {
    outputs.push({
      output_type: "execute_result",
      execution_count: executionCount,
      data: { "text/plain": result.result },
      metadata: {},
    });
  }
  if (result.error) {
    outputs.push({
      output_type: "error",
      ename: result.error.ename,
      evalue: result.error.evalue,
      // nbformat 的 traceback 是“每行自带换行”的数组
      traceback: result.error.traceback
        .split("\n")
        .filter((line, index, lines) => line !== "" || index < lines.length - 1)
        .map((line) => `${line}\n`),
    });
  }

  cell.outputs = outputs;
  cell.raw.outputs = outputs;
  cell.executionCount = executionCount;
  cell.raw.execution_count = executionCount;
  return true;
}

// ── ANSI 颜色 ────────────────────────────────────────────────────────────────
// Tern 等内核把 traceback 带 ANSI 转义写进 output，直接展示会出现 “[36m” 噪声。

export interface AnsiSpan {
  text: string;
  color?: string;
  bold?: boolean;
}

const ANSI_PALETTE: Record<number, string> = {
  30: "#3b3027",
  31: "#c0392b",
  32: "#2f7d5b",
  33: "#a67c00",
  34: "#2f6ea5",
  35: "#8e44ad",
  36: "#2b8a8a",
  37: "#6e6154",
  90: "#8a7a6a",
  91: "#d9503f",
  92: "#3fa372",
  93: "#c69a2a",
  94: "#4a8fd0",
  95: "#a86fc4",
  96: "#3aa9a9",
  97: "#9a8a7a",
};

/** 把带 ANSI SGR 转义的文本切成带颜色的片段（其余 CSI 序列直接丢弃） */
export function parseAnsi(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let color: string | undefined;
  let bold = false;
  let cursor = 0;

  const push = (chunk: string) => {
    if (!chunk) return;
    spans.push({ text: chunk, color, bold: bold || undefined });
  };

  const pattern = /\x1b\[([0-9;]*)m/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    push(text.slice(cursor, match.index));
    cursor = pattern.lastIndex;

    const codes = match[1] ? match[1].split(";").map(Number) : [0];
    for (const code of codes) {
      if (code === 0) {
        color = undefined;
        bold = false;
      } else if (code === 1) {
        bold = true;
      } else if (code === 22) {
        bold = false;
      } else if (code === 39) {
        color = undefined;
      } else if (ANSI_PALETTE[code]) {
        color = ANSI_PALETTE[code];
      }
    }
  }
  push(text.slice(cursor));

  // 去掉其它控制序列（光标移动、OSC 等），避免残留在输出里
  return spans.map((span) => ({
    ...span,
    text: span.text.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]/g, ""),
  }));
}
