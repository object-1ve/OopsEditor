/**
 * 斜杠指令表（即时渲染 / 源码编辑共用）。
 *
 * 参考 ArcMD 的「/」菜单：基础一栏是块类型（标题、列表、代码块…），
 * 常用一栏是带图标的长条指令。指令落点都是标准 Markdown——
 * 块级指令交给 Vditor 的 insertMD 走 Lute 渲染，行首指令按前缀文本插入。
 */
export type SlashGroup = "基础" | "常用";

export interface SlashCommand {
  id: string;
  label: string;
  /** 过滤词：label 之外还认这些（英文名、别名） */
  keys: string;
  group: SlashGroup;
  /** 行首文本前缀（标题、列表、引用…），插入后由 Vditor 自行成形 */
  prefix?: string;
  /** 整块 Markdown（代码块、表格、高亮块…），交给 Vditor insertMD */
  markdown?: string;
  /** 图标配色（CSS class 后缀）：不填用中性色 */
  tone?: "accent" | "warm" | "sage" | "rose";
  /** 文字芯片图标（标题的 H1…H6） */
  chip?: string;
  /** 线性图标 */
  icon?: string;
}

const ICON = {
  bullet:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="3.2" cy="4.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="3.2" cy="11.5" r="1.1" fill="currentColor" stroke="none"/><path d="M6.5 4.5h7M6.5 11.5h7"/></svg>',
  ordered:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6.5 4.5h7M6.5 11.5h7"/><path d="M2.4 3.4h1v2.2M2.2 11.3c0-.9 1.5-1 1.5 0 0 .6-1.5 1-1.5 1.7h1.6" stroke-width="1.2"/></svg>',
  task:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="1.6" y="2.6" width="4" height="4" rx="1"/><rect x="1.6" y="9.4" width="4" height="4" rx="1"/><path d="M8 4.6h6.4M8 11.4h6.4"/></svg>',
  code:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.6 5.2 2.8 8l2.8 2.8M10.4 5.2 13.2 8l-2.8 2.8"/></svg>',
  quote:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3.4v9.2"/><path d="M6.4 5h7M6.4 8h7M6.4 11h4.6"/></svg>',
  divider:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 8h12"/></svg>',
  bulb:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8a4.1 4.1 0 0 0-2.4 7.4c.5.4.7.9.7 1.4h3.4c0-.5.2-1 .7-1.4A4.1 4.1 0 0 0 8 1.8Z"/><path d="M6.5 13.1h3"/></svg>',
  image:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><circle cx="5.6" cy="6.4" r="1.1"/><path d="m2.6 11.6 3.3-3 2.6 2.3 2.2-1.9 2.9 2.6"/></svg>',
  table:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="1.8" y="3" width="12.4" height="10" rx="1.6"/><path d="M1.8 6.4h12.4M6 6.4V13M10.4 6.4V13"/></svg>',
  link:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 9.4 9.4 6.6"/><path d="M8.6 4.1 9.9 2.8a2.6 2.6 0 0 1 3.7 3.7l-1.3 1.3M7.4 11.9l-1.3 1.3a2.6 2.6 0 0 1-3.7-3.7l1.3-1.3"/></svg>',
  sigma:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8H4.6L8 8l-3.4 5.2H12"/></svg>',
  fold:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3.2 8 7l4-3.8M4 12.8 8 9l4 3.8"/></svg>',
} as const;

const HEADINGS: SlashCommand[] = [1, 2, 3, 4, 5].map((level) => ({
  id: `h${level}`,
  label: `标题${level}`,
  keys: `h${level} heading 标题 ${level}`,
  group: "基础",
  chip: `H${level}`,
  prefix: `${"#".repeat(level)} `,
}));

export const SLASH_COMMANDS: SlashCommand[] = [
  ...HEADINGS,
  {
    id: "ul",
    label: "无序列表",
    keys: "ul bullet list 无序 列表",
    group: "基础",
    icon: ICON.bullet,
    prefix: "- ",
  },
  {
    id: "ol",
    label: "有序列表",
    keys: "ol ordered list 有序 编号",
    group: "基础",
    icon: ICON.ordered,
    prefix: "1. ",
  },
  {
    id: "task",
    label: "任务列表",
    keys: "task todo checkbox 任务 待办",
    group: "基础",
    icon: ICON.task,
    prefix: "- [ ] ",
  },
  {
    id: "code",
    label: "代码块",
    keys: "code fence 代码 代码块",
    group: "基础",
    icon: ICON.code,
    tone: "sage",
    markdown: "```ts\n\n```",
  },
  {
    id: "quote",
    label: "引用",
    keys: "quote blockquote 引用",
    group: "基础",
    icon: ICON.quote,
    prefix: "> ",
  },
  {
    id: "hr",
    label: "分割线",
    keys: "hr divider rule 分割线 分隔",
    group: "基础",
    icon: ICON.divider,
    markdown: "---\n",
  },
  {
    id: "callout",
    label: "高亮块",
    keys: "callout note tip 高亮块 提示 注意",
    group: "常用",
    icon: ICON.bulb,
    tone: "warm",
    markdown: "> [!NOTE]\n> \n",
  },
  {
    id: "image",
    label: "图片",
    keys: "image img picture 图片 照片",
    group: "常用",
    icon: ICON.image,
    tone: "warm",
    markdown: "![描述](路径)",
  },
  {
    id: "table",
    label: "表格",
    keys: "table 表格",
    group: "常用",
    icon: ICON.table,
    tone: "sage",
    markdown: "| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |",
  },
  {
    id: "link",
    label: "链接",
    keys: "link url a 链接 网址",
    group: "常用",
    icon: ICON.link,
    markdown: "[文本](https://)",
  },
  {
    id: "math",
    label: "公式",
    keys: "math latex formula 公式",
    group: "常用",
    icon: ICON.sigma,
    tone: "rose",
    markdown: "$$\n\n$$",
  },
  {
    id: "details",
    label: "折叠块",
    keys: "details fold collapse 折叠",
    group: "常用",
    icon: ICON.fold,
    markdown: "<details>\n<summary>标题</summary>\n\n内容\n\n</details>",
  },
];

/** 过滤：label / keys 都算命中，全部小写比较 */
export function filterSlashCommands(query: string): SlashCommand[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((command) =>
    `${command.label} ${command.keys}`.toLowerCase().includes(keyword),
  );
}
