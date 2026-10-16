/**
 * Excel 工作簿编辑模式。
 *
 * 走既有的二进制通道：读盘用 plugin-fs 原文读入，保存经统一入口
 * `saveActiveTab` → `saveTab` → `save_file_from_base64`，因此不需要新增 Rust 命令。
 * 工作簿对象常驻 excelDocs 缓存（切换标签/分屏不丢改动），本组件只做表格视图、
 * 单元格编辑与撤销栈。
 *
 * 渲染不直接读工作簿：ExcelJS 的 getCell 会顺带创建空行，进而被写回文件；
 * 因此展示层读一张只含非空单元格的快照，编辑时才落到工作簿。
 *
 * 图片走 ExcelJS 的浮动图（锚定到起始单元格），展示时按锚定范围裁剪在对应格子里，
 * 点击任意图片调起全屏预览（复用 store 的 imagePreview）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Columns3,
  FileSpreadsheet,
  ImagePlus,
  Info,
  Loader2,
  Plus,
  Redo2,
  Merge,
  PaintBucket,
  Rows3,
  Save,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import type { Cell, CellValue, Column, Row, Style, Workbook, Worksheet } from "exceljs";
import { loadExcelDoc, type ExcelDoc } from "@/services/excelDocs";
import { copyTextToClipboard } from "@/utils/clipboard";
import { useEditorStore } from "@/store/editor";
import { confirmDialog } from "@/utils/confirmDialog";
import ContextMenu from "@/components/ContextMenu";
import type { EditorModeContext, EditorModeAdapter } from "./types";

const DEFAULT_ROW_HEIGHT = 26;
const MIN_ROW_HEIGHT = 20;
const COLUMN_HEADER_HEIGHT = 26;
const ROW_HEADER_WIDTH = 54;
/** 未设置列宽时的默认像素宽 */
const DEFAULT_COLUMN_WIDTH = 96;
const MIN_COLUMN_WIDTH = 40;
/** 行头/列头上用于拖动调整尺寸的手柄厚度 */
const RESIZE_HANDLE_SIZE = 5;
/** 渲染上限：超大表格只展示前若干行/列，避免一次性建出巨量 DOM */
const MAX_RENDER_ROWS = 5000;
const MAX_RENDER_COLUMNS = 512;
/** 数据区下方额外留出的空行，方便直接往下录入 */
const TRAILING_EMPTY_ROWS = 10;
/** 默认网格规模：空表按 20 行 × 10 列铺开 */
const MIN_RENDER_ROWS = 20;
const MIN_RENDER_COLUMNS = 10;
const HISTORY_LIMIT = 200;

/** 单元格展示信息（表格渲染与右对齐判断都用它） */
interface CellSnapshot {
  text: string;
  numeric: boolean;
}

/** 合并区跨度（单位：单元格个数） */
interface MergeSpan {
  rowSpan: number;
  columnSpan: number;
}

/** 合并区索引：master 跨度 + slave→master 归属 */
interface MergeIndex {
  spans: Map<string, MergeSpan>;
  owners: Map<string, string>;
}

/** 只含非空单元格的工作表快照 */
interface SheetSnapshot {
  cells: Map<number, Map<number, CellSnapshot>>;
  merges: MergeIndex;
  /** 最大已用行/列号（至少 1） */
  rowCount: number;
  columnCount: number;
}

interface Selection {
  /** 活动单元格：编辑输入、粘贴、插入图片的落点 */
  row: number;
  column: number;
  /** 选区终点；与 row/column 相同即单格 */
  endRow: number;
  endColumn: number;
}

/** 单格选择 */
function cellSelection(row: number, column: number): Selection {
  return { row, column, endRow: row, endColumn: column };
}

/** 选区边界（1-based，含端点） */
function selectionBounds(selection: Selection) {
  return {
    top: Math.min(selection.row, selection.endRow),
    bottom: Math.max(selection.row, selection.endRow),
    left: Math.min(selection.column, selection.endColumn),
    right: Math.max(selection.column, selection.endColumn),
  };
}

function isCellInSelection(selection: Selection, row: number, column: number): boolean {
  const bounds = selectionBounds(selection);
  return row >= bounds.top && row <= bounds.bottom && column >= bounds.left && column <= bounds.right;
}

/** 选区是否只含一个单元格 */
function isSingleCell(selection: Selection): boolean {
  return selection.row === selection.endRow && selection.column === selection.endColumn;
}

/** 地址文本：B3 或 B3:D5 */
function selectionLabel(selection: Selection): string {
  const bounds = selectionBounds(selection);
  const start = `${columnLetter(bounds.left)}${bounds.top}`;
  return isSingleCell(selection) ? start : `${start}:${columnLetter(bounds.right)}${bounds.bottom}`;
}

/** 单元格展示文本 → 数值（容忍千分位与百分号），用于选区统计 */
function parseNumericText(text: string): number | null {
  const cleaned = text.replace(/,/g, "").trim();
  if (!cleaned) return null;
  const isPercent = cleaned.endsWith("%");
  const value = Number(isPercent ? cleaned.slice(0, -1) : cleaned);
  if (!Number.isFinite(value)) return null;
  return isPercent ? value / 100 : value;
}

/** exceljs 的 autoFilter 可以置空来移除筛选，但类型声明不接受 null */
function setAutoFilter(sheet: Worksheet, range: { from: string; to: string } | null) {
  sheet.autoFilter = range as unknown as Worksheet["autoFilter"];
}

/** 解析地址框输入：B12 或 B2:D5（$ 与大小写都可） */
function parseA1Range(
  raw: string,
): { startRow: number; startColumn: number; endRow?: number; endColumn?: number } | null {
  const match = /^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/.exec(raw.trim());
  if (!match) return null;

  const startColumn = columnIndexFromLetter(match[1]);
  const startRow = Number(match[2]);
  if (!startColumn || !startRow) return null;
  if (!match[3]) return { startRow, startColumn };

  const endColumn = columnIndexFromLetter(match[3]);
  const endRow = Number(match[4]);
  if (!endColumn || !endRow) return null;
  return { startRow, startColumn, endRow, endColumn };
}

/** 文本近似像素宽：全角字符按两倍算，用于列宽自适应 */
function measureTextWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += char.codePointAt(0)! > 0x2e80 ? 14 : 7.2;
  }
  return width;
}

/** 选区内的“已有内容”的格：样式类操作只作用于它们，避免为空格建出成片空行 */
function collectPresentCells(
  snapshot: SheetSnapshot,
  bounds: { top: number; bottom: number; left: number; right: number },
): { row: number; column: number }[] {
  const cells: { row: number; column: number }[] = [];
  for (let row = bounds.top; row <= bounds.bottom; row += 1) {
    const rowCells = snapshot.cells.get(row);
    if (!rowCells) continue;
    for (let column = bounds.left; column <= bounds.right; column += 1) {
      if (rowCells.has(column)) cells.push({ row, column });
    }
  }
  return cells;
}

/** Ctrl+Shift+1~6 对应的常用数字格式（Excel 习惯） */
const NUMBER_FORMAT_SHORTCUTS: Record<number, { format: string; label: string }> = {
  1: { format: "0.00", label: "数字格式" },
  2: { format: "hh:mm:ss", label: "时间格式" },
  3: { format: "yyyy-mm-dd", label: "日期格式" },
  4: { format: "¥#,##0.00", label: "货币格式" },
  5: { format: "0.00%", label: "百分比格式" },
  6: { format: "0.00E+00", label: "科学计数格式" },
};

/** 填充色板与字体色板 */
const FILL_PALETTE: { name: string; argb: string }[] = [
  { name: "浅黄", argb: "FFFFF2CC" },
  { name: "橙", argb: "FFF8CBAD" },
  { name: "浅红", argb: "FFFCE4E4" },
  { name: "浅绿", argb: "FFE2EFDA" },
  { name: "浅蓝", argb: "FFDDEBF7" },
  { name: "浅紫", argb: "FFE9E1F2" },
  { name: "浅灰", argb: "FFF2F2F2" },
  { name: "黄", argb: "FFFFE699" },
  { name: "绿", argb: "FFA9D08E" },
  { name: "蓝", argb: "FF9DC3E6" },
  { name: "红", argb: "FFFF9999" },
  { name: "灰", argb: "FFBFBFBF" },
];

const FONT_PALETTE: { name: string; argb: string }[] = [
  { name: "黑", argb: "FF000000" },
  { name: "深红", argb: "FFC00000" },
  { name: "橙", argb: "FFED7D31" },
  { name: "深黄", argb: "FFBF8F00" },
  { name: "绿", argb: "FF548235" },
  { name: "蓝", argb: "FF2E75B6" },
  { name: "深蓝", argb: "FF1F3864" },
  { name: "紫", argb: "FF7030A0" },
  { name: "灰", argb: "FF808080" },
  { name: "白", argb: "FFFFFFFF" },
];

/** exceljs 未在类型里暴露 orderNo，但 worksheets 的顺序就是按它排序的 */
function setWorksheetOrder(sheet: Worksheet, order: number) {
  (sheet as unknown as { orderNo?: number }).orderNo = order;
}

/** exceljs 的 spliceRows / spliceColumns 只用参数个数表达插入数量 */
function emptySlots(count: number): unknown[][] {
  return Array.from({ length: count }, () => []);
}

/** 结构变化后平移图片锚点（exceljs 不会自动移动图片；from 为 0-based 起始行/列） */
function shiftImageAnchors(sheet: Worksheet, axis: "row" | "column", from: number, delta: number) {
  for (const media of readSheetMedia(sheet)) {
    const range = media.range;
    if (!range) continue;
    for (const anchor of [range.tl, range.br]) {
      if (!anchor) continue;
      const value = axis === "row" ? anchor.row : anchor.col;
      if (typeof value !== "number" || value < from) continue;
      if (axis === "row") anchor.row = value + delta;
      else anchor.col = value + delta;
    }
  }
}

/** exceljs 的类型声明没暴露 Row.style（运行时存在，spliceRows 也会搬它） */
function readRowStyle(row: Row): Partial<Style> | undefined {
  return (row as unknown as { style?: Partial<Style> }).style;
}

function writeRowStyle(row: Row, style: Partial<Style>) {
  (row as unknown as { style?: Partial<Style> }).style = style;
}

interface RowSnapshot {
  values: unknown[];
  style: Partial<Style>;
  height?: number;
  cellStyles: { column: number; style: Partial<Style> }[];
}

/** 删除行前留档，供撤销恢复值/样式/行高 */
function captureRows(sheet: Worksheet, startRow: number, count: number): RowSnapshot[] {
  return Array.from({ length: count }, (_, offset) => {
    const row = sheet.getRow(startRow + offset);
    const cellStyles: { column: number; style: Partial<Style> }[] = [];
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      cellStyles.push({ column, style: cell.style });
    });
    return {
      values: row.values as unknown[],
      style: readRowStyle(row) ?? {},
      height: row.height,
      cellStyles,
    };
  });
}

function restoreRowSnapshot(sheet: Worksheet, rowNumber: number, snapshot: RowSnapshot) {
  const row = sheet.getRow(rowNumber);
  writeRowStyle(row, snapshot.style);
  if (typeof snapshot.height === "number") {
    row.height = snapshot.height;
  }
  for (const item of snapshot.cellStyles) {
    row.getCell(item.column).style = item.style;
  }
}

interface ColumnSnapshot {
  width?: number;
  cells: { row: number; value: CellValue; style: Partial<Style> }[];
}

/** 删除列前留档（含列宽与有值格的样式） */
function captureColumn(sheet: Worksheet, column: number): ColumnSnapshot {
  const cells: ColumnSnapshot["cells"] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cell = row.getCell(column);
    if (cell.value === null || cell.value === undefined) return;
    cells.push({ row: rowNumber, value: cell.value, style: cell.style });
  });
  return { width: sheet.getColumn(column).width, cells };
}

function restoreColumnSnapshot(sheet: Worksheet, column: number, snapshot: ColumnSnapshot) {
  if (typeof snapshot.width === "number") {
    sheet.getColumn(column).width = snapshot.width;
  }
  for (const item of snapshot.cells) {
    const cell = sheet.getRow(item.row).getCell(column);
    cell.value = item.value;
    cell.style = item.style;
  }
}

/** 工作表里是否存在公式（插入/删除行列不会调整公式引用，操作前用来提示） */
function sheetHasFormulas(sheet: Worksheet): boolean {
  let found = false;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (found) return;
    row.eachCell({ includeEmpty: false }, (cell) => {
      const value = cell.value;
      if (value && typeof value === "object" && ("formula" in value || "sharedFormula" in value)) {
        found = true;
      }
    });
  });
  return found;
}

interface CellChange {
  row: number;
  column: number;
  before: CellValue;
  after: CellValue;
}

interface HistoryEntry {
  sheetIndex: number;
  changes: CellChange[];
}

/** 结构操作的撤销项：用闭包保存逆操作，避免为每种操作写恢复逻辑 */
interface StructuralHistoryEntry {
  kind: "structure";
  sheetIndex: number;
  label: string;
  undo: () => void;
  redo: () => void;
}

type HistoryRecord = ({ kind: "cells" } & HistoryEntry) | StructuralHistoryEntry;

/** 1 → A、27 → AA */
function columnLetter(index: number): string {
  let value = index;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

/** 日期单元格按 numFmt 是否含时间部分决定展示到天还是到秒 */
function formatDateCell(date: Date, numFmt?: string): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  const cleaned = typeof numFmt === "string"
    ? numFmt.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, "")
    : "";
  if (!/[hH]/.test(cleaned)) return datePart;

  return `${datePart} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function describeCellValue(value: CellValue, numFmt: string | undefined, formatted: string): CellSnapshot {
  if (value instanceof Date) {
    return { text: formatDateCell(value, numFmt), numeric: true };
  }
  // exceljs 的 cell.text 对数字不套 numFmt（百分比会显示成 0.25），这里自己渲染
  if (typeof value === "number") {
    return { text: formatNumericCell(value, numFmt), numeric: true };
  }
  return { text: formatted ?? "", numeric: false };
}

/** 按常见 numFmt 渲染数字：小数位、千分位、百分比、货币前缀、科学计数 */
function formatNumericCell(value: number, numFmt?: string): string {
  if (!numFmt || numFmt === "General" || numFmt === "@") return String(value);

  const percent = numFmt.includes("%");
  const scientific = /E\+?0/i.test(numFmt);
  const decimals = (numFmt.split(".")[1] ?? "").replace(/[^0#]/g, "").length;
  const grouped = numFmt.includes("#,##");
  const currency = /^[^0#.\-]*[¥$€£]/.exec(numFmt)?.[0] ?? "";

  const scaled = percent ? value * 100 : value;
  if (scientific) return `${scaled.toExponential(decimals)}${percent ? "%" : ""}`;

  const [integerPart, fractionPart] = scaled.toFixed(decimals).split(".");
  const groupedInteger = grouped
    ? integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    : integerPart;
  const body = fractionPart ? `${groupedInteger}.${fractionPart}` : groupedInteger;
  return `${currency}${body}${percent ? "%" : ""}`;
}

/** 单元格原始值 → 可编辑文本（公式带 = 前缀） */
function cellEditText(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (value instanceof Date) return formatDateCell(value, undefined);
    if ("formula" in value && value.formula) return `=${value.formula}`;
    if ("sharedFormula" in value && value.sharedFormula) return `=${value.sharedFormula}`;
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return value.text;
    if ("error" in value) return String(value.error);
    return "";
  }
  return String(value);
}

/** 输入文本 → 单元格值：保留公式、数字、布尔、日期的语义 */
function parseCellInput(raw: string): CellValue {
  if (raw === "") return null;
  if (raw.startsWith("=")) return { formula: raw.slice(1) };

  const trimmed = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";

  const dateMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (dateMatch) {
    return new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]));
  }

  return raw;
}

function isSameCellValue(a: CellValue, b: CellValue): boolean {
  if (a === b) return true;
  const emptyA = a === null || a === undefined;
  const emptyB = b === null || b === undefined;
  if (emptyA || emptyB) return emptyA && emptyB;
  if (typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/** 列字母 → 列号：A → 1、AA → 27 */
function columnIndexFromLetter(letters: string): number {
  let index = 0;
  for (const char of letters.toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index;
}

/** exceljs 没有公开的合并区列表，而 `sheet.model` 会重建整表模型（大表代价高），
 *  因此直接读内部 `_merges`（值是带 top/left/bottom/right 的 Range）。 */
function readMergeRanges(sheet: Worksheet): { top: number; left: number; bottom: number; right: number }[] {
  if (!sheet.hasMerges) return [];
  const internal = sheet as unknown as {
    _merges?: Record<string, { top: number; left: number; bottom: number; right: number }>;
  };
  return Object.values(internal._merges ?? {});
}

/** 合并区里格数过多时不再逐格登记归属（避免为整列合并建出巨量键） */
const MAX_MERGE_SLAVES = 20000;

function buildMergeIndex(sheet: Worksheet): MergeIndex {
  const spans = new Map<string, MergeSpan>();
  const owners = new Map<string, string>();

  for (const range of readMergeRanges(sheet)) {
    const masterKey = `${range.top}:${range.left}`;
    spans.set(masterKey, {
      rowSpan: range.bottom - range.top + 1,
      columnSpan: range.right - range.left + 1,
    });

    const area = (range.bottom - range.top + 1) * (range.right - range.left + 1);
    if (area > MAX_MERGE_SLAVES) continue;

    for (let row = range.top; row <= range.bottom; row += 1) {
      for (let column = range.left; column <= range.right; column += 1) {
        if (row === range.top && column === range.left) continue;
        owners.set(`${row}:${column}`, masterKey);
      }
    }
  }

  return { spans, owners };
}

/** 列宽以字符为单位，与读取侧换算保持同一口径 */
function columnWidthToPixels(chars: number): number {
  return Math.max(MIN_COLUMN_WIDTH, Math.round(chars * 7.2) + 8);
}

function pixelsToColumnWidth(pixels: number): number {
  return Math.max(1, (pixels - 8) / 7.2);
}

/** 行高在文件里以磅为单位（96dpi 下 1pt = 4/3 px） */
function pointsToPixels(points: number): number {
  return (points * 4) / 3;
}

function pixelsToPoints(pixels: number): number {
  return Math.max(1, pixels * 0.75);
}

/** 已显式设置行高的行；`_rows` 是稀疏数组，按下标读不会像 getRow 那样创建空行 */
function readRowHeights(sheet: Worksheet): Record<number, number> {
  const rows = (sheet as unknown as { _rows?: ({ height?: number } | undefined)[] })._rows ?? [];
  const heights: Record<number, number> = {};
  rows.forEach((row, index) => {
    const points = row?.height;
    if (typeof points === "number" && points > 0) {
      heights[index + 1] = Math.max(MIN_ROW_HEIGHT, Math.round(pointsToPixels(points)));
    }
  });
  return heights;
}

/** 按工作表列宽定义换算像素宽；`sheet.columns` 是只读视图，不会写回文件 */
function columnWidthsPx(
  sheet: Worksheet,
  columnCount: number,
  overrides: Record<number, number>,
): number[] {
  const widths = new Array<number>(columnCount).fill(DEFAULT_COLUMN_WIDTH);

  // exceljs 的 columns 在“没有任何列定义”的工作表上是 null（构造初值），必须兜底
  const columns: Partial<Column>[] | null = sheet.columns;
  for (const column of columns ?? []) {
    const index = column.number;
    if (!index || index > columnCount) continue;
    if (typeof column.width === "number" && column.width > 0) {
      widths[index - 1] = columnWidthToPixels(column.width);
    }
  }
  // 拖动调整过的列宽优先
  for (const [key, pixels] of Object.entries(overrides)) {
    const index = Number(key);
    if (index >= 1 && index <= columnCount) widths[index - 1] = pixels;
  }
  return widths;
}

/** 工作表内嵌图片：锚定范围 + 媒体信息（url 是 buffer 生成的 blob URL） */
interface SheetImage {
  /** worksheet._media 中的下标，删除时定位用 */
  mediaIndex: number;
  imageId: number;
  /** 锚定范围（1-based，endRow/endColumn 为空表示只占起始单元格） */
  startRow: number;
  startColumn: number;
  endRow: number | null;
  endColumn: number | null;
  /** 无 br 锚点时给出的像素尺寸 */
  width: number;
  height: number;
  url: string;
  name: string;
  extension: string;
  byteLength: number;
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
};

/** ExcelJS 只接受 png / jpeg / gif 三种内嵌图片格式 */
function imageExtensionForWrite(filePath: string): "png" | "jpeg" | "gif" | null {
  const extension = filePath.split(".").pop()?.toLowerCase();
  if (extension === "png") return "png";
  if (extension === "jpg" || extension === "jpeg") return "jpeg";
  if (extension === "gif") return "gif";
  return null;
}

/** 剪贴板 MIME → ExcelJS 支持的扩展名 */
function imageExtensionFromMime(mime: string): "png" | "jpeg" | "gif" | null {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpeg";
  if (mime === "image/gif") return "gif";
  return null;
}

/** exceljs 未公开媒体列表（getImages() 会过滤背景图并丢失原始下标，删除与锚点解析都要用原数组） */
interface SheetMediaEntry {
  type?: string;
  imageId?: number;
  range?: {
    tl?: { col?: number; row?: number };
    br?: { col?: number; row?: number };
    ext?: { width?: number; height?: number };
  };
}

function readSheetMedia(sheet: Worksheet): SheetMediaEntry[] {
  return (sheet as unknown as { _media?: SheetMediaEntry[] })._media ?? [];
}

/** 媒体二进制：类型声明里 Workbook 没有 media，但运行时存在（元素带 name / extension / buffer） */
interface WorkbookMediaEntry {
  name?: string;
  extension?: string;
  buffer?: unknown;
}

function readWorkbookMedia(workbook: Workbook): WorkbookMediaEntry[] {
  return (workbook as unknown as { media?: WorkbookMediaEntry[] }).media ?? [];
}

/** 读取工作表内嵌图片，并为每张图建立可直接渲染的 blob URL */
function collectSheetImages(sheet: Worksheet, workbook: Workbook): SheetImage[] {
  const images: SheetImage[] = [];
  const media = readWorkbookMedia(workbook);

  readSheetMedia(sheet).forEach((entry, mediaIndex) => {
    // 背景图没有锚点，不放进单元格图片列表
    if (entry.type !== "image" || typeof entry.imageId !== "number") return;
    const source = media[entry.imageId];
    const anchor = entry.range?.tl;
    if (!source?.buffer || !anchor) return;

    const buffer = source.buffer as Uint8Array;
    const extension = (source.extension ?? "png").toLowerCase();
    images.push({
      mediaIndex,
      imageId: entry.imageId,
      startRow: (anchor.row ?? 0) + 1,
      startColumn: (anchor.col ?? 0) + 1,
      endRow: entry.range?.br ? (entry.range.br.row ?? 0) + 1 : null,
      endColumn: entry.range?.br ? (entry.range.br.col ?? 0) + 1 : null,
      width: entry.range?.ext?.width ?? 0,
      height: entry.range?.ext?.height ?? 0,
      url: URL.createObjectURL(
        new Blob([buffer as unknown as BlobPart], {
          type: IMAGE_MIME_BY_EXTENSION[extension] ?? "image/png",
        }),
      ),
      name: source.name ?? `图片${images.length + 1}`,
      extension,
      byteLength: buffer.byteLength ?? 0,
    });
  });

  return images;
}

/** 读取图片原始像素尺寸，失败时返回 0（调用方回落到单元格尺寸） */
async function measureImageBytes(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as unknown as BlobPart]));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

/** 选中格是否落在图片的锚定范围内 */
function isCellInImage(image: SheetImage, row: number, column: number): boolean {
  const endRow = image.endRow ?? image.startRow;
  const endColumn = image.endColumn ?? image.startColumn;
  return row >= image.startRow && row <= endRow && column >= image.startColumn && column <= endColumn;
}

/** 合并区从属格 → 左上角 master；自由格原样返回 */
function resolveMergeOwner(
  merges: MergeIndex,
  row: number,
  column: number,
): { row: number; column: number } {
  const owner = merges.owners.get(`${row}:${column}`);
  if (!owner) return { row, column };
  const [ownerRow, ownerColumn] = owner.split(":").map(Number);
  return { row: ownerRow, column: ownerColumn };
}

/** 首次展示某工作表时建快照；eachRow/eachCell 只读，不会创建空行 */
function buildSheetSnapshot(sheet: Worksheet): SheetSnapshot {
  const merges = buildMergeIndex(sheet);
  const snapshot: SheetSnapshot = { cells: new Map(), merges, rowCount: 1, columnCount: 1 };

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const value = cell.value;
      if (value === null || value === undefined || value === "") return;
      // 合并区的从属格会代理 master 的值，跳过以免重复显示
      if (merges.owners.has(`${rowNumber}:${columnNumber}`)) return;

      let rowCells = snapshot.cells.get(rowNumber);
      if (!rowCells) {
        rowCells = new Map();
        snapshot.cells.set(rowNumber, rowCells);
      }
      rowCells.set(columnNumber, describeCellValue(value, cell.numFmt, cell.text));
      snapshot.rowCount = Math.max(snapshot.rowCount, rowNumber);
      snapshot.columnCount = Math.max(snapshot.columnCount, columnNumber);
    });
  });

  return snapshot;
}

/** 编辑后同步快照中的单个单元格（空值则删除该格） */
function refreshSnapshotCell(
  snapshot: SheetSnapshot,
  sheet: Worksheet,
  row: number,
  column: number,
) {
  const cell = sheet.getCell(row, column);
  const value = cell.value;
  const rowCells = snapshot.cells.get(row);

  if (value === null || value === undefined || value === "") {
    if (!rowCells) return;
    rowCells.delete(column);
    if (rowCells.size === 0) snapshot.cells.delete(row);
    return;
  }

  const target = rowCells ?? new Map<number, CellSnapshot>();
  if (!rowCells) snapshot.cells.set(row, target);
  target.set(column, describeCellValue(value, cell.numFmt, cell.text));
  snapshot.rowCount = Math.max(snapshot.rowCount, row);
  snapshot.columnCount = Math.max(snapshot.columnCount, column);
}

function ExcelModeView({
  activeTab,
  showNotification,
  saveActiveTab,
}: Pick<EditorModeContext, "activeTab" | "showNotification" | "saveActiveTab">) {
  const markTabDirty = useEditorStore((state) => state.markTabDirty);
  const openImagePreview = useEditorStore((state) => state.openImagePreview);
  const [doc, setDoc] = useState<ExcelDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [selection, setSelection] = useState<Selection>(() => cellSelection(1, 1));
  const [editing, setEditing] = useState<{ row: number; column: number; value: string } | null>(null);
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [viewport, setViewport] = useState({ width: 900, height: 500 });
  const [saving, setSaving] = useState(false);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  // 编辑/撤销会改变数据规模与列宽，用它触发布局与快照重算
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [images, setImages] = useState<SheetImage[]>([]);
  // 插入/删除图片后靠它重新收集当前工作表的图片
  const [imagesVersion, setImagesVersion] = useState(0);
  const [rowColumnMenu, setRowColumnMenu] = useState<{ x: number; y: number } | null>(null);
  const [sheetMenu, setSheetMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const [renamingSheet, setRenamingSheet] = useState<{ index: number; value: string } | null>(null);
  const [dragSheetIndex, setDragSheetIndex] = useState<number | null>(null);
  const [formatMenu, setFormatMenu] = useState<{ x: number; y: number } | null>(null);
  const [palette, setPalette] = useState<{ x: number; y: number; target: "fill" | "font" } | null>(null);
  const [addressInput, setAddressInput] = useState<string | null>(null);
  const [findPanel, setFindPanel] = useState(false);
  const [cellMenu, setCellMenu] = useState<{ x: number; y: number } | null>(null);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [fillPreview, setFillPreview] = useState<{
    top: number;
    bottom: number;
    left: number;
    right: number;
  } | null>(null);
  const [insertingImage, setInsertingImage] = useState(false);
  // 拖动调整的行高/列宽（像素），拖动过程中即时生效，松开后写入工作簿
  const [columnOverrides, setColumnOverrides] = useState<Record<number, number>>({});
  const [rowOverrides, setRowOverrides] = useState<Record<number, number>>({});
  const [resizing, setResizing] = useState<{ axis: "column" | "row"; index: number } | null>(null);
  const [resizeSize, setResizeSize] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const sheetTabsRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<{ entries: HistoryRecord[]; index: number }>({ entries: [], index: -1 });
  const snapshotsRef = useRef<Map<number, SheetSnapshot>>(new Map());
  /** 文件里已定义的行高基线；只按 doc/sheet 变化重读，避免每次布局都遍历行 */
  const storedRowHeightsRef = useRef<Record<number, number>>({});
  const resizeRef = useRef<{
    axis: "column" | "row";
    index: number;
    startPos: number;
    startSize: number;
    size: number;
  } | null>(null);
  /** 鼠标按下后是否处于拖拽选择中 */
  const dragSelectRef = useRef(false);
  /** 填充柄拖拽：源区域与当前预览区域 */
  const fillDragRef = useRef<{ top: number; bottom: number; left: number; right: number } | null>(null);
  const fillPreviewRef = useRef<{ top: number; bottom: number; left: number; right: number } | null>(null);

  const revision = activeTab.revision ?? 0;
  const isReadOnly = Boolean(activeTab.isReadOnly);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setEditing(null);

    void loadExcelDoc(activeTab.id, activeTab.path, revision)
      .then((loaded) => {
        if (cancelled) return;
        if (loaded.workbook.worksheets.length === 0) {
          setDoc(null);
          setError("工作簿里没有可显示的工作表");
          return;
        }
        setDoc(loaded);
        setSheetIndex(0);
        setSelection(cellSelection(1, 1));
        snapshotsRef.current = new Map();
        historyRef.current = { entries: [], index: -1 };
        setHistoryState({ canUndo: false, canRedo: false });
        setLayoutVersion((version) => version + 1);
      })
      .catch((err) => {
        if (cancelled) return;
        const detail = err instanceof Error ? err.message : String(err);
        setDoc(null);
        setError(detail || "无法解析该 Excel 文件");
        showNotification(`Excel 加载失败: ${detail}`, "error");
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab.id, activeTab.path, revision, showNotification]);

  // 图片是二进制资源：按工作表重建成 blob URL，切表/重载时释放旧 URL
  useEffect(() => {
    const sheet = doc?.workbook.worksheets[sheetIndex];
    if (!doc || !sheet) {
      setImages([]);
      return;
    }

    const collected = collectSheetImages(sheet, doc.workbook);
    setImages(collected);
    return () => {
      collected.forEach((image) => URL.revokeObjectURL(image.url));
    };
  }, [doc, sheetIndex, imagesVersion]);

  // 换文件/换工作表：重读行高基线，并清掉上一张表的拖动结果
  useEffect(() => {
    const sheet = doc?.workbook.worksheets[sheetIndex];
    storedRowHeightsRef.current = sheet ? readRowHeights(sheet) : {};
    setColumnOverrides({});
    setRowOverrides({});
    setLayoutVersion((version) => version + 1);
  }, [doc, sheetIndex]);

  useEffect(() => {
    const node = gridRef.current;
    if (!node) return;

    const measure = () => setViewport({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [doc]);

  useEffect(() => {
    if (!editing) return;
    const input = editInputRef.current;
    input?.focus();
    input?.select();
  }, [editing]);

  // 切换或新增工作表后，把当前标签滚进可视区
  useEffect(() => {
    sheetTabsRef.current
      ?.querySelector<HTMLElement>(`[data-sheet-index="${sheetIndex}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [sheetIndex, doc]);

  const layout = useMemo(() => {
    const sheet = doc?.workbook.worksheets[sheetIndex];
    if (!sheet) return null;

    // 快照按 sheet 懒建：可变对象，编辑时就地更新后由 layoutVersion 触发重算
    let snapshot = snapshotsRef.current.get(sheetIndex);
    if (!snapshot) {
      snapshot = buildSheetSnapshot(sheet);
      snapshotsRef.current.set(sheetIndex, snapshot);
    }

    const rowCount = Math.min(
      Math.max(snapshot.rowCount + TRAILING_EMPTY_ROWS, MIN_RENDER_ROWS),
      MAX_RENDER_ROWS,
    );
    const columnCount = Math.min(
      Math.max(snapshot.columnCount + 2, MIN_RENDER_COLUMNS),
      MAX_RENDER_COLUMNS,
    );

    const widths = columnWidthsPx(sheet, columnCount, columnOverrides);
    const columnOffsets: number[] = [];
    let columnCursor = 0;
    for (let index = 0; index < columnCount; index += 1) {
      columnOffsets.push(columnCursor);
      columnCursor += widths[index];
    }

    // 行高：文件里的定义 → 拖动调整值 → 默认值
    const heights = new Array<number>(rowCount).fill(DEFAULT_ROW_HEIGHT);
    for (const [key, pixels] of Object.entries(storedRowHeightsRef.current)) {
      const index = Number(key);
      if (index >= 1 && index <= rowCount) heights[index - 1] = pixels;
    }
    for (const [key, pixels] of Object.entries(rowOverrides)) {
      const index = Number(key);
      if (index >= 1 && index <= rowCount) heights[index - 1] = pixels;
    }
    const rowOffsets: number[] = [];
    let rowCursor = 0;
    for (let index = 0; index < rowCount; index += 1) {
      rowOffsets.push(rowCursor);
      rowCursor += heights[index];
    }

    return {
      sheet,
      snapshot,
      rowCount,
      columnCount,
      widths,
      offsets: columnOffsets,
      heights,
      rowOffsets,
      totalWidth: columnCursor,
      totalHeight: rowCursor,
    };
  }, [doc, sheetIndex, layoutVersion, columnOverrides, rowOverrides]);

  const visibleRows = useMemo(() => {
    if (!layout) return [];
    const { rowCount, rowOffsets } = layout;

    // 行高不等，二分找到首个可视行
    let low = 0;
    let high = rowCount - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (rowOffsets[middle] <= scroll.top) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }

    const limit = scroll.top + viewport.height;
    const rows: number[] = [];
    for (let index = low; index < rowCount; index += 1) {
      if (rowOffsets[index] > limit) break;
      rows.push(index + 1);
    }
    return rows;
  }, [layout, scroll.top, viewport.height]);

  const visibleColumns = useMemo(() => {
    if (!layout) return [];
    const columns: number[] = [];
    for (let column = 1; column <= layout.columnCount; column += 1) {
      const left = layout.offsets[column - 1];
      if (left + layout.widths[column - 1] < scroll.left) continue;
      if (left > scroll.left + viewport.width) break;
      columns.push(column);
    }
    return columns;
  }, [layout, scroll.left, viewport.width]);

  // 选中格移出视口时自动滚动跟随
  useEffect(() => {
    const node = gridRef.current;
    if (!node || !layout) return;

    const top = layout.rowOffsets[selection.row - 1] ?? 0;
    const bottom = top + (layout.heights[selection.row - 1] ?? DEFAULT_ROW_HEIGHT);
    if (top < node.scrollTop) {
      node.scrollTop = top;
    } else if (bottom > node.scrollTop + node.clientHeight) {
      node.scrollTop = bottom - node.clientHeight;
    }

    const left = layout.offsets[selection.column - 1] ?? 0;
    const right = left + (layout.widths[selection.column - 1] ?? 0);
    if (left < node.scrollLeft) {
      node.scrollLeft = left;
    } else if (right > node.scrollLeft + node.clientWidth) {
      node.scrollLeft = right - node.clientWidth;
    }
  }, [selection, layout]);

  const pushHistory = useCallback((entry: HistoryRecord) => {
    const history = historyRef.current;
    history.entries = history.entries.slice(0, history.index + 1);
    history.entries.push(entry);
    if (history.entries.length > HISTORY_LIMIT) {
      history.entries.shift();
    }
    history.index = history.entries.length - 1;
    setHistoryState({ canUndo: true, canRedo: false });
  }, []);

  const applyHistory = useCallback(
    (direction: -1 | 1) => {
      const history = historyRef.current;
      const entry = history.entries[history.index];
      if (!entry || !doc) return;

      const sheet = doc.workbook.worksheets[entry.sheetIndex];
      if (!sheet) return;

      history.index += direction;
      setHistoryState({
        canUndo: history.index >= 0,
        canRedo: history.index < history.entries.length - 1,
      });
      setSheetIndex(entry.sheetIndex);

      if (entry.kind === "structure") {
        // 结构操作自带逆操作，执行后整表缓存作废
        if (direction === -1) entry.undo();
        else entry.redo();
        snapshotsRef.current.delete(entry.sheetIndex);
        setLayoutVersion((version) => version + 1);
        setImagesVersion((version) => version + 1);
        markTabDirty(activeTab.id);
        return;
      }

      const snapshot = snapshotsRef.current.get(entry.sheetIndex);
      for (const change of entry.changes) {
        sheet.getCell(change.row, change.column).value =
          direction === -1 ? change.before : change.after;
        if (snapshot) {
          refreshSnapshotCell(snapshot, sheet, change.row, change.column);
        }
      }

      setSelection(cellSelection(entry.changes[0].row, entry.changes[0].column));
      setLayoutVersion((version) => version + 1);
      markTabDirty(activeTab.id);
    },
    [activeTab.id, doc, markTabDirty],
  );

  /** 批量写入单元格并记入撤销栈（单格编辑与多格粘贴共用） */
  const applyChanges = useCallback(
    (changes: CellChange[]) => {
      if (!doc || changes.length === 0) return;

      const snapshot = snapshotsRef.current.get(sheetIndex);
      const sheet = doc.workbook.worksheets[sheetIndex];
      if (snapshot && sheet) {
        for (const change of changes) {
          refreshSnapshotCell(snapshot, sheet, change.row, change.column);
        }
      }

      pushHistory({ kind: "cells", sheetIndex, changes });
      setLayoutVersion((version) => version + 1);
      markTabDirty(activeTab.id);
    },
    [doc, markTabDirty, pushHistory, sheetIndex],
  );

  /** 结构变化后作废该工作表的快照与图片缓存 */
  const invalidateSheetCaches = useCallback((index: number) => {
    snapshotsRef.current.delete(index);
    setLayoutVersion((version) => version + 1);
    setImagesVersion((version) => version + 1);
  }, []);

  /** 执行结构操作并记入撤销栈：redo 立即执行，undo 用闭包保存的逆操作 */
  const applyStructural = useCallback(
    (label: string, undo: () => void, redo: () => void) => {
      redo();
      pushHistory({ kind: "structure", sheetIndex, label, undo, redo });
      invalidateSheetCaches(sheetIndex);
      markTabDirty(activeTab.id);
    },
    [activeTab.id, invalidateSheetCaches, markTabDirty, pushHistory, sheetIndex],
  );

  /** 插入/删除行列前提醒：exceljs 不会调整公式引用 */
  const confirmFormulaCaveat = useCallback(async (): Promise<boolean> => {
    const sheet = doc?.workbook.worksheets[sheetIndex];
    if (!sheet || !sheetHasFormulas(sheet)) return true;

    return await confirmDialog({
      title: "公式引用不会自动调整",
      message:
        `"${sheet.name}" 里含公式。插入或删除行列后，公式中的单元格引用不会被改写` +
        "（Excel 会自动调整），请核对公式结果，或先另存为副本再操作。是否继续？",
      kind: "warning",
    });
  }, [doc, sheetIndex]);

  /** 在 startRow（1-based）上方插入 count 行 */
  const insertRows = useCallback(
    async (startRow: number, count: number) => {
      const sheet = doc?.workbook.worksheets[sheetIndex];
      if (!sheet || count < 1) return;
      if (!(await confirmFormulaCaveat())) return;

      applyStructural(
        `插入 ${count} 行`,
        () => {
          sheet.spliceRows(startRow, count);
          shiftImageAnchors(sheet, "row", startRow - 1, -count);
        },
        () => {
          sheet.spliceRows(startRow, 0, ...emptySlots(count));
          shiftImageAnchors(sheet, "row", startRow - 1, count);
        },
      );
      showNotification(`已插入 ${count} 行`, "success");
    },
    [applyStructural, confirmFormulaCaveat, doc, sheetIndex, showNotification],
  );

  /** 删除 startRow 起的 count 行（撤销时回填值/样式/行高） */
  const deleteRows = useCallback(
    async (startRow: number, count: number) => {
      const sheet = doc?.workbook.worksheets[sheetIndex];
      if (!sheet || count < 1) return;
      if (!(await confirmFormulaCaveat())) return;

      const captured = captureRows(sheet, startRow, count);
      applyStructural(
        `删除 ${count} 行`,
        () => {
          sheet.spliceRows(startRow, 0, ...emptySlots(count));
          captured.forEach((item, offset) => restoreRowSnapshot(sheet, startRow + offset, item));
          shiftImageAnchors(sheet, "row", startRow - 1, count);
        },
        () => {
          sheet.spliceRows(startRow, count);
          shiftImageAnchors(sheet, "row", startRow - 1, -count);
        },
      );
      showNotification(`已删除 ${count} 行`, "success");
    },
    [applyStructural, confirmFormulaCaveat, doc, sheetIndex, showNotification],
  );

  /** 在 startColumn（1-based）左侧插入 count 列 */
  const insertColumns = useCallback(
    async (startColumn: number, count: number) => {
      const sheet = doc?.workbook.worksheets[sheetIndex];
      if (!sheet || count < 1) return;
      if (!(await confirmFormulaCaveat())) return;

      applyStructural(
        `插入 ${count} 列`,
        () => {
          sheet.spliceColumns(startColumn, count);
          shiftImageAnchors(sheet, "column", startColumn - 1, -count);
        },
        () => {
          sheet.spliceColumns(startColumn, 0, ...emptySlots(count));
          shiftImageAnchors(sheet, "column", startColumn - 1, count);
        },
      );
      showNotification(`已插入 ${count} 列`, "success");
    },
    [applyStructural, confirmFormulaCaveat, doc, sheetIndex, showNotification],
  );

  /** 删除 startColumn 起的 count 列（撤销时回填列宽与有值格） */
  const deleteColumns = useCallback(
    async (startColumn: number, count: number) => {
      const sheet = doc?.workbook.worksheets[sheetIndex];
      if (!sheet || count < 1) return;
      if (!(await confirmFormulaCaveat())) return;

      const captured = Array.from({ length: count }, (_, offset) =>
        captureColumn(sheet, startColumn + offset),
      );
      applyStructural(
        `删除 ${count} 列`,
        () => {
          sheet.spliceColumns(startColumn, 0, ...emptySlots(count));
          captured.forEach((item, offset) =>
            restoreColumnSnapshot(sheet, startColumn + offset, item),
          );
          shiftImageAnchors(sheet, "column", startColumn - 1, count);
        },
        () => {
          sheet.spliceColumns(startColumn, count);
          shiftImageAnchors(sheet, "column", startColumn - 1, -count);
        },
      );
      showNotification(`已删除 ${count} 列`, "success");
    },
    [applyStructural, confirmFormulaCaveat, doc, sheetIndex, showNotification],
  );

  /** 按内容自适应列宽（列头手柄双击 / 行列菜单） */
  const autoFitColumn = useCallback(
    (column: number) => {
      const sheet = doc?.workbook.worksheets[sheetIndex];
      if (!sheet || !layout) return;

      let widest = MIN_COLUMN_WIDTH;
      for (const rowCells of layout.snapshot.cells.values()) {
        const cell = rowCells.get(column);
        if (!cell) continue;
        widest = Math.max(widest, measureTextWidth(cell.text));
      }

      const width = Math.min(600, Math.round(widest) + 16);
      setColumnOverrides((previous) => ({ ...previous, [column]: width }));
      sheet.getColumn(column).width = pixelsToColumnWidth(width);
      markTabDirty(activeTab.id);
    },
    [activeTab.id, doc, layout, markTabDirty, sheetIndex],
  );

  /** 对选区内的已有格应用样式；旧样式留档供撤销，数字格式变化会重算显示文本 */
  const applyStyleToSelection = useCallback(
    (label: string, mutate: (cell: Cell) => void) => {
      if (isReadOnly || !doc || !layout) return;
      const sheet = doc.workbook.worksheets[sheetIndex];
      const snapshot = layout.snapshot;
      const targets = collectPresentCells(snapshot, selectionBounds(selection));
      if (targets.length === 0) {
        showNotification("选区内没有内容，格式只作用于已有数据的单元格", "info");
        return;
      }

      const before = targets.map((target) => ({
        ...target,
        style: sheet.getCell(target.row, target.column).style,
      }));

      const applyStyles = () => {
        for (const target of targets) {
          mutate(sheet.getCell(target.row, target.column));
          refreshSnapshotCell(snapshot, sheet, target.row, target.column);
        }
      };

      const restoreStyles = () => {
        for (const entry of before) {
          const cell = sheet.getCell(entry.row, entry.column);
          cell.style = entry.style;
          refreshSnapshotCell(snapshot, sheet, entry.row, entry.column);
        }
      };

      applyStructural(label, restoreStyles, applyStyles);
    },
    [applyStructural, doc, isReadOnly, layout, selection, sheetIndex, showNotification],
  );

  const toggleFontStyle = useCallback(
    (key: "bold" | "italic" | "underline", label: string) => {
      if (!doc || !layout) return;
      const sheet = doc.workbook.worksheets[sheetIndex];
      const hasValue = layout.snapshot.cells.get(selection.row)?.has(selection.column) ?? false;
      const current = hasValue
        ? Boolean(sheet.getCell(selection.row, selection.column).font?.[key])
        : false;

      applyStyleToSelection(label, (cell) => {
        cell.font = { ...(cell.font ?? {}), [key]: !current };
      });
    },
    [applyStyleToSelection, doc, layout, selection, sheetIndex],
  );

  const applyNumberFormat = useCallback(
    (format: string, label: string) => {
      applyStyleToSelection(label, (cell) => {
        cell.numFmt = format;
      });
    },
    [applyStyleToSelection],
  );

  const applyAlignment = useCallback(
    (horizontal: "left" | "center" | "right", label: string) => {
      applyStyleToSelection(label, (cell) => {
        cell.alignment = { ...(cell.alignment ?? {}), horizontal };
      });
    },
    [applyStyleToSelection],
  );

  const applyColor = useCallback(
    (target: "fill" | "font", argb: string | null) => {
      if (target === "fill") {
        applyStyleToSelection(argb ? "设置填充色" : "清除填充色", (cell) => {
          cell.fill = argb
            ? { type: "pattern", pattern: "solid", fgColor: { argb } }
            : { type: "pattern", pattern: "none" };
        });
        return;
      }

      applyStyleToSelection(argb ? "设置字体颜色" : "恢复默认字体色", (cell) => {
        cell.font = { ...(cell.font ?? {}), color: argb ? { argb } : undefined };
      });
    },
    [applyStyleToSelection],
  );

  /** 合并 / 取消合并所选区域（单格无效） */
  const toggleMerge = useCallback(() => {
    if (isReadOnly || !doc || !layout) return;
    const sheet = doc.workbook.worksheets[sheetIndex];
    const bounds = selectionBounds(selection);
    if (bounds.top === bounds.bottom && bounds.left === bounds.right) {
      showNotification("请先选择至少两个单元格", "info");
      return;
    }

    const range = `${columnLetter(bounds.left)}${bounds.top}:${columnLetter(bounds.right)}${bounds.bottom}`;
    const alreadyMerged = layout.snapshot.merges.spans.has(`${bounds.top}:${bounds.left}`);
    const merge = () => {
      try {
        sheet.mergeCells(range);
      } catch {
        // 与已有合并区重叠时 exceljs 会抛错
      }
    };
    const unmerge = () => {
      try {
        sheet.unMergeCells(range);
      } catch {
        // 未合并时忽略
      }
    };

    if (alreadyMerged) {
      applyStructural("取消合并", merge, unmerge);
      showNotification("已取消合并", "success");
    } else {
      applyStructural("合并单元格", unmerge, merge);
      showNotification("已合并单元格", "success");
    }
  }, [applyStructural, doc, isReadOnly, layout, selection, sheetIndex, showNotification]);

  /** 活动单元格的粗体/斜体/下划线状态（工具栏按钮高亮用） */
  const activeFont = useMemo(() => {
    const sheet = doc?.workbook.worksheets[sheetIndex];
    const hasValue = layout?.snapshot.cells.get(selection.row)?.has(selection.column) ?? false;
    const font = sheet && hasValue ? sheet.getCell(selection.row, selection.column).font : undefined;
    return {
      bold: Boolean(font?.bold),
      italic: Boolean(font?.italic),
      underline: Boolean(font?.underline),
    };
  }, [doc, layout, selection, sheetIndex]);

  /** 按选区首列对选区内的行排序（值 + 样式一起搬，可撤销） */
  const sortSelection = useCallback(
    (ascending: boolean) => {
      const sheet = doc?.workbook.worksheets[sheetIndex];
      if (!sheet || !layout) return;

      const bounds = selectionBounds(selection);
      if (bounds.top === bounds.bottom) {
        showNotification("请选择至少两行再排序", "info");
        return;
      }

      const rows: {
        keyText: string;
        keyNumber: number | null;
        cells: { value: CellValue; style: Partial<Style> }[];
      }[] = [];
      for (let row = bounds.top; row <= bounds.bottom; row += 1) {
        const cells: { value: CellValue; style: Partial<Style> }[] = [];
        for (let column = bounds.left; column <= bounds.right; column += 1) {
          const cell = sheet.getCell(row, column);
          cells.push({ value: cell.value, style: cell.style });
        }
        const keyText = layout.snapshot.cells.get(row)?.get(bounds.left)?.text ?? "";
        rows.push({ keyText, keyNumber: parseNumericText(keyText), cells });
      }

      const ordered = [...rows].sort((a, b) => {
        const comparison =
          a.keyNumber !== null && b.keyNumber !== null
            ? a.keyNumber - b.keyNumber
            : a.keyText.localeCompare(b.keyText, "zh-Hans-CN");
        return ascending ? comparison : -comparison;
      });

      const writeOrder = (source: typeof rows) => {
        source.forEach((item, offset) => {
          item.cells.forEach((cell, columnOffset) => {
            const target = sheet.getCell(bounds.top + offset, bounds.left + columnOffset);
            target.value = cell.value;
            target.style = cell.style;
          });
        });
      };

      applyStructural(
        ascending ? "升序排序" : "降序排序",
        () => writeOrder(rows),
        () => writeOrder(ordered),
      );
      showNotification(`已按 ${columnLetter(bounds.left)} 列${ascending ? "升序" : "降序"}排序`, "success");
    },
    [applyStructural, doc, layout, selection, sheetIndex, showNotification],
  );

  /** 自动筛选开关（作用于当前选区） */
  const toggleAutoFilter = useCallback(() => {
    const sheet = doc?.workbook.worksheets[sheetIndex];
    if (!sheet || !layout) return;

    const bounds = selectionBounds(selection);
    const range = {
      from: `${columnLetter(bounds.left)}${bounds.top}`,
      to: `${columnLetter(bounds.right)}${bounds.bottom}`,
    };
    const enabled = Boolean(sheet.autoFilter);

    if (enabled) {
      applyStructural(
        "关闭自动筛选",
        () => setAutoFilter(sheet, range),
        () => setAutoFilter(sheet, null),
      );
      showNotification("已关闭自动筛选", "success");
      return;
    }

    applyStructural(
      "启用自动筛选",
      () => setAutoFilter(sheet, null),
      () => setAutoFilter(sheet, range),
    );
    showNotification(`已启用自动筛选（${range.from}:${range.to}）`, "success");
  }, [applyStructural, doc, layout, selection, sheetIndex, showNotification]);

  /** 当前工作表的匹配单元格（查找面板用，按行列顺序） */
  const findMatches = useMemo(() => {
    if (!layout || !findText.trim()) return [];
    const needle = findText.trim().toLowerCase();
    const matches: { row: number; column: number }[] = [];

    for (const [row, rowCells] of layout.snapshot.cells) {
      for (const [column, cell] of rowCells) {
        if (cell.text.toLowerCase().includes(needle)) matches.push({ row, column });
      }
    }

    return matches.sort((a, b) => (a.row - b.row) || (a.column - b.column));
  }, [findText, layout]);

  const gotoMatch = useCallback(
    (direction: 1 | -1) => {
      if (findMatches.length === 0) return;
      const bounds = selectionBounds(selection);
      const currentIndex = findMatches.findIndex(
        (match) => match.row === bounds.top && match.column === bounds.left,
      );
      const nextIndex =
        currentIndex === -1
          ? 0
          : (currentIndex + direction + findMatches.length) % findMatches.length;
      const next = findMatches[nextIndex];
      setSelection(cellSelection(next.row, next.column));
    },
    [findMatches, selection],
  );

  /** 替换当前匹配 / 全部匹配 */
  const applyReplace = useCallback(
    (all: boolean) => {
      const sheet = doc?.workbook.worksheets[sheetIndex];
      if (!sheet || !layout || findMatches.length === 0) return;

      const bounds = selectionBounds(selection);
      const targets = all
        ? findMatches
        : findMatches.filter((match) => match.row === bounds.top && match.column === bounds.left);
      if (targets.length === 0) {
        showNotification("当前单元格不是匹配项", "info");
        return;
      }

      const changes: CellChange[] = [];
      for (const target of targets) {
        const cell = sheet.getCell(target.row, target.column);
        const before = cell.value;
        const nextValue =
          typeof before === "string"
            ? before.split(findText).join(replaceText)
            : replaceText;
        if (isSameCellValue(before, nextValue)) continue;
        cell.value = nextValue;
        changes.push({ row: target.row, column: target.column, before, after: nextValue });
      }

      if (changes.length === 0) return;
      applyChanges(changes);
      showNotification(`已替换 ${changes.length} 处`, "success");
    },
    [applyChanges, doc, findMatches, findText, layout, replaceText, selection, sheetIndex, showNotification],
  );

  /** 格式菜单：颜色 / 对齐 / 数字格式 */
  const formatMenuItems = useMemo(() => {
    const separator = { label: "", separator: true, onClick: () => {} };
    const openPalette = (target: "fill" | "font") => {
      setPalette({ x: formatMenu?.x ?? 0, y: formatMenu?.y ?? 0, target });
    };

    return [
      { label: "填充颜色…", onClick: () => openPalette("fill") },
      { label: "字体颜色…", onClick: () => openPalette("font") },
      separator,
      { label: "左对齐", onClick: () => applyAlignment("left", "左对齐") },
      { label: "居中", onClick: () => applyAlignment("center", "居中") },
      { label: "右对齐", onClick: () => applyAlignment("right", "右对齐") },
      separator,
      { label: "常规", onClick: () => applyNumberFormat("General", "常规格式") },
      { label: "数字 0.00", onClick: () => applyNumberFormat("0.00", "数字格式") },
      { label: "千分位 #,##0.00", onClick: () => applyNumberFormat("#,##0.00", "千分位格式") },
      { label: "百分比 0.00%", onClick: () => applyNumberFormat("0.00%", "百分比格式") },
      { label: "货币 ¥#,##0.00", onClick: () => applyNumberFormat("¥#,##0.00", "货币格式") },
      { label: "日期 yyyy-mm-dd", onClick: () => applyNumberFormat("yyyy-mm-dd", "日期格式") },
    ];
  }, [applyAlignment, applyNumberFormat, formatMenu]);

  /** 行列菜单：插入/删除行列与列宽自适应（按当前选区大小） */
  const rowColumnMenuItems = useMemo(() => {
    const bounds = selectionBounds(selection);
    const rows = bounds.bottom - bounds.top + 1;
    const columns = bounds.right - bounds.left + 1;
    const separator = { label: "", separator: true, onClick: () => {} };

    return [
      { label: `在上方插入 ${rows} 行`, onClick: () => void insertRows(bounds.top, rows) },
      { label: `在下方插入 ${rows} 行`, onClick: () => void insertRows(bounds.bottom + 1, rows) },
      { label: `删除所选 ${rows} 行`, danger: true, onClick: () => void deleteRows(bounds.top, rows) },
      separator,
      { label: `在左侧插入 ${columns} 列`, onClick: () => void insertColumns(bounds.left, columns) },
      { label: `在右侧插入 ${columns} 列`, onClick: () => void insertColumns(bounds.right + 1, columns) },
      { label: `删除所选 ${columns} 列`, danger: true, onClick: () => void deleteColumns(bounds.left, columns) },
      separator,
      { label: "自适应列宽", onClick: () => autoFitColumn(bounds.left) },
      separator,
      { label: `按 ${columnLetter(bounds.left)} 列升序`, onClick: () => sortSelection(true) },
      { label: `按 ${columnLetter(bounds.left)} 列降序`, onClick: () => sortSelection(false) },
      {
        label: doc?.workbook.worksheets[sheetIndex]?.autoFilter ? "关闭自动筛选" : "启用自动筛选",
        onClick: toggleAutoFilter,
      },
      separator,
      { label: "查找替换…", onClick: () => setFindPanel(true) },
    ];
  }, [
    autoFitColumn,
    deleteColumns,
    deleteRows,
    doc,
    insertColumns,
    insertRows,
    selection,
    sheetIndex,
    sortSelection,
    toggleAutoFilter,
  ]);

  const moveSelection = useCallback(
    (rowDelta: number, columnDelta: number) => {
      setSelection((previous) => {
        const row = Math.min(Math.max(1, previous.row + rowDelta), layout?.rowCount ?? 1);
        const column = Math.min(Math.max(1, previous.column + columnDelta), layout?.columnCount ?? 1);
        const target = layout ? resolveMergeOwner(layout.snapshot.merges, row, column) : { row, column };
        return cellSelection(target.row, target.column);
      });
    },
    [layout],
  );

  /** Shift+方向键：活动单元格移动、锚点留在原地，形成/收缩选区 */
  const extendSelection = useCallback(
    (rowDelta: number, columnDelta: number) => {
      setSelection((previous) => ({
        ...previous,
        row: Math.min(Math.max(1, previous.row + rowDelta), layout?.rowCount ?? 1),
        column: Math.min(Math.max(1, previous.column + columnDelta), layout?.columnCount ?? 1),
      }));
    },
    [layout],
  );

  /** 点选单元格：合并区内的从属格统一落到 master 上 */
  const selectCell = useCallback(
    (row: number, column: number) => {
      const target = layout ? resolveMergeOwner(layout.snapshot.merges, row, column) : { row, column };
      setSelection(cellSelection(target.row, target.column));
    },
    [layout],
  );

  /** 拖拽选择：锚点保持不动，终点跟随鼠标所在格 */
  const extendSelectionTo = useCallback((row: number, column: number) => {
    setSelection((previous) => ({ ...previous, endRow: row, endColumn: column }));
  }, []);

  const switchSheet = useCallback((index: number) => {
    setSheetIndex(index);
    setSelection(cellSelection(1, 1));
    setEditing(null);
    const node = gridRef.current;
    if (node) {
      node.scrollTop = 0;
      node.scrollLeft = 0;
    }
    setScroll({ left: 0, top: 0 });
  }, []);

  const selectAllData = useCallback(() => {
    if (!layout) return;
    setSelection({
      row: 1,
      column: 1,
      endRow: layout.snapshot.rowCount,
      endColumn: layout.snapshot.columnCount,
    });
  }, [layout]);

  /** 地址框跳转（B12 / B2:D5） */
  const gotoAddress = useCallback(
    (raw: string) => {
      setAddressInput(null);
      if (!layout) return;

      const parsed = parseA1Range(raw);
      if (!parsed) {
        showNotification("地址格式应为 B12 或 B2:D5", "info");
        return;
      }

      const row = Math.min(Math.max(1, parsed.startRow), layout.rowCount);
      const column = Math.min(Math.max(1, parsed.startColumn), layout.columnCount);
      const endRow = Math.min(Math.max(1, parsed.endRow ?? parsed.startRow), layout.rowCount);
      const endColumn = Math.min(Math.max(1, parsed.endColumn ?? parsed.startColumn), layout.columnCount);

      setSelection({ row, column, endRow, endColumn });
      rootRef.current?.focus();
    },
    [layout, showNotification],
  );

  /** Ctrl+方向键：沿方向走到「有值/空」交界处（Excel 语义） */
  const jumpToEdge = useCallback(
    (rowStep: number, columnStep: number) => {
      if (!layout) return;
      const bounds = selectionBounds(selection);
      const hasValue = (row: number, column: number) =>
        layout.snapshot.cells.get(row)?.has(column) ?? false;

      let row = rowStep > 0 ? bounds.bottom : bounds.top;
      let column = columnStep > 0 ? bounds.right : bounds.left;
      const startedOnValue = hasValue(row, column);

      for (;;) {
        const nextRow = row + rowStep;
        const nextColumn = column + columnStep;
        if (
          nextRow < 1 ||
          nextRow > layout.rowCount ||
          nextColumn < 1 ||
          nextColumn > layout.columnCount
        ) {
          break;
        }
        row = nextRow;
        column = nextColumn;
        if (hasValue(row, column) !== startedOnValue) break;
      }

      setSelection(cellSelection(row, column));
    },
    [layout, selection],
  );

  const startEdit = useCallback(
    (row: number, column: number, initialValue?: string) => {
      if (isReadOnly || !layout) return;

      const { row: targetRow, column: targetColumn } = resolveMergeOwner(
        layout.snapshot.merges,
        row,
        column,
      );

      let value = initialValue;
      if (value === undefined) {
        // 只有原本有值的格子才读工作簿，避免顺手创建空行
        const hasValue = layout.snapshot.cells.get(targetRow)?.has(targetColumn) ?? false;
        value = hasValue ? cellEditText(layout.sheet.getCell(targetRow, targetColumn).value) : "";
      }

      setSelection(cellSelection(targetRow, targetColumn));
      setEditing({ row: targetRow, column: targetColumn, value });
    },
    [isReadOnly, layout],
  );

  const commitEdit = useCallback(
    (raw: string, rowDelta: number, columnDelta: number) => {
      const target = editing;
      setEditing(null);
      if (!target || !layout) return;

      const cell = layout.sheet.getCell(target.row, target.column);
      const before = cell.value;
      const after = parseCellInput(raw);
      if (!isSameCellValue(before, after)) {
        cell.value = after;
        applyChanges([{ row: target.row, column: target.column, before, after }]);
      }

      if (rowDelta !== 0 || columnDelta !== 0) {
        moveSelection(rowDelta, columnDelta);
      }
      rootRef.current?.focus();
    },
    [applyChanges, editing, layout, moveSelection],
  );

  /** 清空选区内容（整片作为一步撤销） */
  const clearSelection = useCallback(() => {
    if (isReadOnly || !layout) return;

    const bounds = selectionBounds(selection);
    const changes: CellChange[] = [];

    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      const rowCells = layout.snapshot.cells.get(row);
      if (!rowCells) continue;
      for (let column = bounds.left; column <= bounds.right; column += 1) {
        // 只碰本来就有的格子，避免为清空而在工作簿里建出空行
        if (!rowCells.has(column)) continue;
        const cell = layout.sheet.getCell(row, column);
        const before = cell.value;
        cell.value = null;
        changes.push({ row, column, before, after: null });
      }
    }

    if (changes.length === 0) return;
    applyChanges(changes);
  }, [applyChanges, isReadOnly, layout, selection]);

  /** 复制选区为 TSV（制表符分列、换行分行，可直接粘进 Excel） */
  const copySelection = useCallback(() => {
    if (!layout) return;

    const bounds = selectionBounds(selection);
    const lines: string[] = [];
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      const rowCells = layout.snapshot.cells.get(row);
      const cells: string[] = [];
      for (let column = bounds.left; column <= bounds.right; column += 1) {
        cells.push(rowCells?.get(column)?.text ?? "");
      }
      lines.push(cells.join("\t"));
    }
    void copyTextToClipboard(lines.join("\n"));
  }, [layout, selection]);

  const cutSelection = useCallback(() => {
    if (isReadOnly) return;
    copySelection();
    clearSelection();
  }, [clearSelection, copySelection, isReadOnly]);

  /** 填充柄落定：数值序列按步长递增，其余按源区复制 */
  const commitFill = useCallback(
    (source: { top: number; bottom: number; left: number; right: number }, target: { top: number; bottom: number; left: number; right: number }) => {
      const sheet = doc?.workbook.worksheets[sheetIndex];
      if (!sheet || !layout) return;

      const changes: CellChange[] = [];
      const writeCell = (row: number, column: number, value: CellValue) => {
        const cell = sheet.getCell(row, column);
        const before = cell.value;
        if (isSameCellValue(before, value)) return;
        cell.value = value;
        changes.push({ row, column, before, after: value });
      };

      if (target.bottom > source.bottom) {
        for (let column = source.left; column <= source.right; column += 1) {
          const series: string[] = [];
          for (let row = source.top; row <= source.bottom; row += 1) {
            series.push(layout.snapshot.cells.get(row)?.get(column)?.text ?? "");
          }
          if (series.length === 0) continue;

          const numbers = series.map((text) => parseNumericText(text));
          const allNumeric = numbers.every((value) => value !== null);
          const step = numbers.length > 1
            ? (numbers[numbers.length - 1]! - numbers[0]!) / (numbers.length - 1)
            : 1;
          const base = numbers[numbers.length - 1] ?? 0;

          for (let row = source.bottom + 1, offset = 0; row <= target.bottom; row += 1, offset += 1) {
            if (allNumeric) {
              writeCell(row, column, base + step * (offset + 1));
            } else {
              writeCell(row, column, parseCellInput(series[offset % series.length]));
            }
          }
        }
      }

      if (target.right > source.right) {
        for (let row = source.top; row <= source.bottom; row += 1) {
          const series: string[] = [];
          for (let column = source.left; column <= source.right; column += 1) {
            series.push(layout.snapshot.cells.get(row)?.get(column)?.text ?? "");
          }
          if (series.length === 0) continue;

          const numbers = series.map((text) => parseNumericText(text));
          const allNumeric = numbers.every((value) => value !== null);
          const step = numbers.length > 1
            ? (numbers[numbers.length - 1]! - numbers[0]!) / (numbers.length - 1)
            : 1;
          const base = numbers[numbers.length - 1] ?? 0;

          for (
            let column = source.right + 1, offset = 0;
            column <= target.right;
            column += 1, offset += 1
          ) {
            if (allNumeric) {
              writeCell(row, column, base + step * (offset + 1));
            } else {
              writeCell(row, column, parseCellInput(series[offset % series.length]));
            }
          }
        }
      }

      if (changes.length === 0) return;
      applyChanges(changes);
    },
    [applyChanges, doc, layout, sheetIndex],
  );

  // 松开鼠标即结束拖拽选择
  useEffect(() => {
    const stopDragSelect = () => {
      dragSelectRef.current = false;

      const source = fillDragRef.current;
      const target = fillPreviewRef.current;
      if (source && target) {
        commitFill(source, target);
      }
      fillDragRef.current = null;
      fillPreviewRef.current = null;
      setFillPreview(null);
    };
    window.addEventListener("mouseup", stopDragSelect);
    return () => window.removeEventListener("mouseup", stopDragSelect);
  }, [commitFill]);

  const handleEditKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitEdit(event.currentTarget.value, 1, 0);
      } else if (event.key === "Tab") {
        event.preventDefault();
        commitEdit(event.currentTarget.value, 0, event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setEditing(null);
        rootRef.current?.focus();
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        commitEdit(event.currentTarget.value, event.key === "ArrowUp" ? -1 : 1, 0);
      }
    },
    [commitEdit],
  );

  const handleGridKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // 编辑态由输入框自己处理；仅接管「边编辑边保存」这一种组合
      if (editing) {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          commitEdit(editing.value, 0, 0);
          void saveActiveTab(activeTab.id);
        }
        return;
      }
      if (!doc || !layout) return;

      const modifier = event.ctrlKey || event.metaKey;
      if (modifier) {
        const key = event.key.toLowerCase();
        if (key === "s") {
          event.preventDefault();
          void saveActiveTab(activeTab.id);
        } else if (key === "z" && !event.shiftKey) {
          event.preventDefault();
          applyHistory(-1);
        } else if (key === "y" || (key === "z" && event.shiftKey)) {
          event.preventDefault();
          applyHistory(1);
        } else if (key === "c") {
          event.preventDefault();
          copySelection();
        } else if (key === "x") {
          event.preventDefault();
          cutSelection();
        } else if (key === "a") {
          event.preventDefault();
          selectAllData();
        } else if (key === "b") {
          event.preventDefault();
          toggleFontStyle("bold", "加粗");
        } else if (key === "i") {
          event.preventDefault();
          toggleFontStyle("italic", "倾斜");
        } else if (key === "u") {
          event.preventDefault();
          toggleFontStyle("underline", "下划线");
        } else if (event.shiftKey && /^Digit[1-6]$/.test(event.code)) {
          event.preventDefault();
          const shortcut = NUMBER_FORMAT_SHORTCUTS[Number(event.code.slice(-1))];
          if (shortcut) {
            applyNumberFormat(shortcut.format, shortcut.label);
          }
        } else if (key === "f") {
          event.preventDefault();
          setFindPanel(true);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          jumpToEdge(-1, 0);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          jumpToEdge(1, 0);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          jumpToEdge(0, -1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          jumpToEdge(0, 1);
        } else if (event.key === "Home") {
          event.preventDefault();
          setSelection(cellSelection(1, 1));
        } else if (event.key === "End") {
          event.preventDefault();
          setSelection({
            row: layout?.snapshot.rowCount ?? 1,
            column: layout?.snapshot.columnCount ?? 1,
            endRow: layout?.snapshot.rowCount ?? 1,
            endColumn: layout?.snapshot.columnCount ?? 1,
          });
        } else if (key === "pageup") {
          event.preventDefault();
          switchSheet(Math.max(0, sheetIndex - 1));
        } else if (key === "pagedown") {
          event.preventDefault();
          switchSheet(Math.min(doc.workbook.worksheets.length - 1, sheetIndex + 1));
        }
        return;
      }

      switch (event.key) {
        case "ArrowUp":
          event.preventDefault();
          if (event.shiftKey) extendSelection(-1, 0);
          else moveSelection(-1, 0);
          return;
        case "ArrowDown":
          event.preventDefault();
          if (event.shiftKey) extendSelection(1, 0);
          else moveSelection(1, 0);
          return;
        case "ArrowLeft":
          event.preventDefault();
          if (event.shiftKey) extendSelection(0, -1);
          else moveSelection(0, -1);
          return;
        case "ArrowRight":
          event.preventDefault();
          if (event.shiftKey) extendSelection(0, 1);
          else moveSelection(0, 1);
          return;
        case "Enter":
          event.preventDefault();
          moveSelection(1, 0);
          return;
        case "Tab":
          event.preventDefault();
          moveSelection(0, event.shiftKey ? -1 : 1);
          return;
        case "Delete":
        case "Backspace":
          event.preventDefault();
          clearSelection();
          return;
        case "F2":
          event.preventDefault();
          startEdit(selection.row, selection.column);
          return;
        default:
          break;
      }

      // 直接键入即进入编辑，并以该字符作为起始内容（Excel 习惯）
      if (!isReadOnly && event.key.length === 1 && !event.altKey) {
        event.preventDefault();
        startEdit(selection.row, selection.column, event.key);
      }
    },
    [
      activeTab.id,
      applyHistory,
      applyNumberFormat,
      clearSelection,
      copySelection,
      cutSelection,
      doc,
      editing,
      extendSelection,
      isReadOnly,
      jumpToEdge,
      layout,
      moveSelection,
      saveActiveTab,
      selectAllData,
      selection,
      sheetIndex,
      startEdit,
      switchSheet,
      toggleFontStyle,
    ],
  );

  /** 把一段图片字节插到当前选中格：等比缩放到单元格内并锚定（选文件与粘贴共用） */
  const insertImageAtSelection = useCallback(
    async (bytes: Uint8Array, extension: "png" | "jpeg" | "gif", verb: "插入" | "粘贴") => {
      if (!doc || !layout) return;

      const size = await measureImageBytes(bytes);
      const cellWidth = layout.widths[selection.column - 1] ?? DEFAULT_COLUMN_WIDTH;
      const cellHeight = layout.heights[selection.row - 1] ?? DEFAULT_ROW_HEIGHT;
      const scale = size.width && size.height
        ? Math.min(cellWidth / size.width, cellHeight / size.height, 1)
        : 1;

      // exceljs 声明的 Buffer 只是 ArrayBuffer 的类型别名，这里传 Uint8Array，jszip 同样接受
      const imageId = doc.workbook.addImage({
        buffer: bytes as unknown as ArrayBuffer,
        extension,
      });
      layout.sheet.addImage(imageId, {
        tl: { col: selection.column - 1, row: selection.row - 1 },
        ext: {
          width: Math.max(1, Math.round((size.width || cellWidth) * scale)),
          height: Math.max(1, Math.round((size.height || cellHeight) * scale)),
        },
      });

      setImagesVersion((version) => version + 1);
      markTabDirty(activeTab.id);
      showNotification(
        `已${verb}图片到 ${columnLetter(selection.column)}${selection.row}`,
        "success",
      );
    },
    [activeTab.id, doc, layout, markTabDirty, selection, showNotification],
  );

  /** 把 TSV 文本从活动单元格展开写入（粘贴事件与右键“粘贴”共用） */
  const applyPastedText = useCallback(
    (text: string) => {
      if (!doc || !layout) return;

      const matrix = text
        .replace(/\r\n|\r/g, "\n")
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => line.split("\t"));

      const changes: CellChange[] = [];
      matrix.forEach((cells, rowOffset) => {
        cells.forEach((raw, columnOffset) => {
          const row = selection.row + rowOffset;
          const column = selection.column + columnOffset;
          if (row > layout.rowCount || column > layout.columnCount) return;

          const cell = layout.sheet.getCell(row, column);
          const before = cell.value;
          const after = parseCellInput(raw);
          if (isSameCellValue(before, after)) return;
          cell.value = after;
          changes.push({ row, column, before, after });
        });
      });

      if (changes.length === 0) return;
      applyChanges(changes);
      showNotification(`已粘贴 ${matrix.length} 行 × ${matrix[0].length} 列`, "success");
    },
    [applyChanges, doc, layout, selection, showNotification],
  );

  /** 右键菜单里的粘贴：从系统剪贴板取文本再按 TSV 展开 */
  const pasteFromClipboard = useCallback(async () => {
    if (isReadOnly) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        showNotification("剪贴板里没有文本内容", "info");
        return;
      }
      applyPastedText(text);
    } catch (err) {
      showNotification(`读取剪贴板失败：${String(err)}`, "error");
    }
  }, [applyPastedText, isReadOnly, showNotification]);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (isReadOnly || !doc || !layout) return;

      // 剪贴板里带图片时优先按图片插入（截图 / 复制的图片文件都能直接粘）
      const imageFile = Array.from(event.clipboardData.files).find(
        (file) => file.type.startsWith("image/") || imageExtensionForWrite(file.name) !== null,
      );
      if (imageFile) {
        event.preventDefault();
        const extension =
          imageExtensionFromMime(imageFile.type) ?? imageExtensionForWrite(imageFile.name);
        if (!extension) {
          showNotification("只支持 PNG / JPG / GIF 图片", "info");
          return;
        }

        // 正在编辑单元格时先落定这次输入，再插图片
        if (editing) {
          commitEdit(editing.value, 0, 0);
        }

        void imageFile
          .arrayBuffer()
          .then((buffer) => insertImageAtSelection(new Uint8Array(buffer), extension, "粘贴"))
          .catch((err) => showNotification(`粘贴图片失败: ${String(err)}`, "error"));
        return;
      }

      // 纯文本：编辑态交给输入框自己处理
      if (editing) return;
      const text = event.clipboardData.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      applyPastedText(text);
    },
    [
      applyPastedText,
      commitEdit,
      doc,
      editing,
      insertImageAtSelection,
      isReadOnly,
      layout,
      showNotification,
    ],
  );

  /** 图片在网格里的绘制矩形：有 br 锚点按覆盖范围，否则按像素尺寸（两者都裁剪到可见区） */
  const imageRect = useCallback(
    (image: SheetImage) => {
      if (!layout) return null;

      const left = layout.offsets[image.startColumn - 1] ?? 0;
      const top = layout.rowOffsets[image.startRow - 1] ?? 0;

      let width = image.width;
      let height = image.height;
      if (image.endColumn !== null && image.endRow !== null) {
        width = 0;
        for (let column = image.startColumn; column <= image.endColumn; column += 1) {
          width += layout.widths[column - 1] ?? DEFAULT_COLUMN_WIDTH;
        }
        height = 0;
        for (let row = image.startRow; row <= image.endRow; row += 1) {
          height += layout.heights[row - 1] ?? DEFAULT_ROW_HEIGHT;
        }
      }
      if (!width) width = layout.widths[image.startColumn - 1] ?? DEFAULT_COLUMN_WIDTH;
      if (!height) height = layout.heights[image.startRow - 1] ?? DEFAULT_ROW_HEIGHT;

      return {
        left,
        top,
        width: Math.min(width, layout.totalWidth - left),
        height: Math.min(height, layout.totalHeight - top),
      };
    },
    [layout],
  );

  const imagesInSelection = useMemo(
    () => images.filter((image) => isCellInImage(image, selection.row, selection.column)),
    [images, selection],
  );

  /** 选区数值统计（状态栏显示求和/计数/平均） */
  const selectionStats = useMemo(() => {
    if (!layout || isSingleCell(selection)) return null;

    const bounds = selectionBounds(selection);
    let count = 0;
    let sum = 0;

    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      const rowCells = layout.snapshot.cells.get(row);
      if (!rowCells) continue;
      for (let column = bounds.left; column <= bounds.right; column += 1) {
        const cell = rowCells.get(column);
        if (!cell?.numeric) continue;
        const value = parseNumericText(cell.text);
        if (value === null) continue;
        count += 1;
        sum += value;
      }
    }

    return count > 0 ? { count, sum, average: sum / count } : null;
  }, [layout, selection]);

  const handleInsertImage = useCallback(async () => {
    if (isReadOnly || !doc || !layout || insertingImage) return;

    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif"] }],
      });
      if (typeof picked !== "string") return;

      const extension = imageExtensionForWrite(picked);
      if (!extension) {
        showNotification("只支持 PNG / JPG / GIF 图片", "info");
        return;
      }

      setInsertingImage(true);
      await insertImageAtSelection(await readFile(picked), extension, "插入");
    } catch (err) {
      showNotification(`插入图片失败: ${String(err)}`, "error");
    } finally {
      setInsertingImage(false);
    }
  }, [doc, insertImageAtSelection, insertingImage, isReadOnly, layout, showNotification]);

  const handleDeleteImages = useCallback(() => {
    if (isReadOnly || !layout || imagesInSelection.length === 0) return;

    const media = readSheetMedia(layout.sheet);
    if (media.length === 0) return;

    // 从后往前删，避免前面的下标位移
    [...imagesInSelection]
      .sort((a, b) => b.mediaIndex - a.mediaIndex)
      .forEach((image) => media.splice(image.mediaIndex, 1));

    setImagesVersion((version) => version + 1);
    markTabDirty(activeTab.id);
    showNotification(`已删除 ${imagesInSelection.length} 张图片`, "success");
  }, [activeTab.id, imagesInSelection, isReadOnly, layout, markTabDirty, showNotification]);

  const handlePreviewImage = useCallback(
    (image: SheetImage) => {
      openImagePreview({
        path: `${activeTab.path}#image${image.imageId}`,
        name: image.name,
        url: image.url,
      });
    },
    [activeTab.path, openImagePreview],
  );

  /** 开始拖动列宽/行高：过程只改本地覆盖值，松手才写回工作簿 */
  const beginResize = useCallback(
    (axis: "column" | "row", index: number, event: React.MouseEvent) => {
      if (!layout) return;
      event.preventDefault();
      event.stopPropagation();

      const startSize = axis === "column"
        ? layout.widths[index - 1] ?? DEFAULT_COLUMN_WIDTH
        : layout.heights[index - 1] ?? DEFAULT_ROW_HEIGHT;

      resizeRef.current = {
        axis,
        index,
        startPos: axis === "column" ? event.clientX : event.clientY,
        startSize,
        size: startSize,
      };
      setResizing({ axis, index });
      setResizeSize(startSize);
    },
    [layout],
  );

  useEffect(() => {
    if (!resizing) return;

    const handleMove = (event: MouseEvent) => {
      const state = resizeRef.current;
      if (!state) return;

      const delta = (state.axis === "column" ? event.clientX : event.clientY) - state.startPos;
      const minimum = state.axis === "column" ? MIN_COLUMN_WIDTH : MIN_ROW_HEIGHT;
      const size = Math.max(minimum, Math.round(state.startSize + delta));
      state.size = size;

      setResizeSize(size);
      if (state.axis === "column") {
        setColumnOverrides((previous) => ({ ...previous, [state.index]: size }));
      } else {
        setRowOverrides((previous) => ({ ...previous, [state.index]: size }));
      }
    };

    const handleUp = () => {
      const state = resizeRef.current;
      resizeRef.current = null;
      setResizing(null);

      const sheet = doc?.workbook.worksheets[sheetIndex];
      if (!state || !sheet) return;
      // 只是点了一下手柄、尺寸没变就不写回，避免无谓置脏
      if (state.size === state.startSize) return;

      if (state.axis === "column") {
        sheet.getColumn(state.index).width = pixelsToColumnWidth(state.size);
      } else {
        sheet.getRow(state.index).height = pixelsToPoints(state.size);
        // 同步基线，避免下一次布局又回退到文件里的旧值
        storedRowHeightsRef.current[state.index] = state.size;
      }
      markTabDirty(activeTab.id);
    };

    // 拖动期间锁住光标与选区，拖到网格外也保持手感
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = resizing.axis === "column" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    // 鼠标在窗口外松开时 mouseup 收不到，用 blur 兜底避免卡在拖拽态
    window.addEventListener("blur", handleUp);
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      window.removeEventListener("blur", handleUp);
    };
  }, [activeTab.id, doc, markTabDirty, resizing, sheetIndex]);

  const handleSave = useCallback(() => {
    setSaving(true);
    void saveActiveTab(activeTab.id)
      .catch((err) => {
        showNotification(`保存失败: ${String(err)}`, "error");
      })
      .finally(() => setSaving(false));
  }, [activeTab.id, saveActiveTab, showNotification]);

  /** 底部新增工作表：命名沿用 Excel 习惯（Sheet1、Sheet2…），并切到新表 */
  const handleAddSheet = useCallback(() => {
    if (isReadOnly || !doc) return;

    const workbook = doc.workbook;
    const usedNames = new Set(workbook.worksheets.map((worksheet) => worksheet.name));
    let suffix = workbook.worksheets.length + 1;
    while (usedNames.has(`Sheet${suffix}`)) {
      suffix += 1;
    }

    const sheet = workbook.addWorksheet(`Sheet${suffix}`);
    // 新表由按工作表切换的逻辑接管：快照懒建、行高基线重读、尺寸覆盖清空
    switchSheet(workbook.worksheets.indexOf(sheet));
    markTabDirty(activeTab.id);
    showNotification(`已新增工作表 ${sheet.name}`, "success");
  }, [activeTab.id, doc, isReadOnly, markTabDirty, showNotification, switchSheet]);

  /** 重命名工作表（重名/空名会被拒绝，编辑态保留让用户改） */
  const renameSheet = useCallback(
    (index: number, nextName: string) => {
      const workbook = doc?.workbook;
      const sheet = workbook?.worksheets[index];
      const name = nextName.trim();
      if (!sheet || !name || name === sheet.name) {
        setRenamingSheet(null);
        return;
      }
      if (
        workbook.worksheets.some(
          (item) => item !== sheet && item.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        showNotification(`工作表名 "${name}" 已存在`, "error");
        return;
      }

      sheet.name = name;
      setRenamingSheet(null);
      markTabDirty(activeTab.id);
    },
    [activeTab.id, doc, markTabDirty, showNotification],
  );

  /** 删除工作表（至少要留一个；此操作不可撤销，先确认） */
  const deleteSheet = useCallback(
    async (index: number) => {
      const workbook = doc?.workbook;
      const sheet = workbook?.worksheets[index];
      if (!workbook || !sheet) return;
      if (workbook.worksheets.length <= 1) {
        showNotification("工作簿至少要保留一个工作表", "info");
        return;
      }

      const confirmed = await confirmDialog({
        title: "删除工作表",
        message: `将删除工作表 "${sheet.name}" 及其全部内容，此操作无法撤销。是否继续？`,
        kind: "danger",
      });
      if (!confirmed) return;

      workbook.removeWorksheet(sheet.id);
      // orderNo 压紧（worksheets 按 orderNo 排序）
      workbook.worksheets.forEach((item, position) => setWorksheetOrder(item, position + 1));

      // 下标变了，缓存全部作废
      snapshotsRef.current = new Map();
      setSheetIndex(Math.min(index, workbook.worksheets.length - 1));
      setSelection(cellSelection(1, 1));
      setEditing(null);
      setLayoutVersion((version) => version + 1);
      setImagesVersion((version) => version + 1);
      markTabDirty(activeTab.id);
      showNotification(`已删除工作表 ${sheet.name}`, "success");
    },
    [activeTab.id, doc, markTabDirty, showNotification],
  );

  /** 拖拽重排工作表：只改 orderNo，写盘顺序随之变化 */
  const moveSheet = useCallback(
    (from: number, to: number) => {
      const workbook = doc?.workbook;
      if (!workbook || from === to) return;
      const sheets = workbook.worksheets;
      if (from < 0 || from >= sheets.length || to < 0 || to >= sheets.length) return;

      const ordered = [...sheets];
      const [moved] = ordered.splice(from, 1);
      ordered.splice(to, 0, moved);
      ordered.forEach((sheet, position) => setWorksheetOrder(sheet, position + 1));

      snapshotsRef.current = new Map();
      setSheetIndex(to);
      setSelection(cellSelection(1, 1));
      setEditing(null);
      setLayoutVersion((version) => version + 1);
      setImagesVersion((version) => version + 1);
      markTabDirty(activeTab.id);
    },
    [activeTab.id, doc, markTabDirty],
  );

  /** 单元格/选区的右键菜单 */
  const cellMenuItems = useMemo(() => {
    const bounds = selectionBounds(selection);
    const rows = bounds.bottom - bounds.top + 1;
    const columns = bounds.right - bounds.left + 1;
    const separator = { label: "", separator: true, onClick: () => {} };
    const merged = layout?.snapshot.merges.spans.has(`${bounds.top}:${bounds.left}`) ?? false;

    return [
      { label: "剪切", onClick: cutSelection },
      { label: "复制", onClick: copySelection },
      { label: "粘贴", onClick: () => void pasteFromClipboard() },
      { label: "清空内容", onClick: clearSelection },
      separator,
      { label: `在上方插入 ${rows} 行`, onClick: () => void insertRows(bounds.top, rows) },
      { label: `在左侧插入 ${columns} 列`, onClick: () => void insertColumns(bounds.left, columns) },
      { label: `删除所选 ${rows} 行`, danger: true, onClick: () => void deleteRows(bounds.top, rows) },
      { label: `删除所选 ${columns} 列`, danger: true, onClick: () => void deleteColumns(bounds.left, columns) },
      separator,
      { label: merged ? "取消合并" : "合并单元格", onClick: toggleMerge },
      { label: "插入图片…", onClick: () => void handleInsertImage() },
      ...(imagesInSelection.length > 0
        ? [
            {
              label: `删除图片（${imagesInSelection.length}）`,
              danger: true,
              onClick: handleDeleteImages,
            },
          ]
        : []),
      { label: "自适应列宽", onClick: () => autoFitColumn(bounds.left) },
    ];
  }, [
    autoFitColumn,
    clearSelection,
    copySelection,
    cutSelection,
    deleteColumns,
    deleteRows,
    handleDeleteImages,
    handleInsertImage,
    imagesInSelection,
    insertColumns,
    insertRows,
    layout,
    pasteFromClipboard,
    selection,
    toggleMerge,
  ]);

  /** 工作表标签的右键菜单 */
  const sheetMenuItems = useMemo(() => {
    if (!sheetMenu) return [];
    const target = doc?.workbook.worksheets[sheetMenu.index];
    return [
      {
        label: "重命名",
        onClick: () => setRenamingSheet({ index: sheetMenu.index, value: target?.name ?? "" }),
      },
      { label: "删除工作表", danger: true, onClick: () => void deleteSheet(sheetMenu.index) },
      { label: "", separator: true, onClick: () => {} },
      { label: "新增工作表", onClick: handleAddSheet },
    ];
  }, [deleteSheet, doc, handleAddSheet, sheetMenu]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-deepest p-6">
        <div className="max-w-md rounded-xl border border-error/30 bg-error/5 px-4 py-3 text-sm leading-relaxed text-error">
          {error}
        </div>
      </div>
    );
  }

  if (!doc || !layout) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-deepest text-text-muted">
        <Loader2 size={20} className="animate-spin" />
        <span className="text-xs">正在解析 Excel 工作簿...</span>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={handleGridKeyDown}
      onPaste={handlePaste}
      className="flex h-full min-h-0 flex-col bg-primary outline-none"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface/20 px-3 py-1.5">
        <FileSpreadsheet size={14} className="shrink-0 text-accent" />
        <span className="max-w-[180px] truncate text-xs font-medium text-text-primary">
          {layout.sheet.name}
        </span>
        <span className="shrink-0 text-[10px] text-text-muted">
          {layout.snapshot.rowCount} 行 × {layout.snapshot.columnCount} 列
        </span>
        {doc.fidelity.lossyLabels.length > 0 && (
          <span
            className="flex shrink-0 items-center gap-1 rounded bg-accent-warm/10 px-1.5 py-0.5 text-[10px] text-accent-warm"
            title={`该文件含编辑器无法保留的内容：${doc.fidelity.lossyLabels.join("、")}。保存后会丢失这些内容，建议先另存为副本再编辑。`}
          >
            <AlertTriangle size={11} />
            保存会丢失：{doc.fidelity.lossyLabels.slice(0, 2).join("、")}
            {doc.fidelity.lossyLabels.length > 2
              ? ` 等 ${doc.fidelity.lossyLabels.length} 类`
              : ""}
          </span>
        )}
        {doc.isBlank && (
          <span
            className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent"
            title="原文件是空文件，按空白工作簿打开；保存后会写入有效的 xlsx 内容"
          >
            空白工作簿
          </span>
        )}
        <span className="mx-1 h-4 w-px shrink-0 bg-border" />
        <input
          value={addressInput ?? selectionLabel(selection)}
          onChange={(event) => setAddressInput(event.target.value)}
          onFocus={() => setAddressInput(selectionLabel(selection))}
          onBlur={() => setAddressInput(null)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              gotoAddress(addressInput ?? "");
            } else if (event.key === "Escape") {
              event.preventDefault();
              setAddressInput(null);
              rootRef.current?.focus();
            }
          }}
          title="输入单元格地址回车跳转（B12 / B2:D5）"
          className="w-20 shrink-0 rounded border border-border bg-deepest px-1.5 py-0.5 font-mono text-[11px] text-text-secondary outline-none focus:border-accent"
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
          {layout.snapshot.cells.get(selection.row)?.get(selection.column)?.text ?? ""}
        </span>
        {isReadOnly && (
          <span className="shrink-0 text-[10px] text-text-muted">只读</span>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <span
            className="cursor-help text-text-muted/85"
            title="保存会用编辑器重写工作簿：单元格值、公式、合并、列宽与沿用的样式会保留；图表、条件格式、数据透视表等内容暂不支持，请谨慎覆盖重要文件。"
          >
            <Info size={12} />
          </span>
          <div className="flex shrink-0 items-center gap-0.5 rounded border border-border bg-deepest px-1 py-0.5">
            <button
              type="button"
              disabled={isReadOnly}
              onClick={() => toggleFontStyle("bold", "加粗")}
              title="加粗 (Ctrl+B)"
              className={`h-5 w-5 rounded text-[11px] font-bold transition-colors disabled:opacity-40 ${
                activeFont.bold ? "bg-accent/15 text-accent" : "text-text-muted hover:text-accent"
              }`}
            >
              B
            </button>
            <button
              type="button"
              disabled={isReadOnly}
              onClick={() => toggleFontStyle("italic", "倾斜")}
              title="倾斜 (Ctrl+I)"
              className={`h-5 w-5 rounded text-[11px] italic transition-colors disabled:opacity-40 ${
                activeFont.italic ? "bg-accent/15 text-accent" : "text-text-muted hover:text-accent"
              }`}
            >
              I
            </button>
            <button
              type="button"
              disabled={isReadOnly}
              onClick={() => toggleFontStyle("underline", "下划线")}
              title="下划线 (Ctrl+U)"
              className={`h-5 w-5 rounded text-[11px] underline transition-colors disabled:opacity-40 ${
                activeFont.underline ? "bg-accent/15 text-accent" : "text-text-muted hover:text-accent"
              }`}
            >
              U
            </button>
          </div>
          <button
            type="button"
            disabled={isReadOnly}
            onClick={toggleMerge}
            title="合并 / 取消合并所选单元格"
            className="flex items-center gap-1 rounded border border-border bg-deepest px-2 py-1 text-[11px] text-text-muted transition-colors hover:text-accent disabled:opacity-40 disabled:hover:text-text-muted"
          >
            <Merge size={13} />
            合并
          </button>
          <button
            type="button"
            disabled={isReadOnly}
            title="填充色 / 字体色 / 对齐 / 数字格式"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setFormatMenu({ x: rect.left, y: rect.bottom + 2 });
            }}
            className="flex items-center gap-1 rounded border border-border bg-deepest px-2 py-1 text-[11px] text-text-muted transition-colors hover:text-accent disabled:opacity-40 disabled:hover:text-text-muted"
          >
            <PaintBucket size={13} />
            格式
          </button>
          <button
            type="button"
            disabled={isReadOnly}
            title="插入/删除行列、排序、筛选、查找替换"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setRowColumnMenu({ x: rect.left, y: rect.bottom + 2 });
            }}
            className="flex items-center gap-0.5 rounded border border-border bg-deepest px-2 py-1 text-[11px] text-text-muted transition-colors hover:text-accent disabled:opacity-40 disabled:hover:text-text-muted"
          >
            <Rows3 size={13} />
            <Columns3 size={13} />
            表格
          </button>
          <button
            type="button"
            onClick={() => void handleInsertImage()}
            disabled={isReadOnly || insertingImage}
            title="插入图片到当前单元格"
            className="flex items-center gap-1 rounded border border-border bg-deepest px-2 py-1 text-[11px] text-text-muted transition-colors hover:text-accent disabled:opacity-40 disabled:hover:text-text-muted"
          >
            {insertingImage ? <Loader2 size={13} className="animate-spin" /> : <ImagePlus size={13} />}
            插入图片
          </button>
          {imagesInSelection.length > 0 && (
            <button
              type="button"
              onClick={handleDeleteImages}
              disabled={isReadOnly}
              title="删除当前单元格内的图片"
              className="flex items-center gap-1 rounded border border-error/30 bg-error/5 px-2 py-1 text-[11px] text-error transition-colors hover:bg-error/10 disabled:opacity-40"
            >
              <Trash2 size={13} />
              删除图片
            </button>
          )}
          <button
            type="button"
            onClick={() => applyHistory(-1)}
            disabled={!historyState.canUndo}
            title="撤销 (Ctrl+Z)"
            className="rounded border border-border bg-deepest p-1 text-text-muted transition-colors hover:text-accent disabled:opacity-40 disabled:hover:text-text-muted"
          >
            <Undo2 size={13} />
          </button>
          <button
            type="button"
            onClick={() => applyHistory(1)}
            disabled={!historyState.canRedo}
            title="重做 (Ctrl+Shift+Z)"
            className="rounded border border-border bg-deepest p-1 text-text-muted transition-colors hover:text-accent disabled:opacity-40 disabled:hover:text-text-muted"
          >
            <Redo2 size={13} />
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !activeTab.isDirty}
            title="保存 (Ctrl+S)"
            className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition-colors ${
              activeTab.isDirty
                ? "border-accent/40 bg-accent/10 text-accent hover:bg-accent/20"
                : "border-border bg-deepest text-text-muted"
            } disabled:opacity-50`}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            保存
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          style={{ width: ROW_HEADER_WIDTH }}
          className="flex shrink-0 flex-col border-r border-border bg-surface/40"
        >
          <div style={{ height: COLUMN_HEADER_HEIGHT }} className="shrink-0 border-b border-border" />
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <div
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${-scroll.top}px)`, height: layout.totalHeight }}
            >
              {visibleRows.map((row) => (
                <div
                  key={row}
                  style={{ top: layout.rowOffsets[row - 1], height: layout.heights[row - 1] }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setSelection({
                      row,
                      column: 1,
                      endRow: row,
                      endColumn: layout.columnCount,
                    });
                    setCellMenu({ x: event.clientX, y: event.clientY });
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    rootRef.current?.focus();
                    setEditing(null);
                    // 点行头选中整行；Shift 点选则扩到该行
                    if (event.shiftKey) {
                      setSelection((previous) => ({
                        ...previous,
                        endRow: row,
                        endColumn: layout.columnCount,
                      }));
                    } else {
                      setSelection({
                        row,
                        column: 1,
                        endRow: row,
                        endColumn: layout.columnCount,
                      });
                    }
                  }}
                  className={`group absolute inset-x-0 flex cursor-default items-center justify-center border-b border-border/60 text-[10px] ${
                    selectionBounds(selection).top <= row && selectionBounds(selection).bottom >= row
                      ? "bg-accent/10 font-medium text-accent"
                      : "text-text-muted"
                  }`}
                >
                  {row}
                  <div
                    onMouseDown={(event) => beginResize("row", row, event)}
                    title="拖动调整行高"
                    style={{ height: RESIZE_HANDLE_SIZE }}
                    className="absolute inset-x-0 bottom-0 cursor-row-resize hover:bg-accent/50"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="relative flex min-w-0 flex-1 flex-col">
          {resizing && (
            <div className="pointer-events-none absolute left-3 top-1.5 z-30 rounded border border-border bg-surface/95 px-2 py-0.5 font-mono text-[11px] text-text-primary shadow-sm">
              {resizing.axis === "column" ? `列宽 ${resizeSize}px` : `行高 ${resizeSize}px`}
            </div>
          )}
          <div
            style={{ height: COLUMN_HEADER_HEIGHT }}
            className="relative shrink-0 overflow-hidden border-b border-border bg-surface/40"
          >
            <div
              className="absolute left-0 top-0 flex h-full"
              style={{ transform: `translateX(${-scroll.left}px)`, width: layout.totalWidth }}
            >
              {Array.from({ length: layout.columnCount }, (_, index) => (
                <div
                  key={index}
                  style={{ width: layout.widths[index] }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setSelection({
                      row: 1,
                      column: index + 1,
                      endRow: layout.rowCount,
                      endColumn: index + 1,
                    });
                    setCellMenu({ x: event.clientX, y: event.clientY });
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    rootRef.current?.focus();
                    setEditing(null);
                    // 点列头选中整列；Shift 点选则扩到该列
                    if (event.shiftKey) {
                      setSelection((previous) => ({
                        ...previous,
                        endRow: layout.rowCount,
                        endColumn: index + 1,
                      }));
                    } else {
                      setSelection({
                        row: 1,
                        column: index + 1,
                        endRow: layout.rowCount,
                        endColumn: index + 1,
                      });
                    }
                  }}
                  className={`relative flex h-full cursor-default items-center justify-center border-r border-border/60 text-[10px] ${
                    selectionBounds(selection).left <= index + 1 &&
                    selectionBounds(selection).right >= index + 1
                      ? "bg-accent/10 font-medium text-accent"
                      : "text-text-muted"
                  }`}
                >
                  {columnLetter(index + 1)}
                  <div
                    onMouseDown={(event) => beginResize("column", index + 1, event)}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      autoFitColumn(index + 1);
                    }}
                    title="拖动调整列宽，双击自适应"
                    style={{ width: RESIZE_HANDLE_SIZE }}
                    className="absolute inset-y-0 right-0 cursor-col-resize hover:bg-accent/50"
                  />
                </div>
              ))}
            </div>
          </div>

          <div
            ref={gridRef}
            className="min-h-0 flex-1 overflow-auto"
            onScroll={(event) =>
              setScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop })
            }
          >
            <div
              className="relative"
              style={{ width: layout.totalWidth, height: layout.totalHeight }}
            >
              {visibleRows.map((row) =>
                visibleColumns.map((column) => {
                  const key = `${row}:${column}`;
                  const owner = layout.snapshot.merges.owners.get(key);
                  const span = layout.snapshot.merges.spans.get(key);
                  const snapshotCell = owner
                    ? undefined
                    : layout.snapshot.cells.get(row)?.get(column);
                  const text = snapshotCell?.text ?? "";
                  const inSelection = isCellInSelection(selection, row, column);
                  const isActive = selection.row === row && selection.column === column;

                  let width = layout.widths[column - 1];
                  let height = layout.heights[row - 1];
                  if (span) {
                    for (let extra = 1; extra < span.columnSpan; extra += 1) {
                      width += layout.widths[column - 1 + extra] ?? 0;
                    }
                    height = 0;
                    for (let extra = 0; extra < span.rowSpan; extra += 1) {
                      height += layout.heights[row - 1 + extra] ?? DEFAULT_ROW_HEIGHT;
                    }
                  }

                  return (
                    <div
                      key={key}
                      style={{
                        top: layout.rowOffsets[row - 1],
                        left: layout.offsets[column - 1],
                        width,
                        height,
                        zIndex: isActive ? 3 : span ? 2 : undefined,
                      }}
                      onMouseDown={(event) => {
                        rootRef.current?.focus();
                        // 正在编辑别的单元格时先提交，避免点击丢内容
                        if (editing && (editing.row !== row || editing.column !== column)) {
                          commitEdit(editing.value, 0, 0);
                        }
                        if (event.shiftKey) {
                          extendSelectionTo(row, column);
                          return;
                        }
                        dragSelectRef.current = true;
                        selectCell(row, column);
                      }}
                      onMouseEnter={() => {
                        const fillSource = fillDragRef.current;
                        if (fillSource) {
                          // 只向下 / 向右扩展，且不缩回源区
                          const next = {
                            top: fillSource.top,
                            left: fillSource.left,
                            bottom: Math.max(fillSource.bottom, row),
                            right: Math.max(fillSource.right, column),
                          };
                          fillPreviewRef.current = next;
                          setFillPreview(next);
                          return;
                        }
                        if (dragSelectRef.current) {
                          extendSelectionTo(row, column);
                        }
                      }}
                      onDoubleClick={() => startEdit(row, column)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        rootRef.current?.focus();
                        // Excel 习惯：右键落在选区外时先选中该格
                        if (!isCellInSelection(selection, row, column)) {
                          selectCell(row, column);
                        }
                        setCellMenu({ x: event.clientX, y: event.clientY });
                      }}
                      title={text}
                      className={`absolute overflow-hidden whitespace-nowrap border-b border-r border-border/50 px-1.5 text-xs leading-[25px] text-text-primary ${
                        snapshotCell?.numeric ? "text-right" : "text-left"
                      } ${inSelection ? "bg-accent/10" : ""} ${
                        isActive ? "ring-1 ring-inset ring-accent" : ""
                      }`}
                    >
                      {text}
                    </div>
                  );
                }),
              )}

              {fillPreview && (
                <div
                  style={{
                    top: layout.rowOffsets[fillPreview.top - 1],
                    left: layout.offsets[fillPreview.left - 1],
                    width: (() => {
                      let total = 0;
                      for (let column = fillPreview.left; column <= fillPreview.right; column += 1) {
                        total += layout.widths[column - 1] ?? DEFAULT_COLUMN_WIDTH;
                      }
                      return total;
                    })(),
                    height: (() => {
                      let total = 0;
                      for (let row = fillPreview.top; row <= fillPreview.bottom; row += 1) {
                        total += layout.heights[row - 1] ?? DEFAULT_ROW_HEIGHT;
                      }
                      return total;
                    })(),
                  }}
                  className="pointer-events-none absolute z-[5] border border-dashed border-accent bg-accent/5"
                />
              )}

              {!editing && !isReadOnly && (
                <div
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const bounds = selectionBounds(selection);
                    fillDragRef.current = bounds;
                    fillPreviewRef.current = bounds;
                    setFillPreview(bounds);
                  }}
                  title="拖动填充（数字自动递增）"
                  style={{
                    top:
                      (layout.rowOffsets[selectionBounds(selection).bottom - 1] ?? 0) +
                      (layout.heights[selectionBounds(selection).bottom - 1] ?? DEFAULT_ROW_HEIGHT) -
                      4,
                    left:
                      (layout.offsets[selectionBounds(selection).right - 1] ?? 0) +
                      (layout.widths[selectionBounds(selection).right - 1] ?? DEFAULT_COLUMN_WIDTH) -
                      4,
                  }}
                  className="absolute z-[6] h-2 w-2 cursor-crosshair rounded-sm border border-white bg-accent"
                />
              )}

              {images.map((image) => {
                const rect = imageRect(image);
                if (!rect) return null;
                return (
                  <img
                    key={`image-${image.mediaIndex}`}
                    src={image.url}
                    alt={image.name}
                    draggable={false}
                    style={{
                      top: rect.top,
                      left: rect.left,
                      width: rect.width,
                      height: rect.height,
                      zIndex: 4,
                    }}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                      rootRef.current?.focus();
                      selectCell(image.startRow, image.startColumn);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      selectCell(image.startRow, image.startColumn);
                      setCellMenu({ x: event.clientX, y: event.clientY });
                    }}
                    onClick={() => handlePreviewImage(image)}
                    title={`${image.name} · 点击预览`}
                    className="absolute cursor-zoom-in border border-border/60 bg-white object-contain"
                  />
                );
              })}

              {editing && (
                <input
                  ref={editInputRef}
                  value={editing.value}
                  onChange={(event) => setEditing({ ...editing, value: event.target.value })}
                  onKeyDown={handleEditKeyDown}
                  onBlur={(event) => commitEdit(event.currentTarget.value, 0, 0)}
                  style={{
                    top: layout.rowOffsets[editing.row - 1],
                    left: layout.offsets[editing.column - 1],
                    width: layout.widths[editing.column - 1],
                    height: layout.heights[editing.row - 1],
                  }}
                  className="absolute z-20 border border-accent bg-primary px-1.5 text-xs text-text-primary outline-none"
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <div
        ref={sheetTabsRef}
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border bg-surface/30 px-2 py-1"
      >
        {doc.workbook.worksheets.map((worksheet, index) =>
          renamingSheet?.index === index ? (
            <input
              key={worksheet.id}
              autoFocus
              value={renamingSheet.value}
              onChange={(event) => setRenamingSheet({ index, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  renameSheet(index, renamingSheet.value);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setRenamingSheet(null);
                }
              }}
              onBlur={() => renameSheet(index, renamingSheet.value)}
              className="w-24 shrink-0 rounded border border-accent bg-primary px-1.5 py-0.5 text-[11px] text-text-primary outline-none"
            />
          ) : (
            <button
              key={worksheet.id}
              type="button"
              data-sheet-index={index}
              draggable
              onDragStart={() => setDragSheetIndex(index)}
              onDragEnd={() => setDragSheetIndex(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragSheetIndex !== null) {
                  moveSheet(dragSheetIndex, index);
                }
                setDragSheetIndex(null);
              }}
              onDoubleClick={() => setRenamingSheet({ index, value: worksheet.name })}
              onContextMenu={(event) => {
                event.preventDefault();
                setSheetMenu({ x: event.clientX, y: event.clientY, index });
              }}
              onClick={() => switchSheet(index)}
              title="双击重命名，右键更多操作，可拖动排序"
              className={`shrink-0 rounded px-2 py-0.5 text-[11px] transition-colors ${
                dragSheetIndex === index ? "opacity-50" : ""
              } ${
                index === sheetIndex
                  ? "bg-surface text-accent"
                  : "text-text-secondary hover:bg-surface/60"
              }`}
            >
              {worksheet.name}
            </button>
          ),
        )}
        <button
          type="button"
          onClick={handleAddSheet}
          disabled={isReadOnly}
          title="新增工作表"
          className="ml-0.5 flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-surface/60 hover:text-accent disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-muted"
        >
          <Plus size={12} />
          新增
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-3 pl-3 text-[11px] text-text-secondary">
          {selectionStats && (
            <>
              <span>
                求和{" "}
                {selectionStats.sum.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
              <span>计数 {selectionStats.count}</span>
              <span>
                平均{" "}
                {selectionStats.average.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            </>
          )}
          {!isSingleCell(selection) && (
            <span className="text-text-muted">{selectionLabel(selection)}</span>
          )}
        </div>
      </div>

      {rowColumnMenu && (
        <ContextMenu
          x={rowColumnMenu.x}
          y={rowColumnMenu.y}
          items={rowColumnMenuItems}
          onClose={() => setRowColumnMenu(null)}
        />
      )}

      {cellMenu && (
        <ContextMenu
          x={cellMenu.x}
          y={cellMenu.y}
          items={cellMenuItems}
          onClose={() => setCellMenu(null)}
        />
      )}

      {sheetMenu && (
        <ContextMenu
          x={sheetMenu.x}
          y={sheetMenu.y}
          items={sheetMenuItems}
          onClose={() => setSheetMenu(null)}
        />
      )}

      {findPanel && (
        <div className="fixed right-6 top-24 z-30 w-72 rounded-lg border border-border bg-surface p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium text-text-primary">查找替换（当前工作表）</span>
            <button
              type="button"
              onClick={() => setFindPanel(false)}
              className="text-text-muted transition-colors hover:text-accent"
              title="关闭"
            >
              <X size={13} />
            </button>
          </div>
          <input
            autoFocus
            value={findText}
            onChange={(event) => setFindText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                gotoMatch(1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setFindPanel(false);
                rootRef.current?.focus();
              }
            }}
            placeholder="查找内容"
            className="mb-2 w-full rounded border border-border bg-primary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent"
          />
          <input
            value={replaceText}
            onChange={(event) => setReplaceText(event.target.value)}
            placeholder="替换为"
            className="mb-2 w-full rounded border border-border bg-primary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent"
          />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => gotoMatch(-1)}
              className="rounded border border-border px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:text-accent"
            >
              上一个
            </button>
            <button
              type="button"
              onClick={() => gotoMatch(1)}
              className="rounded border border-border px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:text-accent"
            >
              下一个
            </button>
            <button
              type="button"
              onClick={() => applyReplace(false)}
              className="rounded border border-border px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:text-accent"
            >
              替换
            </button>
            <button
              type="button"
              onClick={() => applyReplace(true)}
              className="rounded border border-border px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:text-accent"
            >
              全部替换
            </button>
          </div>
          <div className="mt-2 text-[10px] text-text-muted">
            {findText.trim() ? `匹配 ${findMatches.length} 处` : "输入关键字后回车跳到下一个匹配"}
          </div>
        </div>
      )}

      {formatMenu && (
        <ContextMenu
          x={formatMenu.x}
          y={formatMenu.y}
          items={formatMenuItems}
          onClose={() => setFormatMenu(null)}
        />
      )}

      {palette && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setPalette(null)} />
          <div
            className="fixed z-50 rounded-lg border border-border bg-surface p-2 shadow-xl"
            style={{ left: palette.x, top: palette.y }}
          >
            <div className="mb-1 text-[10px] text-text-muted">
              {palette.target === "fill" ? "填充颜色" : "字体颜色"}
            </div>
            <div className="grid grid-cols-6 gap-1">
              {(palette.target === "fill" ? FILL_PALETTE : FONT_PALETTE).map((color) => (
                <button
                  key={color.argb}
                  type="button"
                  title={color.name}
                  onClick={() => {
                    applyColor(palette.target, color.argb);
                    setPalette(null);
                  }}
                  className="h-5 w-5 rounded border border-border/60 transition-transform hover:scale-110"
                  style={{ background: `#${color.argb.slice(2)}` }}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                applyColor(palette.target, null);
                setPalette(null);
              }}
              className="mt-2 w-full rounded border border-border px-2 py-0.5 text-[11px] text-text-secondary hover:text-accent"
            >
              清除颜色
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export const excelMode: EditorModeAdapter = {
  id: "excel",
  match: (tab) => tab.language === "excel",
  render: (context) => (
    <ExcelModeView
      activeTab={context.activeTab}
      showNotification={context.showNotification}
      saveActiveTab={context.saveActiveTab}
    />
  ),
};
