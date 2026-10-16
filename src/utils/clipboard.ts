/**
 * 剪贴板工具函数
 *
 * 程序内发起的复制统一走 {@link copyTextToClipboard}：成功/失败都在右下角弹提示，
 * 保证「每次复制都有反馈」。浏览器原生发起的复制（Monaco 编辑器 Ctrl+C、
 * 终端选中复制等）不会经过这里，由 `useCopyFeedback` 的全局 copy 监听兜底。
 */
import { useEditorStore } from "@/store/editor";

/** 复制成功的默认提示文案 */
export const COPIED_MESSAGE = "已复制到剪贴板";

/** 复制失败提示：与粘贴失败文案保持同一口径（多为剪贴板权限/安全上下文问题） */
const COPY_FAILED_MESSAGE = "复制失败，请检查剪贴板权限";

/**
 * 写入系统剪贴板，并统一在右下角提示结果。
 *
 * @param text 要写入剪贴板的文本
 * @param successMessage 成功提示文案，默认「已复制到剪贴板」
 * @returns 是否写入成功
 */
export async function copyTextToClipboard(
  text: string,
  successMessage: string = COPIED_MESSAGE,
): Promise<boolean> {
  const { showNotification } = useEditorStore.getState();
  try {
    await navigator.clipboard.writeText(text);
    showNotification(successMessage, "success");
    return true;
  } catch (err) {
    console.error("写入剪贴板失败:", err);
    showNotification(COPY_FAILED_MESSAGE, "error");
    return false;
  }
}
