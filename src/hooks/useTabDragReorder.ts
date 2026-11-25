import { useCallback, useState } from "react";
import { useEditorStore, type EditorPane } from "@/store/editor";

export interface TabDropHint {
  /** 被悬停的目标标签 */
  tabId: string;
  /** true 表示落点在目标右半边（插到其后） */
  placeAfter: boolean;
}

/**
 * 顶部标签栏的左右拖拽排序：拖拽源只记录 id，落点按目标标签左右半区决定插入位置，
 * 真正的顺序调整交给 store 的 moveTabInPane。
 */
export function useTabDragReorder(pane: EditorPane) {
  const moveTabInPane = useEditorStore((s) => s.moveTabInPane);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [hint, setHint] = useState<TabDropHint | null>(null);

  const onDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    setDraggingTabId(tabId);
    e.dataTransfer.effectAllowed = "move";
    // 部分 WebView 不设置数据就不会进入拖拽状态
    e.dataTransfer.setData("text/plain", tabId);
  }, []);

  const onDragOver = useCallback(
    (e: React.DragEvent, tabId: string) => {
      if (!draggingTabId || draggingTabId === tabId) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      const placeAfter = e.clientX > rect.left + rect.width / 2;
      setHint((prev) =>
        prev && prev.tabId === tabId && prev.placeAfter === placeAfter
          ? prev
          : { tabId, placeAfter },
      );
    },
    [draggingTabId],
  );

  const onDrop = useCallback(
    (e: React.DragEvent, tabId: string) => {
      e.preventDefault();
      e.stopPropagation();
      const from = draggingTabId;
      const target = hint;
      setDraggingTabId(null);
      setHint(null);
      if (!from || from === tabId) return;
      moveTabInPane(pane, from, tabId, target?.tabId === tabId ? target.placeAfter : false);
    },
    [draggingTabId, hint, moveTabInPane, pane],
  );

  const onDragEnd = useCallback(() => {
    setDraggingTabId(null);
    setHint(null);
  }, []);

  const clearHint = useCallback((tabId: string) => {
    setHint((prev) => (prev && prev.tabId === tabId ? null : prev));
  }, []);

  return { draggingTabId, hint, onDragStart, onDragOver, onDrop, onDragEnd, clearHint };
}
