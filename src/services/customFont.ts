/**
 * 自定义字体：把用户选定的字体文件加载为 FontFace 并接入等宽/界面字体栈。
 *
 * 只**记录字体文件路径**并直接引用，不复制、不读进内存：字体动辄十几 MB，
 * 复制一份既慢又占空间（与本项目对聊天附件「文件只记路径」的口径一致）。
 * asset 协议已开启且 scope 覆盖全盘，其响应带与窗口同源的 Access-Control-Allow-Origin ——
 * 这点是必需的：字体请求必须走 CORS，而图片不受此限制，不能照搬图片的做法。
 *
 * 先 load 成功再落地：FontFace.load() 对坏文件/缺文件会 reject，而往 <style> 里写
 * @font-face 只会「静默失败」。因此这里绝不在加载成功之前改动任何全局状态，
 * 换字体失败时正在生效的字体完全不受影响。
 *
 * 字体变量改在 documentElement 的**内联样式**上，而不是再插一条 `:root` 规则：
 * index.css 与 Tailwind `@theme` 都定义了 --font-mono，再插规则就要和它们比较层级与插入顺序，
 * 内联样式则直接胜出、清除时 removeProperty 即回落到原值，不依赖任何加载顺序。
 *
 * 字体到达后还有两处必须收口：
 * - Monaco 缓存字符宽度（缩进参考线、光标列宽都按它算），字体晚到会让宽度一直按回退字体量，
 *   表现为光标与字符对不齐，必须调 remeasureFonts() 重算；
 * - xterm 用 canvas measureText 量字符尺寸，而 canvas 的 font 不接受 var()，
 *   所以只能给它解析后的字面族名（见 resolveMonoFontFamily）。
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { monaco, monacoReady } from "@/monaco";

const FONT_FAMILY = "OopsEditor Custom Font";
const FONT_EXTENSIONS = ["ttf", "otf", "woff", "woff2"] as const;

/** 字体变化通知：终端需要重新测量字符尺寸 */
type FontChangeListener = () => void;
const listeners = new Set<FontChangeListener>();

/** 当前已加载的字体；null 表示使用内置字体栈 */
let activeFontFace: FontFace | null = null;
/** 被内联样式覆盖前的原始字体栈，用于拼接回退链 */
let originalFontStacks: { sans: string; mono: string } | null = null;

export function subscribeFontChange(listener: FontChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyFontChange() {
  for (const listener of listeners) listener();
}

/** 对话框用的过滤器；与 isSupportedFontFile 的清单保持一致 */
export const FONT_FILE_FILTER = {
  name: "字体文件",
  extensions: [...FONT_EXTENSIONS],
};

/** 是否是我们支持加载的字体文件（按扩展名判断，避免把任意文件塞进字体加载） */
export function isSupportedFontFile(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return (FONT_EXTENSIONS as readonly string[]).includes(extension);
}

/**
 * 取当前生效的等宽字体栈。
 *
 * 从 CSS 变量读而不是在 TS 里再写一份字面量：字体栈只应有唯一事实源（index.css），
 * 否则两边迟早不一致。xterm 要的是字面族名而不是 var()，所以这里读出的是解析后的值。
 */
export function resolveMonoFontFamily(): string {
  const fromCss = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  return fromCss || '"SF Mono", "Cascadia Code", "JetBrains Mono", monospace';
}

/**
 * 移除自定义字体：注销 FontFace 并撤掉内联变量，字体栈回落 index.css 的定义。
 */
export function clearCustomFont() {
  if (activeFontFace) {
    document.fonts.delete(activeFontFace);
    activeFontFace = null;
  }
  const root = document.documentElement;
  root.style.removeProperty("--font-sans");
  root.style.removeProperty("--font-mono");
  originalFontStacks = null;
  notifyFontChange();
}

/**
 * 应用自定义字体。
 *
 * `applyToUi` 为 false 时只改等宽栈（编辑器 / 终端 / 代码块），界面字体保持不变——
 * 等宽 CJK 字体铺满整个界面观感变化很大，默认只作用于代码区域，由开关显式扩大范围。
 *
 * @returns 失败原因；成功时为 null
 */
export async function applyCustomFont(
  path: string,
  applyToUi: boolean,
): Promise<string | null> {
  if (!isSupportedFontFile(path)) {
    return `不支持的字体格式，请选择 ${FONT_EXTENSIONS.join(" / ")} 文件`;
  }

  // FontFace 的 source 走 url() 加引号：encodeURIComponent 不转义 `'` 与 `(`，
  // 不加引号时这类路径会截断声明
  let fontFace: FontFace;
  try {
    fontFace = new FontFace(FONT_FAMILY, `url("${convertFileSrc(path)}")`, {
      display: "swap",
    });
    // 坏文件 / 文件不存在都在这里 reject，此时尚未改动任何全局状态
    await fontFace.load();
  } catch (err) {
    return `字体加载失败: ${String(err)}`;
  }

  // 新字体已确认可用，从这里开始替换旧字体
  if (activeFontFace) {
    document.fonts.delete(activeFontFace);
  }
  activeFontFace = fontFace;
  document.fonts.add(fontFace);

  const root = document.documentElement;
  // 首次应用时记下原始字体栈；之后切换字体都基于同一份原始值，避免回退链层层叠加
  if (!originalFontStacks) {
    const computed = getComputedStyle(root);
    originalFontStacks = {
      sans: computed.getPropertyValue("--font-sans").trim(),
      mono: computed.getPropertyValue("--font-mono").trim(),
    };
  }
  const family = `"${FONT_FAMILY}"`;
  if (applyToUi && originalFontStacks.sans) {
    root.style.setProperty("--font-sans", `${family}, ${originalFontStacks.sans}`);
  } else {
    // 从「界面也换」切回「只换等宽」时要撤掉内联覆盖，否则界面字体不回落
    root.style.removeProperty("--font-sans");
  }
  root.style.setProperty("--font-mono", `${family}, ${originalFontStacks.mono}`);

  await remeasureEditors();
  notifyFontChange();
  return null;
}

/**
 * 字体到位后让 Monaco 重新测量字符宽度。
 * 不打字重算的话，缓存里仍是回退字体的宽度，缩进参考线与光标列会整体偏移。
 * loader.init() 只会执行一次，重复 await 立即返回，所以不必自己缓存。
 */
async function remeasureEditors() {
  try {
    await monacoReady;
    monaco.editor.remeasureFonts();
  } catch {
    // Monaco 尚未初始化（如应用刚启动就设字体）：首次创建编辑器时本来就会量一次
  }
}
