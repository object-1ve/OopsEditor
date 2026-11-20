/**
 * 把 Vditor 运行时按需加载的静态资源复制到 public/vditor。
 *
 * Vditor 初始化时通过 `<script src="{cdn}/dist/js/...">` 动态加载 Lute（Markdown 解析器）、
 * 语言包、图标、代码高亮与公式排版，默认地址是 unpkg CDN；桌面端必须改用本地资源。
 * 组件里把 `options.cdn` 设为 "/vditor"，这里负责把那份目录补齐。
 *
 * 只复制实际用到的部分（约 6MB），不整份搬 22MB 的 dist。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fromVditor = (...parts) => path.join(root, "node_modules", "vditor", "dist", ...parts);
const toPublic = (...parts) => path.join(root, "public", "vditor", "dist", ...parts);

/** [源文件, 目标文件] 清单 */
const FILES = [
  // Lute：Markdown ⇄ HTML 的编译器，IR 模式的核心
  [fromVditor("js", "lute", "lute.min.js"), toPublic("js", "lute", "lute.min.js")],
  // 界面语言包（默认 zh_CN，保留 en_US 以便切换）
  [fromVditor("js", "i18n", "zh_CN.js"), toPublic("js", "i18n", "zh_CN.js")],
  [fromVditor("js", "i18n", "en_US.js"), toPublic("js", "i18n", "en_US.js")],
  // 工具栏图标
  [fromVditor("js", "icons", "ant.js"), toPublic("js", "icons", "ant.js")],
  // 代码块高亮 + 样式
  [fromVditor("js", "highlight.js", "highlight.min.js"), toPublic("js", "highlight.js", "highlight.min.js")],
  // 额外语言包（Vditor 初始化时会一并加载）
  [fromVditor("js", "highlight.js", "third-languages.js"), toPublic("js", "highlight.js", "third-languages.js")],
  [fromVditor("js", "highlight.js", "styles", "github.min.css"), toPublic("js", "highlight.js", "styles", "github.min.css")],
  // 内容主题（options.theme.current 默认 light）
  [fromVditor("css", "content-theme", "light.css"), toPublic("css", "content-theme", "light.css")],
  [fromVditor("css", "content-theme", "dark.css"), toPublic("css", "content-theme", "dark.css")],
];

/** [源目录, 目标目录] 清单：整目录递归复制 */
const DIRS = [
  // KaTeX：行内 / 块级公式（含字体）
  [fromVditor("js", "katex"), toPublic("js", "katex")],
];

let copied = 0;
let missing = 0;
for (const [source, target] of FILES) {
  if (!fs.existsSync(source)) {
    console.warn(`[vditor-assets] 跳过（源文件不存在）：${path.relative(root, source)}`);
    missing += 1;
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  copied += 1;
}
for (const [source, target] of DIRS) {
  if (!fs.existsSync(source)) {
    console.warn(`[vditor-assets] 跳过（源目录不存在）：${path.relative(root, source)}`);
    missing += 1;
    continue;
  }
  fs.cpSync(source, target, { recursive: true });
  copied += 1;
}
console.log(
  `[vditor-assets] 已复制 ${copied} 项资源到 public/vditor${missing ? `，${missing} 项缺失` : ""}`,
);
