/**
 * markdownSnippets - "@" 触发的 Markdown 结构片段补全
 *
 * 在 markdown 编辑器中输入 @ 呼出片段菜单（标题/代码块/表格/引用等），
 * 采纳后按 Monaco snippet 语法插入，支持 Tab 在占位符间跳转。
 */
import { languages, type IRange } from "monaco-editor";

interface MdSnippet {
  /** 菜单显示名（@ 前缀） */
  label: string;
  /** 简要说明 */
  detail: string;
  /** 额外过滤词，输入 @ 后继续打字可模糊匹配 */
  filter: string;
  /** Monaco snippet 语法插入文本 */
  insert: string;
  /** 文档面板展示 */
  doc: string;
}

const SNIPPETS: MdSnippet[] = [
  {
    label: "标题1",
    detail: "一级标题",
    filter: "h1 heading",
    insert: "# ${1:一级标题}$0",
    doc: "# 一级标题",
  },
  {
    label: "标题2",
    detail: "二级标题",
    filter: "h2 heading",
    insert: "## ${1:二级标题}$0",
    doc: "## 二级标题",
  },
  {
    label: "标题3",
    detail: "三级标题",
    filter: "h3 heading",
    insert: "### ${1:三级标题}$0",
    doc: "### 三级标题",
  },
  {
    label: "标题4",
    detail: "四级标题",
    filter: "h4 heading",
    insert: "#### ${1:四级标题}$0",
    doc: "#### 四级标题",
  },
  {
    label: "代码块",
    detail: "围栏代码块（可指定语言）",
    filter: "code codeblock fence",
    insert: "```${1:ts}\n$0\n```",
    doc: "```\n代码块\n```",
  },
  {
    label: "行内代码",
    detail: "行内代码",
    filter: "inline code",
    insert: "`${1:代码}`$0",
    doc: "`行内代码`",
  },
  {
    label: "表格",
    detail: "三列 GFM 表格",
    filter: "table gfm",
    insert: "| ${1:列1} | ${2:列2} | ${3:列3} |\n| --- | --- | --- |\n| $0 |  |  |",
    doc: "| 列1 | 列2 | 列3 |\n| --- | --- | --- |",
  },
  {
    label: "引用",
    detail: "引用块",
    filter: "quote blockquote",
    insert: "> ${1:引用内容}$0",
    doc: "> 引用内容",
  },
  {
    label: "任务列表",
    detail: "GFM 任务复选框",
    filter: "todo task checkbox",
    insert: "- [ ] ${1:任务}$0",
    doc: "- [ ] 任务",
  },
  {
    label: "无序列表",
    detail: "无序列表项",
    filter: "ul list bullet",
    insert: "- ${1:内容}$0",
    doc: "- 内容",
  },
  {
    label: "有序列表",
    detail: "有序列表项",
    filter: "ol list ordered",
    insert: "1. ${1:内容}$0",
    doc: "1. 内容",
  },
  {
    label: "链接",
    detail: "超链接",
    filter: "link url a",
    insert: "[${1:文本}](${2:https://})$0",
    doc: "[文本](https://)",
  },
  {
    label: "图片",
    detail: "图片",
    filter: "image img picture",
    insert: "![${1:描述}](${2:路径})$0",
    doc: "![描述](路径)",
  },
  {
    label: "分割线",
    detail: "水平分割线",
    filter: "hr divider rule",
    insert: "\n---\n$0",
    doc: "---",
  },
  {
    label: "加粗",
    detail: "粗体文本",
    filter: "bold strong",
    insert: "**${1:文本}**$0",
    doc: "**文本**",
  },
  {
    label: "斜体",
    detail: "斜体文本",
    filter: "italic em",
    insert: "*${1:文本}*$0",
    doc: "*文本*",
  },
  {
    label: "删除线",
    detail: "GFM 删除线",
    filter: "strikethrough del",
    insert: "~~${1:文本}~~$0",
    doc: "~~文本~~",
  },
  {
    label: "折叠块",
    detail: "可折叠 details 区块",
    filter: "details collapse fold",
    insert: "<details>\n<summary>${1:标题}</summary>\n\n$0\n\n</details>",
    doc: "<details><summary>标题</summary>…</details>",
  },
];

/**
 * 为 markdown 语言注册 @ 触发的片段补全。
 * Monaco provider 按语言全局注册（分屏多实例共享），引用计数控制生命周期。
 */
export interface MarkdownSnippetsHandle {
  release(): void;
}

export function registerMarkdownSnippets(): MarkdownSnippetsHandle {
  let provider: { dispose(): void } | null = null;
  let refCount = 0;

  const ensureProvider = () => {
    if (provider) return;
    provider = languages.registerCompletionItemProvider("markdown", {
      triggerCharacters: ["@"],
      provideCompletionItems(model, position): languages.CompletionList {
        const lineContent = model.getLineContent(position.lineNumber);
        const before = lineContent.slice(0, position.column - 1);
        // 仅当光标前是 @（可带已输入的过滤字符）时呼出；替换范围包含 @ 本身
        const trigger = before.match(/@([\p{L}\d_-]*)$/u);
        if (!trigger) {
          return { suggestions: [] };
        }
        const range: IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column - trigger[0].length,
          endColumn: position.column,
        };
        return {
          suggestions: SNIPPETS.map((s, i): languages.CompletionItem => ({
            label: `@${s.label}`,
            kind: languages.CompletionItemKind.Snippet,
            detail: s.detail,
            documentation: { value: s.doc },
            insertText: s.insert,
            insertTextRules: languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            filterText: `@${s.label} ${s.filter}`,
            sortText: String(i).padStart(2, "0"),
          })),
        };
      },
    });
  };

  refCount += 1;
  ensureProvider();

  return {
    release() {
      refCount -= 1;
      if (refCount === 0 && provider) {
        provider.dispose();
        provider = null;
      }
    },
  };
}
