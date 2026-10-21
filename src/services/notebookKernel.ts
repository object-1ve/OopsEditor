/**
 * Notebook Python 内核的命令封装。
 *
 * 每个 Notebook 标签对应一个常驻 Python 进程（Rust 侧管理），变量跨单元格保留；
 * 协议细节见 `src-tauri/python/notebook_kernel.py`。这里只做类型化调用。
 */
import { invoke } from "@tauri-apps/api/core";

export interface NotebookKernelInfo {
  executable: string;
  version: string;
}

export interface NotebookKernelFailure {
  ename: string;
  evalue: string;
  traceback: string;
}

export interface NotebookCellRunResult {
  stdout: string;
  stderr: string;
  /** 最后一行的表达式回显（repr），没有则为 null */
  result: string | null;
  error: NotebookKernelFailure | null;
}

/** 启动（或复用）内核；cwd 为 Notebook 所在目录，与 Jupyter 一致 */
export function startNotebookKernel(key: string, cwd?: string) {
  return invoke<NotebookKernelInfo>("notebook_kernel_start", {
    key,
    cwd: cwd ?? null,
  });
}

export function executeNotebookCell(key: string, code: string, timeoutMs?: number) {
  return invoke<NotebookCellRunResult>("notebook_kernel_run", {
    key,
    code,
    timeoutMs: timeoutMs ?? null,
  });
}

/** 终止内核（中断正在执行的单元格） */
export function stopNotebookKernel(key: string) {
  return invoke<void>("notebook_kernel_stop", { key });
}
