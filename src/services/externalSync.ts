/**
 * externalSync - 检测并同步外部文件修改
 *
 * 定期轮询当前打开标签的文件修改时间（get_file_info 的 modified_at），
 * 与已知 mtime 对比；发生变化时：
 *   - 标签无未保存改动 → 自动从磁盘重新加载
 *   - 标签有未保存改动 → 提示用户，保留本地内容（避免丢失）
 * 应用自身保存后也会刷新已知 mtime，避免把自身的保存误判为外部修改。
 */
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "@/store/editor";
import {
  getFileMtime,
  setFileMtime,
  clearFileMtime,
  fetchAndSetFileMtime,
} from "@/store/fileMtime";
import { normalizePath } from "@/utils/path";
import type { FileTab } from "@/types";
import type { EditorState } from "@/store/types";

const POLL_INTERVAL_MS = 1500;

let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
let lastOpenPaths = new Set<string>();

function isTabVisible(state: EditorState, tabId: string): boolean {
  return (
    state.activeTabId === tabId ||
    (state.isSplit && state.secondaryActiveTabId === tabId)
  );
}

/** 清理已关闭标签的 mtime 记录，并为新打开的标签记录当前 mtime（不触发重新加载） */
function syncWatchedPaths() {
  const state = useEditorStore.getState();
  const paths = new Set(
    [...state.tabs, ...state.secondaryTabs]
      .map((t) => normalizePath(t.path))
      .filter(Boolean),
  );

  for (const path of paths) {
    if (!lastOpenPaths.has(path) && getFileMtime(path) === undefined) {
      void fetchAndSetFileMtime(path);
    }
  }
  for (const path of lastOpenPaths) {
    if (!paths.has(path)) clearFileMtime(path);
  }
  lastOpenPaths = paths;
}

async function handleTab(tab: FileTab) {
  const path = normalizePath(tab.path);
  if (!path) return;

  let current: number;
  try {
    const info = await invoke<{ modified_at: number }>("get_file_info", {
      path: tab.path,
    });
    current = info.modified_at;
  } catch {
    // 文件被外部删除/移动
    if (getFileMtime(path) !== undefined) {
      clearFileMtime(path);
      useEditorStore
        .getState()
        .showNotification(`文件已被外部删除或移动: ${tab.name}`, "error");
    }
    return;
  }

  const known = getFileMtime(path);
  if (known !== undefined && known === current) return;
  setFileMtime(path, current);

  const state = useEditorStore.getState();
  if (tab.isDirty) {
    state.showNotification(
      `"${tab.name}" 已在外部被修改，本地存在未保存更改，已保留本地内容`,
      "info",
    );
    return;
  }

  await state.reloadTab(tab.id);
  if (isTabVisible(useEditorStore.getState(), tab.id)) {
    useEditorStore
      .getState()
      .showNotification(`"${tab.name}" 检测到外部修改，已重新加载`, "info");
  }
}

function pollOnce() {
  const state = useEditorStore.getState();
  const seen = new Set<string>();
  for (const tab of state.tabs) {
    if (seen.has(tab.id)) continue;
    seen.add(tab.id);
    void handleTab(tab);
  }
  if (state.isSplit) {
    for (const tab of state.secondaryTabs) {
      if (seen.has(tab.id)) continue;
      seen.add(tab.id);
      void handleTab(tab);
    }
  }
}

export function startExternalSync() {
  if (timer !== null) return;

  syncWatchedPaths();
  unsubscribe = useEditorStore.subscribe(syncWatchedPaths);
  timer = setInterval(pollOnce, POLL_INTERVAL_MS);

  // 窗口重新获得焦点时立即检查一次，提高外部编辑后的响应速度
  window.addEventListener("focus", pollOnce);
}

export function stopExternalSync() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  unsubscribe?.();
  unsubscribe = null;
  window.removeEventListener("focus", pollOnce);
  lastOpenPaths = new Set();
}