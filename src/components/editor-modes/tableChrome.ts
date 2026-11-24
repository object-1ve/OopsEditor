/**
 * Markdown 表格交互层（即时渲染模式）：把 ArcMD 的表格手感搬到 Vditor 的 IR 表格上。
 *
 * 参考 ArcMD（internal/editor/table.go）的表格交互：
 * - 列上方 / 行左侧的灰色条（bar），指针靠近表格时出现；
 * - 条在列/行边界上的「+」引脚：悬停显示虚线插入缝，点击在该边界插入一行/一列；
 * - 点击条选中整行/整列并浮出工具条（左右/上下插入、删除）；
 * - 拖动条换位，落点用虚线与浮起副本提示。
 *
 * Markdown 表格表达不了的能力（合并单元格、单元格底色、列宽百分比、按列排序）不在本层实现。
 *
 * 结构改动直接改 IR 表格的 DOM，再派发一次 input 事件让 Vditor 用 Lute 重新规范化整块、
 * 入撤销栈并触发内容回写——和用户亲手输入走同一条管线。
 */

/** 条厚度（ArcMD tableBar） */
const BAR = 10;
/** 条与表格之间的间距（ArcMD tableBarGap） */
const GAP = 4;
/** 引脚命中区直径 */
const PIN = 16;
/** 插入缝厚度 */
const SEAM = 8;
/** 指针离表格多近就显示条 */
const EDGE = 24;
/** 拖动超过这个距离才算换位，否则视为点选 */
const DRAG_THRESHOLD = 4;
/** 表格最多的一侧列边界数，超出则不再画条（超大表仍可用，只是没有条） */
const MAX_LINES = 80;

type Axis = "row" | "col";

interface Geom {
  /** 表格左上角（覆盖层坐标系） */
  x: number;
  y: number;
  /** 表格宽高 */
  w: number;
  h: number;
  /** 列边界（相对表格左边界，长度 = 列数 + 1） */
  cols: number[];
  /** 行边界（相对表格上边界，长度 = 行数 + 1） */
  rows: number[];
}

interface Frame {
  table: HTMLTableElement;
  root: HTMLDivElement;
  colBars: HTMLDivElement[];
  rowBars: HTMLDivElement[];
  geom: Geom | null;
}

interface LineSelection {
  frame: Frame;
  axis: Axis;
  index: number;
}

interface DragState {
  frame: Frame;
  axis: Axis;
  from: number;
  to: number;
  /** 指针起始坐标（沿拖动轴） */
  start: number;
  /** 指针当前位置（沿拖动轴） */
  pos: number;
  active: boolean;
}

interface PinHover {
  axis: Axis;
  index: number;
}

export interface TableChromeOptions {
  /** 编辑区外层容器：覆盖层挂在这里，坐标以它的内边距盒为原点 */
  host: HTMLElement;
  /** IR 内容根 pre.vditor-reset：表格与滚动都在里面 */
  scroller: HTMLElement;
  /** 表格结构改动后立即回写标签内容 */
  onCommit: () => void;
  /** 只读标签不提供条与工具条 */
  isReadOnly: () => boolean;
}

const ICON = {
  insertLeft:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 4.5v7M4.5 8h7"/><path d="M13.5 3v10"/></svg>',
  insertRight:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 4.5v7M4.5 8h7"/><path d="M2.5 3v10"/></svg>',
  insertAbove:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 4.5v7M4.5 8h7"/><path d="M3 13.5h10"/></svg>',
  insertBelow:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 4.5v7M4.5 8h7"/><path d="M3 2.5h10"/></svg>',
  trash:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8"/></svg>',
} as const;

/** 表格内容：行 × 列的单元格 innerHTML，外加每列的对齐方式（Lute 用 align 属性记住 `:---:`） */
interface TableModel {
  rows: string[][];
  aligns: Array<string | null>;
}

function readTable(table: HTMLTableElement): TableModel {
  const rows = Array.from(table.rows).map((tr) =>
    Array.from(tr.cells).map((cell) => cell.innerHTML),
  );
  const header = table.rows[0];
  const aligns = header
    ? Array.from(header.cells).map((cell) => cell.getAttribute("align"))
    : [];
  return { rows, aligns };
}

/**
 * 把内容写回表格：第一行固定是表头（th），其余是普通行（td）。
 * 空单元格补一个空格，和 Vditor 自己插入行列时的写法一致；列对齐写回每一行。
 */
function writeTable(table: HTMLTableElement, model: TableModel) {
  const cell = (tag: "th" | "td", html: string, align: string | null) =>
    `<${tag}${align ? ` align="${align}"` : ""}>${html === "" ? " " : html}</${tag}>`;
  const head = model.rows[0]
    .map((html, i) => cell("th", html, model.aligns[i] ?? null))
    .join("");
  const body = model.rows
    .slice(1)
    .map(
      (row) =>
        `<tr>${row.map((html, i) => cell("td", html, model.aligns[i] ?? null)).join("")}</tr>`,
    )
    .join("");
  table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
}

export class TableChrome {
  private readonly opts: TableChromeOptions;
  private readonly overlay: HTMLDivElement;
  private readonly frames = new Map<HTMLTableElement, Frame>();
  private readonly toolbar: HTMLDivElement;
  private readonly highlight: HTMLDivElement;
  private readonly pin: HTMLDivElement;
  private readonly colSeam: HTMLDivElement;
  private readonly rowSeam: HTMLDivElement;
  private readonly ghost: HTMLDivElement;
  private readonly slot: HTMLDivElement;

  private disabled = false;
  private active: Frame | null = null;
  private selection: LineSelection | null = null;
  private drag: DragState | null = null;
  private pinHover: { frame: Frame; axis: Axis; index: number } | null = null;

  private layoutRaf = 0;
  private readonly mutationObserver: MutationObserver;
  private readonly resizeObserver: ResizeObserver;
  private destroyed = false;

  constructor(options: TableChromeOptions) {
    this.opts = options;

    this.overlay = document.createElement("div");
    this.overlay.className = "oops-table-chrome";

    this.highlight = this.createElement("div", "oops-table-highlight");
    this.colSeam = this.createElement("div", "oops-table-seam");
    this.rowSeam = this.createElement("div", "oops-table-seam");
    this.slot = this.createElement("div", "oops-table-slot");
    this.ghost = this.createElement("div", "oops-table-ghost");
    this.pin = this.createElement("div", "oops-table-pin");
    this.pin.innerHTML = ICON.insertLeft;
    this.toolbar = this.createElement("div", "oops-table-toolbar");

    this.overlay.append(this.highlight, this.colSeam, this.rowSeam, this.slot, this.ghost, this.pin, this.toolbar);
    this.opts.host.append(this.overlay);

    this.mutationObserver = new MutationObserver(() => this.scheduleLayout());
    this.mutationObserver.observe(this.opts.scroller, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    this.resizeObserver = new ResizeObserver(() => this.scheduleLayout());
    this.resizeObserver.observe(this.opts.scroller);

    this.opts.scroller.addEventListener("scroll", this.handleScroll, { passive: true });
    this.opts.host.addEventListener("pointermove", this.handlePointerMove);
    this.opts.host.addEventListener("pointerleave", this.handlePointerLeave);
    this.opts.host.addEventListener("pointerdown", this.handlePointerDown);
    document.addEventListener("pointermove", this.handleDragMove, true);
    document.addEventListener("pointerup", this.handleDragEnd, true);
    document.addEventListener("pointercancel", this.handleDragEnd, true);
    document.addEventListener("pointerdown", this.handleOutsideDown, true);
    document.addEventListener("selectionchange", this.handleSelectionChange);
    window.addEventListener("resize", this.scheduleLayout);

    this.sync();
  }

  /** 只读 / 禁用时收起所有浮层并停止响应指针 */
  setDisabled(disabled: boolean) {
    this.disabled = disabled;
    if (!disabled) return;
    this.pinHover = null;
    this.drag = null;
    this.active = null;
    this.clearSelection();
    this.hidePinHover();
    this.slot.classList.remove("is-visible");
    this.ghost.classList.remove("is-visible");
    for (const frame of this.frames.values()) frame.root.classList.remove("is-active");
  }

  destroy() {
    this.destroyed = true;
    if (this.layoutRaf) cancelAnimationFrame(this.layoutRaf);
    this.mutationObserver.disconnect();
    this.resizeObserver.disconnect();
    this.opts.scroller.removeEventListener("scroll", this.handleScroll);
    this.opts.host.removeEventListener("pointermove", this.handlePointerMove);
    this.opts.host.removeEventListener("pointerleave", this.handlePointerLeave);
    this.opts.host.removeEventListener("pointerdown", this.handlePointerDown);
    document.removeEventListener("pointermove", this.handleDragMove, true);
    document.removeEventListener("pointerup", this.handleDragEnd, true);
    document.removeEventListener("pointercancel", this.handleDragEnd, true);
    document.removeEventListener("pointerdown", this.handleOutsideDown, true);
    document.removeEventListener("selectionchange", this.handleSelectionChange);
    window.removeEventListener("resize", this.scheduleLayout);
    this.overlay.remove();
    this.frames.clear();
  }

  // ---------------------------------------------------------------------------
  // 布局：扫描表格、算几何、摆放条与浮层
  // ---------------------------------------------------------------------------

  private createElement<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    element.className = className;
    return element;
  }

  private scheduleLayout() {
    if (this.destroyed || this.layoutRaf) return;
    this.layoutRaf = requestAnimationFrame(() => {
      this.layoutRaf = 0;
      this.sync();
    });
  }

  private handleScroll = () => {
    this.scheduleLayout();
  };

  /** 重新扫描表格并与帧对齐（表格被 Lute 重建后 DOM 节点会换新） */
  private sync() {
    if (this.destroyed) return;
    const tables = Array.from(this.opts.scroller.querySelectorAll("table")).filter(
      (table): table is HTMLTableElement =>
        table instanceof HTMLTableElement && !table.closest(".vditor-ir__preview"),
    );

    for (const [table, frame] of this.frames) {
      if (!tables.includes(table)) {
        frame.root.remove();
        this.frames.delete(table);
        if (this.active === frame) this.active = null;
        if (this.selection?.frame === frame) this.clearSelection();
        if (this.drag?.frame === frame) this.drag = null;
      }
    }

    for (const table of tables) {
      if (!this.frames.has(table)) this.frames.set(table, this.createFrame(table));
    }
    if (!this.selection) this.toolbar.classList.remove("is-visible");

    const origin = this.overlay.getBoundingClientRect();
    for (const frame of this.frames.values()) this.layoutFrame(frame, origin);
    this.renderActive();
  }

  private createFrame(table: HTMLTableElement): Frame {
    const root = this.createElement("div", "oops-table-frame");
    this.overlay.append(root);
    return { table, root, colBars: [], rowBars: [], geom: null };
  }

  private layoutFrame(frame: Frame, origin: DOMRect) {
    const { table } = frame;
    if (!table.isConnected) return;
    const tableRect = table.getBoundingClientRect();
    if (tableRect.width === 0 && tableRect.height === 0) return;

    const x = tableRect.left - origin.left;
    const y = tableRect.top - origin.top;
    const rows = table.rows;
    const firstRow = rows[0];
    if (!firstRow || firstRow.cells.length === 0) return;

    const cols: number[] = [0];
    for (const cell of Array.from(firstRow.cells)) {
      cols.push(cell.getBoundingClientRect().right - tableRect.left);
    }
    const rowBounds: number[] = [0];
    for (const tr of Array.from(rows)) {
      rowBounds.push(tr.getBoundingClientRect().bottom - tableRect.top);
    }

    frame.geom = { x, y, w: tableRect.width, h: tableRect.height, cols, rows: rowBounds };

    const colCount = cols.length - 1;
    const rowCount = rowBounds.length - 1;
    frame.root.classList.toggle("is-crowded", colCount > MAX_LINES || rowCount > MAX_LINES);
    if (colCount > MAX_LINES || rowCount > MAX_LINES) return;

    this.ensureBars(frame.colBars, colCount, frame.root, "oops-table-bar is-col");
    this.ensureBars(frame.rowBars, rowCount, frame.root, "oops-table-bar is-row");

    for (let i = 0; i < colCount; i++) {
      const bar = frame.colBars[i];
      bar.style.left = `${x + cols[i] + 1}px`;
      bar.style.top = `${y - GAP - BAR}px`;
      bar.style.width = `${Math.max(2, cols[i + 1] - cols[i] - 2)}px`;
      bar.style.height = `${BAR}px`;
      bar.dataset.index = String(i);
    }
    for (let i = 0; i < rowCount; i++) {
      const bar = frame.rowBars[i];
      bar.style.left = `${x - GAP - BAR}px`;
      bar.style.top = `${y + rowBounds[i] + 1}px`;
      bar.style.width = `${BAR}px`;
      bar.style.height = `${Math.max(2, rowBounds[i + 1] - rowBounds[i] - 2)}px`;
      bar.dataset.index = String(i);
    }

    frame.root.classList.toggle(
      "is-selected",
      this.selection !== null && this.selection.frame === frame,
    );
    this.renderSelection();
    this.renderPinHover();
  }

  private ensureBars(pool: HTMLDivElement[], count: number, root: HTMLDivElement, className: string) {
    while (pool.length > count) pool.pop()?.remove();
    while (pool.length < count) {
      const bar = document.createElement("div");
      bar.className = className;
      root.append(bar);
      pool.push(bar);
    }
  }

  private renderActive() {
    for (const frame of this.frames.values()) {
      frame.root.classList.toggle("is-active", frame === this.active);
    }
    if (!this.active) this.hidePinHover();
  }

  private renderSelection() {
    const selection = this.selection;
    if (!selection) {
      this.highlight.classList.remove("is-visible");
      this.toolbar.classList.remove("is-visible");
      return;
    }
    const { frame, axis, index } = selection;
    const geom = frame.geom;
    if (!geom) return;
    if (axis === "col") {
      if (index < 0 || index >= geom.cols.length - 1) return this.clearSelection();
      this.highlight.style.left = `${geom.x + geom.cols[index]}px`;
      this.highlight.style.top = `${geom.y}px`;
      this.highlight.style.width = `${geom.cols[index + 1] - geom.cols[index]}px`;
      this.highlight.style.height = `${geom.h}px`;
    } else {
      if (index < 0 || index >= geom.rows.length - 1) return this.clearSelection();
      this.highlight.style.left = `${geom.x}px`;
      this.highlight.style.top = `${geom.y + geom.rows[index]}px`;
      this.highlight.style.width = `${geom.w}px`;
      this.highlight.style.height = `${geom.rows[index + 1] - geom.rows[index]}px`;
    }
    this.highlight.classList.add("is-visible");
    this.renderToolbar();
  }

  private renderPinHover() {
    const hover = this.pinHover;
    if (!hover || !hover.frame.geom || hover.frame !== this.active) {
      this.hidePinHover();
      return;
    }
    const geom = hover.frame.geom;
    if (hover.axis === "col") {
      const index = hover.index;
      if (index < 0 || index >= geom.cols.length) return this.hidePinHover();
      const boundary = geom.x + geom.cols[index];
      this.pin.style.left = `${boundary - PIN / 2}px`;
      this.pin.style.top = `${geom.y - GAP - BAR / 2 - PIN / 2}px`;
      this.colSeam.style.left = `${boundary - SEAM / 2}px`;
      this.colSeam.style.top = `${geom.y}px`;
      this.colSeam.style.width = `${SEAM}px`;
      this.colSeam.style.height = `${geom.h}px`;
      this.colSeam.classList.add("is-visible");
      this.rowSeam.classList.remove("is-visible");
    } else {
      const index = hover.index;
      if (index < 0 || index >= geom.rows.length) return this.hidePinHover();
      const boundary = geom.y + geom.rows[index];
      this.pin.style.left = `${geom.x - GAP - BAR / 2 - PIN / 2}px`;
      this.pin.style.top = `${boundary - PIN / 2}px`;
      this.rowSeam.style.left = `${geom.x}px`;
      this.rowSeam.style.top = `${boundary - SEAM / 2}px`;
      this.rowSeam.style.width = `${geom.w}px`;
      this.rowSeam.style.height = `${SEAM}px`;
      this.rowSeam.classList.add("is-visible");
      this.colSeam.classList.remove("is-visible");
    }
    this.pin.classList.add("is-visible");
  }

  private hidePinHover() {
    this.pin.classList.remove("is-visible");
    this.colSeam.classList.remove("is-visible");
    this.rowSeam.classList.remove("is-visible");
  }

  private renderToolbar() {
    const selection = this.selection;
    const geom = selection?.frame.geom;
    if (!selection || !geom) {
      this.toolbar.classList.remove("is-visible");
      return;
    }
    const isCol = selection.axis === "col";
    const total = isCol ? geom.cols.length - 1 : geom.rows.length - 1;
    const canDelete = total > 1;

    this.toolbar.replaceChildren(
      this.toolbarButton(isCol ? "在左侧插入列" : "在上方插入行", isCol ? ICON.insertLeft : ICON.insertAbove, () =>
        this.insertLine(selection.frame, selection.axis, selection.index),
      ),
      this.toolbarButton(isCol ? "在右侧插入列" : "在下方插入行", isCol ? ICON.insertRight : ICON.insertBelow, () =>
        this.insertLine(selection.frame, selection.axis, selection.index + 1),
      ),
      this.toolbarButton(isCol ? "删除列" : "删除行", ICON.trash, () =>
        this.deleteLine(selection.frame, selection.axis, selection.index),
        !canDelete,
        true,
      ),
    );
    this.toolbar.classList.add("is-visible");
    this.toolbar.dataset.axis = selection.axis;

    // 定位：列工具条浮在表格上方、对准列中；行工具条浮在表格左侧、对准行中
    const width = this.toolbar.offsetWidth;
    const height = this.toolbar.offsetHeight;
    if (isCol) {
      const center = geom.x + (geom.cols[selection.index] + geom.cols[selection.index + 1]) / 2;
      const left = Math.min(
        Math.max(4, center - width / 2),
        Math.max(4, this.overlay.clientWidth - width - 4),
      );
      this.toolbar.style.left = `${left}px`;
      this.toolbar.style.top = `${Math.max(2, geom.y - GAP - BAR - height - 6)}px`;
    } else {
      const center = geom.y + (geom.rows[selection.index] + geom.rows[selection.index + 1]) / 2;
      const left = geom.x - GAP - BAR - width - 6;
      this.toolbar.style.left = `${Math.max(2, left)}px`;
      this.toolbar.style.top = `${Math.max(2, center - height / 2)}px`;
    }
  }

  private toolbarButton(
    label: string,
    icon: string,
    onClick: () => void,
    disabled = false,
    danger = false,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `oops-table-toolbar__item${danger ? " is-danger" : ""}`;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = icon;
    button.disabled = disabled;
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (disabled) return;
      onClick();
    });
    return button;
  }

  // ---------------------------------------------------------------------------
  // 指针：悬停激活、引脚预览、选中、拖拽
  // ---------------------------------------------------------------------------

  private handlePointerMove = (event: PointerEvent) => {
    if (this.disabled || this.opts.isReadOnly() || this.drag?.active) return;
    // 工具条浮在表格上方、超出「靠近表格」的范围，指针在上面时不要重新判定
    if (event.target instanceof Node && this.overlay.contains(event.target)) return;
    const point = this.toLocal(event);
    const frame = this.frameNear(point);
    if (frame !== this.active) {
      this.active = frame;
      this.renderActive();
      if (!frame) {
        this.clearSelection();
        return;
      }
    }
    if (!frame?.geom) return;
    const pin = this.hitPin(frame.geom, point);
    this.pinHover = pin ? { frame, axis: pin.axis, index: pin.index } : null;
    this.renderPinHover();
  };

  private handlePointerLeave = () => {
    if (this.drag) return;
    this.pinHover = null;
    this.active = null;
    this.renderActive();
  };

  private handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.disabled || this.opts.isReadOnly()) return;
    if ((event.target as HTMLElement | null)?.closest(".oops-table-toolbar")) return;
    const point = this.toLocal(event);
    const frame = this.frameNear(point);
    if (!frame?.geom) return;

    const pin = this.hitPin(frame.geom, point);
    if (pin) {
      event.preventDefault();
      event.stopPropagation();
      this.pinHover = null;
      this.hidePinHover();
      this.insertLine(frame, pin.axis, pin.index);
      return;
    }

    const col = this.hitColBar(frame.geom, point);
    if (col >= 0) {
      event.preventDefault();
      event.stopPropagation();
      this.select(frame, "col", col);
      this.beginDrag(event, frame, "col", col);
      return;
    }
    const row = this.hitRowBar(frame.geom, point);
    if (row >= 0) {
      event.preventDefault();
      event.stopPropagation();
      this.select(frame, "row", row);
      if (row > 0) this.beginDrag(event, frame, "row", row);
      return;
    }
  };

  /** 光标进入表格（点单元格、Tab 跨格）：和 ArcMD 一样让条保持可见 */
  private handleSelectionChange = () => {
    if (this.disabled || this.opts.isReadOnly()) return;
    const anchor = document.getSelection()?.anchorNode;
    if (!anchor) return;
    if (this.active?.table.contains(anchor)) return;
    for (const frame of this.frames.values()) {
      if (!frame.table.contains(anchor)) continue;
      this.active = frame;
      this.renderActive();
      return;
    }
  };

  /** 点在编辑区其它地方：收起选中（工具条按钮已在自己的 pointerdown 里停掉冒泡） */
  private handleOutsideDown = (event: PointerEvent) => {
    if (!this.selection) return;
    const target = event.target;
    if (target instanceof Node && this.overlay.contains(target)) return;
    this.clearSelection();
  };

  private beginDrag(event: PointerEvent, frame: Frame, axis: Axis, index: number) {
    const point = this.toLocal(event);
    this.drag = {
      frame,
      axis,
      from: index,
      to: index,
      start: axis === "col" ? point.x : point.y,
      pos: axis === "col" ? point.x : point.y,
      active: false,
    };
  }

  private handleDragMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag) return;
    const geom = drag.frame.geom;
    if (!geom) return;
    const point = this.toLocal(event);
    drag.pos = drag.axis === "col" ? point.x : point.y;
    if (!drag.active && Math.abs(drag.pos - drag.start) > DRAG_THRESHOLD) {
      drag.active = true;
      this.highlight.classList.remove("is-visible");
      this.toolbar.classList.remove("is-visible");
    }
    if (!drag.active) return;

    const bounds = drag.axis === "col" ? geom.cols : geom.rows;
    const local = drag.axis === "col" ? drag.pos - geom.x : drag.pos - geom.y;
    const lineCount = bounds.length - 1;
    let target = lineCount - 1;
    for (let i = 0; i < lineCount; i++) {
      if (local < bounds[i + 1]) {
        target = i;
        break;
      }
    }
    // Markdown 表格的第一行永远是表头，不允许把普通行拖到表头位置
    if (drag.axis === "row" && target < 1) target = 1;
    drag.to = target;
    this.renderDrag();
  };

  private handleDragEnd = () => {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.slot.classList.remove("is-visible");
    this.ghost.classList.remove("is-visible");
    if (!drag.active || drag.from === drag.to) {
      this.renderSelection();
      return;
    }
    this.moveLine(drag.frame, drag.axis, drag.from, drag.to);
  };

  private renderDrag() {
    const drag = this.drag;
    const geom = drag?.frame.geom;
    if (!drag || !geom || !drag.active) return;
    const isCol = drag.axis === "col";
    const bounds = isCol ? geom.cols : geom.rows;
    const size = bounds[drag.from + 1] - bounds[drag.from];
    const targetStart = bounds[drag.to];

    if (isCol) {
      this.slot.style.left = `${geom.x + targetStart}px`;
      this.slot.style.top = `${geom.y}px`;
      this.slot.style.width = `${size}px`;
      this.slot.style.height = `${geom.h}px`;
      this.ghost.style.left = `${geom.x + bounds[drag.from] + (drag.pos - drag.start)}px`;
      this.ghost.style.top = `${geom.y}px`;
      this.ghost.style.width = `${size}px`;
      this.ghost.style.height = `${geom.h}px`;
    } else {
      this.slot.style.left = `${geom.x}px`;
      this.slot.style.top = `${geom.y + targetStart}px`;
      this.slot.style.width = `${geom.w}px`;
      this.slot.style.height = `${size}px`;
      this.ghost.style.left = `${geom.x}px`;
      this.ghost.style.top = `${geom.y + bounds[drag.from] + (drag.pos - drag.start)}px`;
      this.ghost.style.width = `${geom.w}px`;
      this.ghost.style.height = `${size}px`;
    }
    this.slot.classList.add("is-visible");
    this.ghost.classList.add("is-visible");
  }

  // ---------------------------------------------------------------------------
  // 命中测试
  // ---------------------------------------------------------------------------

  private toLocal(event: PointerEvent) {
    const rect = this.overlay.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private frameNear(point: { x: number; y: number }): Frame | null {
    for (const frame of this.frames.values()) {
      const geom = frame.geom;
      if (!geom) continue;
      const inside =
        point.x >= geom.x - GAP - BAR - EDGE &&
        point.x <= geom.x + geom.w + EDGE &&
        point.y >= geom.y - GAP - BAR - EDGE &&
        point.y <= geom.y + geom.h + EDGE;
      if (inside) return frame;
    }
    return null;
  }

  /** 引脚是条上的小圆：命中区 16×16，圆心落在行/列边界上 */
  private hitPin(geom: Geom, point: { x: number; y: number }): PinHover | null {
    const half = PIN / 2;
    const pins: Array<PinHover & { x: number; y: number }> = [
      ...geom.cols.map((boundary, index) => ({
        axis: "col" as Axis,
        index,
        x: geom.x + boundary,
        y: geom.y - GAP - BAR / 2,
      })),
      ...geom.rows.map((boundary, index) => ({
        axis: "row" as Axis,
        index,
        x: geom.x - GAP - BAR / 2,
        y: geom.y + boundary,
      })),
    ];
    for (const pin of pins) {
      if (Math.abs(point.x - pin.x) <= half && Math.abs(point.y - pin.y) <= half) {
        return { axis: pin.axis, index: pin.index };
      }
    }
    return null;
  }

  private hitColBar(geom: Geom, point: { x: number; y: number }): number {
    if (point.y < geom.y - GAP - BAR || point.y > geom.y - GAP) return -1;
    for (let i = 0; i < geom.cols.length - 1; i++) {
      if (point.x >= geom.x + geom.cols[i] && point.x <= geom.x + geom.cols[i + 1]) return i;
    }
    return -1;
  }

  private hitRowBar(geom: Geom, point: { x: number; y: number }): number {
    if (point.x < geom.x - GAP - BAR || point.x > geom.x - GAP) return -1;
    for (let i = 0; i < geom.rows.length - 1; i++) {
      if (point.y >= geom.y + geom.rows[i] && point.y <= geom.y + geom.rows[i + 1]) return i;
    }
    return -1;
  }

  // ---------------------------------------------------------------------------
  // 选中与结构操作
  // ---------------------------------------------------------------------------

  private select(frame: Frame, axis: Axis, index: number) {
    this.selection = { frame, axis, index };
    this.active = frame;
    this.renderActive();
    this.renderSelection();
  }

  private clearSelection() {
    this.selection = null;
    this.highlight.classList.remove("is-visible");
    this.toolbar.classList.remove("is-visible");
    for (const frame of this.frames.values()) frame.root.classList.remove("is-selected");
  }

  private insertLine(frame: Frame, axis: Axis, index: number) {
    const model = readTable(frame.table);
    if (model.rows.length === 0) return;
    this.clearSelection();
    if (axis === "col") {
      for (const row of model.rows) row.splice(index, 0, " ");
      model.aligns.splice(index, 0, null);
    } else {
      model.rows.splice(index, 0, model.rows[0].map(() => " "));
    }
    this.applyTable(frame.table, model, axis, index);
  }

  private deleteLine(frame: Frame, axis: Axis, index: number) {
    const model = readTable(frame.table);
    if (model.rows.length === 0) return;
    if (axis === "col" && model.rows[0].length <= 1) return;
    if (axis === "row" && model.rows.length <= 1) return;
    this.clearSelection();
    if (axis === "col") {
      for (const row of model.rows) row.splice(index, 1);
      model.aligns.splice(index, 1);
    } else {
      model.rows.splice(index, 1);
    }
    this.applyTable(frame.table, model, axis, index);
  }

  private moveLine(frame: Frame, axis: Axis, from: number, to: number) {
    const model = readTable(frame.table);
    if (model.rows.length === 0 || from === to) return;
    this.clearSelection();
    if (axis === "col") {
      for (const row of model.rows) {
        const [moved] = row.splice(from, 1);
        row.splice(to, 0, moved);
      }
      const [align] = model.aligns.splice(from, 1);
      model.aligns.splice(to, 0, align);
    } else {
      if (from < 1 || to < 1) return;
      const [moved] = model.rows.splice(from, 1);
      model.rows.splice(to, 0, moved);
    }
    this.applyTable(frame.table, model, axis, to);
  }

  private applyTable(table: HTMLTableElement, model: TableModel, axis: Axis, index: number) {
    writeTable(table, model);
    // 光标落到改动处旁边的单元格：让 Vditor 的 input 管线有合法 range 重新规范化整块
    const row = axis === "col" ? 0 : Math.min(index, model.rows.length - 1);
    const col = axis === "col" ? Math.min(index, model.rows[0].length - 1) : 0;
    const cell = table.rows[row]?.cells[col];
    this.commit(cell ?? table);
  }

  /**
   * 让 Vditor 重新规范化表格块：与用户输入一致地走 input 管线，
   * 顺带入撤销栈并触发 onCommit 回写标签内容。
   *
   * 光标必须落在单元格内容的**起点**：Vditor 的 input 处理在光标前全是空白
   * （例如空单元格 ` ` 的末尾）时会直接提前返回，既不重排块也不压撤销栈。
   */
  private commit(anchor: HTMLElement) {
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(anchor);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    this.opts.scroller.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );
    this.opts.onCommit();
  }
}
