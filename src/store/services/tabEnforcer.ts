/**
 * Tab enforcement: limit open tabs
 */
import type { FileTab } from "@/types";
import { sanitizeMaxOpenTabs } from "@/utils/settings";

export function enforceTabLimit(
  tabs: FileTab[],
  activeTabId: string | null,
  maxOpenTabs: number,
) {
  const sanitizedMaxOpenTabs = sanitizeMaxOpenTabs(maxOpenTabs);
  const nextTabs = [...tabs];
  const closedTabs: FileTab[] = [];

  while (nextTabs.length > sanitizedMaxOpenTabs) {
    const firstCleanTabIndex = nextTabs.findIndex((tab) => !tab.isDirty);
    if (firstCleanTabIndex === -1) {
      break;
    }

    const [closedTab] = nextTabs.splice(firstCleanTabIndex, 1);
    if (closedTab) {
      closedTabs.push(closedTab);
    }
  }

  let nextActiveTabId = activeTabId;
  if (nextActiveTabId && !nextTabs.some((tab) => tab.id === nextActiveTabId)) {
    nextActiveTabId = nextTabs[nextTabs.length - 1]?.id ?? null;
  }

  return {
    tabs: nextTabs,
    activeTabId: nextActiveTabId,
    openFiles: nextTabs.map((tab) => tab.path),
    closedTabs,
  };
}

export function formatAutoClosedTabsMessage(closedTabs: FileTab[]) {
  if (closedTabs.length === 0) {
    return "";
  }

  const previewNames = closedTabs
    .slice(0, 2)
    .map((tab) => tab.name)
    .join("、");

  if (closedTabs.length === 1) {
    return `已自动关闭未修改标签：${previewNames}`;
  }

  const remainingCount = closedTabs.length - 2;
  const suffix = remainingCount > 0
    ? ` 等 ${closedTabs.length} 个标签`
    : ` 共 ${closedTabs.length} 个标签`;
  return `已自动关闭未修改标签：${previewNames}${suffix}`;
}
