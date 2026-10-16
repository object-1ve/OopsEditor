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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileSpreadsheet, Info, Loader2, Redo2, Save, Undo2 } from "lucide-react";
import type { CellValue, Worksheet } from "exceljs";
import { loadExcelDoc, type ExcelDoc } from "@/services/excelDocs";
import { copyTextToClipboard } from "@/utils/clipboard";
import { useEditorStore } from "@/store/editor";
import type { EditorModeContext, EditorModeAdapter } from "./types";

const ROW_HEIGHT = 26;
const COLUMN_HEADER_HEIGHT = 26;
const ROW_HEADER_WIDTH = 54;
/** 未设置列宽时的默认像素宽 */
const DEFAULT_COLUMN_WIDTH = 96;
const MIN_COLUMN_WIDTH = 64;
/** 渲染上限：超大表格只展示前若干行/列，避免一次性建出巨量 DOM */
const MAX_RENDER_ROWS = 5000;
const MAX_RENDER_COLUMNS = 512;
/** 数据区下方额外留出的空行，方便直接往下录入 */
const TRAILING_EMPTY_ROWS = 20;
const MIN_RENDER_ROWS = 60;
const MIN_RENDER_COLUMNS = 26;
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

/** 按工作表列宽定义换算像素宽；`sheet.columns` 是只读视图，不会写回文件 */
function columnWidthsPx(sheet: Worksheet, columnCount: number): number[] {
  const widths = new Array<number>(columnCount).fill(DEFAULT_COLUMN_WIDTH);
  for (const column of sheet.columns) {
    const index = column.number;
    if (!index || index > columnCount) continue;
    if (typeof column.width === "number" && column.width > 0) {
      widths[index - 1] = Math.max(MIN_COLUMN_WIDTH, Math.round(column.width * 7.2) + 8);
    }
  }
  return widths;
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

  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<{ entries: HistoryEntry[]; index: number }>({ entries: [], index: -1 });
  const snapshotsRef = useRef<Map<number, SheetSnapshot>>(new Map());

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
    const widths = columnWidthsPx(sheet, columnCount);
    const offsets: number[] = [];
    let cursor = 0;
    for (let index = 0; index < columnCount; index += 1) {
      offsets.push(cursor);
      cursor += widths[index];
    }

    return {
      sheet,
      snapshot,
      rowCount,
      columnCount,
      widths,
      offsets,
      totalWidth: cursor,
      totalHeight: rowCount * ROW_HEIGHT,
    };
  }, [doc, sheetIndex, layoutVersion]);

  const visibleRows = useMemo(() => {
    if (!layout) return [];
    const first = Math.max(1, Math.floor(scroll.top / ROW_HEIGHT));
    const last = Math.min(layout.rowCount, Math.ceil((scroll.top + viewport.height) / ROW_HEIGHT) + 1);
    const rows: number[] = [];
    for (let row = first; row <= last; row += 1) rows.push(row);
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

    const top = (selection.row - 1) * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
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

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (editing || isReadOnly || !doc || !layout) return;
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
    [applyChanges, doc, editing, isReadOnly, layout, selection, showNotification],
  );

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
                  style={{ top: (row - 1) * ROW_HEIGHT, height: ROW_HEIGHT }}
                  className={`absolute inset-x-0 flex items-center justify-center border-b border-border/60 text-[10px] ${
                    selection.row === row ? "bg-accent/10 font-medium text-accent" : "text-text-muted"
                  }`}
                >
                  {row}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
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
                  className={`flex h-full items-center justify-center border-r border-border/60 text-[10px] ${
                    selection.column === index + 1
                      ? "bg-accent/10 font-medium text-accent"
                      : "text-text-muted"
                  }`}
                >
                  {columnLetter(index + 1)}
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
                  let height = ROW_HEIGHT;
                  if (span) {
                    for (let extra = 1; extra < span.columnSpan; extra += 1) {
                      width += layout.widths[column - 1 + extra] ?? 0;
                    }
                    height = span.rowSpan * ROW_HEIGHT;
                  }

                  return (
                    <div
                      key={key}
                      style={{
                        top: (row - 1) * ROW_HEIGHT,
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

              {editing && (
                <input
                  ref={editInputRef}
                  value={editing.value}
                  onChange={(event) => setEditing({ ...editing, value: event.target.value })}
                  onKeyDown={handleEditKeyDown}
                  onBlur={(event) => commitEdit(event.currentTarget.value, 0, 0)}
                  style={{
                    top: (editing.row - 1) * ROW_HEIGHT,
                    left: layout.offsets[editing.column - 1],
                    width: layout.widths[editing.column - 1],
                    height: ROW_HEIGHT,
                  }}
                  className="absolute z-20 border border-accent bg-primary px-1.5 text-xs text-text-primary outline-none"
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border bg-surface/30 px-2 py-1">
        {doc.workbook.worksheets.map((worksheet, index) => (
          <button
            key={worksheet.id}
            type="button"
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
