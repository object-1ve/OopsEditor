/**
 * 程序内发起确认的统一入口：把 store 的回调式弹窗包成 Promise。
 *
 * 用于「保存会丢失内容」「公式引用不会自动调整」这类需要按用户选择分支的流程。
 * 说明：lib 目标为 ES2020，且旧 WebKit 没有 Promise.withResolvers，这里自带等价实现。
 */
import { useEditorStore } from "@/store/editor";

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  kind?: "warning" | "danger" | "info";
}

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((res) => {
    resolve = res;
  });

  useEditorStore.getState().showModal({
    title: options.title,
    message: options.message,
    kind: options.kind ?? "warning",
    onConfirm: () => resolve(true),
    onCancel: () => resolve(false),
  });

  return promise;
}
