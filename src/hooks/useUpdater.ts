import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";
import { useEditorStore } from "@/store/editor";
import { version as APP_VERSION } from "../../package.json";

export type UpdaterStage = "idle" | "available" | "downloading" | "ready";

export interface UpdaterDialogState {
  stage: UpdaterStage;
  version: string;
  body: string;
  /** 0-100 */
  progress: number;
  checking: boolean;
}

const initialState: UpdaterDialogState = {
  stage: "idle",
  version: "",
  body: "",
  progress: 0,
  checking: false,
};

let state: UpdaterDialogState = initialState;
let pendingUpdate: Update | null = null;
/** 自动检查只做一次（手动检查不受限制） */
let checkedOnce = false;

const listeners = new Set<() => void>();

function emit(next: Partial<UpdaterDialogState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): UpdaterDialogState {
  return state;
}

/**
 * 检查更新。自动检查（manual=false）只生效一次，失败静默只打日志；
 * 手动检查每次都跑，必须给用户反馈。
 */
export async function checkForUpdates(opts: { manual: boolean }): Promise<void> {
  const { manual } = opts;
  if (state.checking) return;
  if (!manual) {
    if (checkedOnce) return;
    checkedOnce = true;
  }
  emit({ checking: true });
  try {
    const update = await check();
    if (!update) {
      if (manual) {
        useEditorStore.getState().showNotification(`已是最新版本（v${APP_VERSION}）`, "success");
      }
      return;
    }
    await pendingUpdate?.close().catch(() => undefined);
    pendingUpdate = update;
    emit({ stage: "available", version: update.version, body: update.body ?? "", progress: 0 });
  } catch (err) {
    const msg = String(err);
    const unsupported =
      msg.includes("__TAURI") ||
      msg.includes("Command not found") ||
      msg.includes("not allowed") ||
      msg.includes("is not a function");
    if (manual) {
      useEditorStore.getState().showNotification(
        unsupported ? "当前环境不支持自动更新，请使用安装包升级" : `检查更新失败：${msg}`,
        "error",
      );
    } else {
      console.warn("[updater] 自动检查更新失败:", err);
    }
  } finally {
    emit({ checking: false });
  }
}

/** 用户在更新框点确认后才下载安装；done 后退出应用，由安装器接管。 */
export async function confirmUpdate(): Promise<void> {
  const update = pendingUpdate;
  if (!update || state.stage !== "available") return;
  emit({ stage: "downloading", progress: 0 });
  let downloaded = 0;
  let total = 0;
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
        downloaded = 0;
        emit({ progress: 0 });
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        emit({ progress: total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0 });
      } else if (event.event === "Finished") {
        emit({ progress: 100, stage: "ready" });
      }
    });
    try {
      await invoke("exit_app");
    } catch (err) {
      // Windows 下安装器会直接接管并退出进程，走到这里说明还在运行
      console.warn("[updater] exit_app 未生效:", err);
      emit({ stage: "idle" });
    }
  } catch (err) {
    console.error("[updater] 下载安装失败:", err);
    useEditorStore.getState().showNotification(`更新失败：${String(err)}`, "error");
    emit({ stage: "idle", progress: 0 });
  } finally {
    await update.close().catch(() => undefined);
    if (pendingUpdate === update) pendingUpdate = null;
  }
}

export function dismissUpdate(): void {
  if (state.stage === "downloading") return;
  emit({ stage: "idle", version: "", body: "", progress: 0 });
}

export function useUpdaterDialog(): UpdaterDialogState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
