/**
 * Auto-save timer management
 */
import { saveTab } from "@/services/editorSave";

const AUTO_SAVE_DELAY = 1000;
const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function clearAutoSaveTimer(tabId: string) {
  const timer = autoSaveTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    autoSaveTimers.delete(tabId);
  }
}

export function clearAutoSaveTimers(tabIds: string[]) {
  tabIds.forEach(clearAutoSaveTimer);
}

export function getAllAutoSaveKeys(): string[] {
  return [...autoSaveTimers.keys()];
}

export function scheduleAutoSave(
  id: string,
  tab: { name: string; path: string; isDirty: boolean; isReadOnly?: boolean; isPreviewMode?: boolean },
  onMarkClean: (id: string) => void,
) {
  clearAutoSaveTimer(id);
  autoSaveTimers.set(
    id,
    setTimeout(() => {
      autoSaveTimers.delete(id);
      void saveTab(tab as any)
        .then(() => {
          onMarkClean(id);
          window.dispatchEvent(
            new CustomEvent("file-refresh", { detail: { path: tab.path } }),
          );
        })
        .catch((err) => {
          console.error(`自动保存失败 ${tab.name}:`, err);
        });
    }, AUTO_SAVE_DELAY),
  );
}
