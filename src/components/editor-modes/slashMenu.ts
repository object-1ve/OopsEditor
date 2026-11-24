/**
 * 斜杠指令面板：在即时渲染模式的空段落里输入 `/` 呼出，参考 ArcMD 的分组菜单。
 *
 * 结构固定为「基础」栅格 + 「常用」长条；继续输入按中文名/英文别名过滤。
 * 键盘：↑↓ 选择，Enter/Tab 应用，Esc 收起；点击也能应用（面板不抢焦点）。
 *
 * 应用方式：先清空当前块里的 `/查询` 文本，再按指令类型落 Markdown——
 * 行首类（标题/列表/引用）用输入事件插前缀，让 Vditor 自己成形；
 * 整块类（代码块/表格/高亮块）走 Vditor 的 insertMD，交给 Lute 渲染。
 */
import { filterSlashCommands, type SlashCommand } from "./slashCommands";

export interface SlashMenuOptions {
  /** 编辑区外层容器：面板与定位都以它为坐标系 */
  host: HTMLElement;
  /** IR 内容根 pre.vditor-reset：输入事件源、表格/段落都在里面 */
  scroller: HTMLElement;
  /** Vditor 的 insertMD：整块 Markdown 走 Lute 渲染 */
  insertMarkdown: (markdown: string) => void;
  /** 指令落地后立即回写标签内容 */
  onCommit: () => void;
  isReadOnly: () => boolean;
}

export class SlashMenu {
  private readonly opts: SlashMenuOptions;
  private readonly panel: HTMLDivElement;
  /** 当前触发的块与已输入的查询串 */
  private state: { block: HTMLElement; query: string } | null = null;
  private items: SlashCommand[] = [];
  private itemElements: HTMLButtonElement[] = [];
  private activeIndex = 0;
  /** 上一次渲染用的查询串：查询一变就把高亮拉回第一项 */
  private lastQuery: string | null = null;
  private disabled = false;

  constructor(options: SlashMenuOptions) {
    this.opts = options;
    this.panel = document.createElement("div");
    this.panel.className = "oops-slash-panel";
    this.panel.setAttribute("role", "listbox");
    this.opts.host.append(this.panel);

    this.opts.scroller.addEventListener("input", this.handleInput);
    this.opts.scroller.addEventListener("scroll", this.handleScroll, { passive: true });
    document.addEventListener("keydown", this.handleKeyDown, true);
    document.addEventListener("pointerdown", this.handleOutsideDown, true);
    document.addEventListener("selectionchange", this.handleSelectionChange);
  }

  setDisabled(disabled: boolean) {
    this.disabled = disabled;
    if (disabled) this.close();
  }

  destroy() {
    this.opts.scroller.removeEventListener("input", this.handleInput);
    this.opts.scroller.removeEventListener("scroll", this.handleScroll);
    document.removeEventListener("keydown", this.handleKeyDown, true);
    document.removeEventListener("pointerdown", this.handleOutsideDown, true);
    document.removeEventListener("selectionchange", this.handleSelectionChange);
    this.panel.remove();
    this.close();
  }

  // ---------------------------------------------------------------------------
  // 触发与关闭
  // ---------------------------------------------------------------------------

  /** 光标所在的块（Vditor 的块都带 data-block），且必须落在编辑区里 */
  private blockAtCaret(): HTMLElement | null {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const start = selection.getRangeAt(0).startContainer;
    const element = start instanceof Element ? start : start.parentElement;
    if (!element || !this.opts.scroller.contains(element)) return null;
    return element.closest<HTMLElement>("[data-block]");
  }

  private handleInput = () => {
    if (this.disabled || this.opts.isReadOnly()) return;
    const block = this.blockAtCaret();
    const text = block?.textContent ?? "";
    // 只在空段落里、以 `/` 开头时呼出：标题/列表等块和正文中间的 `/` 都不算
    if (!block || block.tagName !== "P" || !text.startsWith("/") || text.includes("\n")) {
      this.close();
      return;
    }
    this.state = { block, query: text.slice(1) };
    this.render();
  };

  private handleSelectionChange = () => {
    if (!this.state) return;
    const block = this.blockAtCaret();
    if (block !== this.state.block) this.close();
  };

  private handleScroll = () => {
    if (this.state) this.position();
  };

  private handleOutsideDown = (event: PointerEvent) => {
    if (!this.state) return;
    if (event.target instanceof Node && this.panel.contains(event.target)) return;
    this.close();
  };

  private close() {
    if (!this.state && !this.panel.classList.contains("is-visible")) return;
    this.state = null;
    this.lastQuery = null;
    this.items = [];
    this.itemElements = [];
    this.activeIndex = 0;
    this.panel.classList.remove("is-visible");
    this.panel.replaceChildren();
  }

  // ---------------------------------------------------------------------------
  // 键盘
  // ---------------------------------------------------------------------------

  private handleKeyDown = (event: KeyboardEvent) => {
    if (!this.state) return;
    if (event.isComposing) return;
    if (event.key === "Escape") {
      this.swallow(event);
      this.close();
      return;
    }
    if (this.items.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      this.swallow(event);
      const delta = event.key === "ArrowDown" ? 1 : -1;
      this.setActive((this.activeIndex + delta + this.items.length) % this.items.length);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      this.swallow(event);
      this.apply(this.items[this.activeIndex]);
    }
  };

  private swallow(event: KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  private render() {
    const state = this.state;
    if (!state) return;
    this.items = filterSlashCommands(state.query);
    if (state.query !== this.lastQuery) {
      this.activeIndex = 0;
      this.lastQuery = state.query;
    }
    this.activeIndex = Math.min(this.activeIndex, Math.max(0, this.items.length - 1));
    this.itemElements = [];

    const query = state.query.trim();
    this.panel.replaceChildren();
    if (query) {
      this.panel.append(this.renderList(this.items, 0));
    } else {
      const basics = this.items.filter((command) => command.group === "基础");
      const commons = this.items.filter((command) => command.group === "常用");
      this.panel.append(this.sectionLabel("基础"), this.renderGrid(basics, 0));
      this.panel.append(this.sectionLabel("常用"), this.renderList(commons, basics.length));
    }
    if (this.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "oops-slash-empty";
      empty.textContent = "没有匹配的指令";
      this.panel.append(empty);
    }

    if (!this.state) return;
    this.panel.classList.add("is-visible");
    this.setActive(this.activeIndex);
    this.position();
  }

  private sectionLabel(text: string): HTMLDivElement {
    const label = document.createElement("div");
    label.className = "oops-slash-section";
    label.textContent = text;
    return label;
  }

  private renderGrid(commands: SlashCommand[], offset: number): HTMLDivElement {
    const grid = document.createElement("div");
    grid.className = "oops-slash-grid";
    commands.forEach((command, i) => grid.append(this.renderItem(command, offset + i, true)));
    return grid;
  }

  private renderList(commands: SlashCommand[], offset: number): HTMLDivElement {
    const list = document.createElement("div");
    list.className = "oops-slash-list";
    commands.forEach((command, i) => list.append(this.renderItem(command, offset + i, false)));
    return list;
  }

  private renderItem(command: SlashCommand, index: number, compact: boolean): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = compact ? "oops-slash-item is-cell" : "oops-slash-item is-row";
    if (command.tone) item.classList.add(`is-${command.tone}`);
    item.dataset.index = String(index);
    item.title = command.label;
    item.setAttribute("role", "option");

    const icon = document.createElement("span");
    icon.className = command.chip ? "oops-slash-icon is-chip" : "oops-slash-icon";
    icon.innerHTML = command.chip ?? command.icon ?? "";
    item.append(icon);

    if (!compact) {
      const label = document.createElement("span");
      label.className = "oops-slash-label";
      label.textContent = command.label;
      item.append(label);
    }

    item.addEventListener("pointerdown", (event) => {
      // 面板不抢焦点：点一下就直接落地，光标仍在编辑器里
      event.preventDefault();
      event.stopPropagation();
    });
    item.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.apply(command);
    });
    item.addEventListener("pointerenter", () => this.setActive(index));

    this.itemElements[index] = item;
    return item;
  }

  private setActive(index: number) {
    if (this.items.length === 0) return;
    this.activeIndex = index;
    this.itemElements.forEach((element, i) => {
      element?.classList.toggle("is-active", i === index);
      element?.setAttribute("aria-selected", i === index ? "true" : "false");
    });
    const active = this.itemElements[index];
    if (!active) return;
    // 面板自身滚动，别带动整页
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    if (top < this.panel.scrollTop) this.panel.scrollTop = top - 4;
    else if (bottom > this.panel.scrollTop + this.panel.clientHeight) {
      this.panel.scrollTop = bottom - this.panel.clientHeight + 4;
    }
  }

  private position() {
    const state = this.state;
    if (!state || !state.block.isConnected) return;
    const hostRect = this.opts.host.getBoundingClientRect();
    const blockRect = state.block.getBoundingClientRect();
    const width = this.panel.offsetWidth;
    const height = this.panel.offsetHeight;
    const maxLeft = Math.max(8, hostRect.width - width - 8);
    let left = Math.min(Math.max(8, blockRect.left - hostRect.left), maxLeft);
    // 默认贴在块下方；下方放不下就翻到块上方
    let top = blockRect.bottom - hostRect.top + 6;
    if (top + height > hostRect.height - 8) {
      top = Math.max(8, blockRect.top - hostRect.top - height - 6);
    }
    this.panel.style.left = `${left}px`;
    this.panel.style.top = `${top}px`;
  }

  // ---------------------------------------------------------------------------
  // 应用
  // ---------------------------------------------------------------------------

  private apply(command: SlashCommand | undefined) {
    if (!command) return;
    const block = this.state?.block;
    this.close();
    if (!block || !block.isConnected) return;

    // 清掉触发用的 `/查询`：整块内容就是它，直接全选删除
    const selection = document.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(block);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("delete");
    }

    if (command.markdown !== undefined) this.opts.insertMarkdown(command.markdown);
    else if (command.prefix) document.execCommand("insertText", false, command.prefix);
    this.opts.onCommit();
  }
}
