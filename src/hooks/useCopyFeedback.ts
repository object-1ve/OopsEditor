/**
 * 全局复制反馈：浏览器原生发起的复制（Monaco 编辑器 Ctrl+C/Ctrl+X、
 * 终端与预览区选中复制、输入框内选中复制等）统一在右下角提示一次。
 *
 * 只处理 DOM `copy` 事件：`navigator.clipboard.writeText` 不会触发该事件，
 * 所以程序内的复制（见 utils/clipboard.ts）不会被重复提示。
 */
import { useEffect } from "react";
import { useEditorStore } from "@/store/editor";
import { COPIED_MESSAGE } from "@/utils/clipboard";

export function useCopyFeedback() {
  useEffect(() => {
    const handleCopy = (event: Event) => {
      const clipboardData = (event as ClipboardEvent).clipboardData;
      // Monaco / xterm 会在自己的 copy 监听里 setData 并 preventDefault，
      // 因此不能只看 defaultPrevented，要按「确实有内容被复制」判断
      const copied = clipboardData?.getData("text/plain") ?? "";
      const selection = window.getSelection()?.toString() ?? "";
      if (!copied && !selection) return;
      useEditorStore.getState().showNotification(COPIED_MESSAGE, "success");
    };

    document.addEventListener("copy", handleCopy);
    return () => document.removeEventListener("copy", handleCopy);
  }, []);
}
