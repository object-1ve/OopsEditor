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
import { AlertTriangle, FileSpreadsheet, ImagePlus, Info, Loader2, Plus, Redo2, Save, Trash2, Undo2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import type { CellValue, Column, Workbook, Worksheet } from "exceljs";
import { loadExcelDoc, type ExcelDoc } from "@/services/excelDocs";
import { copyTextToClipboard } from "@/utils/clipboard";
import { useEditorStore } from "@/store/editor";
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
  row: number;
  column: number;
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
  return { text: formatted ?? "", numeric: typeof value === "number" };
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
function resolveMergeOwner(merges: MergeIndex, row: number, column: number): Selection {
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
  const [selection, setSelection] = useState<Selection>({ row: 1, column: 1 });
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
  const historyRef = useRef<{ entries: HistoryEntry[]; index: number }>({ entries: [], index: -1 });
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
        setSelection({ row: 1, column: 1 });
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

  const pushHistory = useCallback((entry: HistoryEntry) => {
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
      const snapshot = snapshotsRef.current.get(entry.sheetIndex);
      if (!sheet) return;

      for (const change of entry.changes) {
        sheet.getCell(change.row, change.column).value =
          direction === -1 ? change.before : change.after;
        if (snapshot) {
          refreshSnapshotCell(snapshot, sheet, change.row, change.column);
        }
      }

      history.index += direction;
      setHistoryState({
        canUndo: history.index >= 0,
        canRedo: history.index < history.entries.length - 1,
      });
      setSheetIndex(entry.sheetIndex);
      setSelection({ row: entry.changes[0].row, column: entry.changes[0].column });
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

      pushHistory({ sheetIndex, changes });
      setLayoutVersion((version) => version + 1);
      markTabDirty(activeTab.id);
    },
    [doc, markTabDirty, pushHistory, sheetIndex],
  );

  const moveSelection = useCallback(
    (rowDelta: number, columnDelta: number) => {
      setSelection((previous) => {
        const row = Math.min(Math.max(1, previous.row + rowDelta), layout?.rowCount ?? 1);
        const column = Math.min(Math.max(1, previous.column + columnDelta), layout?.columnCount ?? 1);
        return layout ? resolveMergeOwner(layout.snapshot.merges, row, column) : { row, column };
      });
    },
    [layout],
  );

  /** 点选单元格：合并区内的从属格统一落到 master 上 */
  const selectCell = useCallback(
    (row: number, column: number) => {
      setSelection(layout ? resolveMergeOwner(layout.snapshot.merges, row, column) : { row, column });
    },
    [layout],
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

      setSelection({ row: targetRow, column: targetColumn });
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

  const clearSelection = useCallback(() => {
    if (isReadOnly || !layout) return;

    const hasValue = layout.snapshot.cells.get(selection.row)?.has(selection.column) ?? false;
    if (!hasValue) return;

    const cell = layout.sheet.getCell(selection.row, selection.column);
    const before = cell.value;
    cell.value = null;
    applyChanges([{ row: selection.row, column: selection.column, before, after: null }]);
  }, [applyChanges, isReadOnly, layout, selection]);

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
          const text = layout.snapshot.cells.get(selection.row)?.get(selection.column)?.text ?? "";
          void copyTextToClipboard(text);
        }
        return;
      }

      switch (event.key) {
        case "ArrowUp":
          event.preventDefault();
          moveSelection(-1, 0);
          return;
        case "ArrowDown":
          event.preventDefault();
          moveSelection(1, 0);
          return;
        case "ArrowLeft":
          event.preventDefault();
          moveSelection(0, -1);
          return;
        case "ArrowRight":
          event.preventDefault();
          moveSelection(0, 1);
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
      clearSelection,
      doc,
      editing,
      isReadOnly,
      layout,
      moveSelection,
      saveActiveTab,
      selection,
      startEdit,
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
    [
      applyChanges,
      commitEdit,
      doc,
      editing,
      insertImageAtSelection,
      isReadOnly,
      layout,
      selection,
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

  const switchSheet = useCallback((index: number) => {
    setSheetIndex(index);
    setSelection({ row: 1, column: 1 });
    setEditing(null);
    const node = gridRef.current;
    if (node) {
      node.scrollTop = 0;
      node.scrollLeft = 0;
    }
    setScroll({ left: 0, top: 0 });
  }, []);

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
        <span className="shrink-0 rounded border border-border bg-deepest px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
          {columnLetter(selection.column)}
          {selection.row}
        </span>
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
                  className={`group absolute inset-x-0 flex items-center justify-center border-b border-border/60 text-[10px] ${
                    selection.row === row ? "bg-accent/10 font-medium text-accent" : "text-text-muted"
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
                  className={`relative flex h-full items-center justify-center border-r border-border/60 text-[10px] ${
                    selection.column === index + 1
                      ? "bg-accent/10 font-medium text-accent"
                      : "text-text-muted"
                  }`}
                >
                  {columnLetter(index + 1)}
                  <div
                    onMouseDown={(event) => beginResize("column", index + 1, event)}
                    title="拖动调整列宽"
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
                  const isSelected = selection.row === row && selection.column === column;

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
                        zIndex: isSelected ? 3 : span ? 2 : undefined,
                      }}
                      onMouseDown={() => {
                        rootRef.current?.focus();
                        // 正在编辑别的单元格时先提交，避免点击丢内容
                        if (editing && (editing.row !== row || editing.column !== column)) {
                          commitEdit(editing.value, 0, 0);
                        }
                        selectCell(row, column);
                      }}
                      onDoubleClick={() => startEdit(row, column)}
                      title={text}
                      className={`absolute overflow-hidden whitespace-nowrap border-b border-r border-border/50 px-1.5 text-xs leading-[25px] text-text-primary ${
                        snapshotCell?.numeric ? "text-right" : "text-left"
                      } ${isSelected ? "bg-accent/5 ring-1 ring-inset ring-accent" : ""}`}
                    >
                      {text}
                    </div>
                  );
                }),
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
        {doc.workbook.worksheets.map((worksheet, index) => (
          <button
            key={worksheet.id}
            type="button"
            data-sheet-index={index}
            onClick={() => switchSheet(index)}
            className={`shrink-0 rounded px-2 py-0.5 text-[11px] transition-colors ${
              index === sheetIndex
                ? "bg-surface text-accent"
                : "text-text-secondary hover:bg-surface/60"
            }`}
          >
            {worksheet.name}
          </button>
        ))}
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
      </div>
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
