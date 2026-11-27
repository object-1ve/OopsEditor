import { useCallback, useEffect, useRef, useState } from "react";
import { useEditorStore, type EditorPane } from "@/store/editor";

export interface TabDropHint {
  /** 被悬停的目标标签 */
  tabId: string;
  /** true 表示落点在目标右半边（插到其后） */
  placeAfter: boolean;
}

/** 指针移动超过这个距离才算拖动，避免单击被误判 */
const DRAG_THRESHOLD = 4;
/** 靠近标签条左右边缘多少像素开始自动滚动 */
const EDGE_PX = 32;
/** 自动滚动每帧最大位移 */
const MAX_SCROLL_STEP = 16;
/** 拖动结束后抑制 click 的时长，避免松手时激活/关闭标签 */
const CLICK_SUPPRESS_MS = 120;
/** 指针在标签条上下的容差，拖动时手抖不丢落点 */
const STRIP_Y_SLACK = 24;

interface DragSession {
  tabId: string;
  strip: HTMLElement | null;
  pointerId: number;
  startX: number;
  startY: number;
  started: boolean;
}

/**
 * 按坐标计算插入落点：命中标签按左右半区决定前后；落在空白区则归到最近标签的一侧，
 * 因此拖到首/尾之外也能移动到队首/队尾。
 */
function computeHint(
  strip: HTMLElement,
  draggedId: string,
  x: number,
  y: number,
): TabDropHint | null {
  const stripRect = strip.getBoundingClientRect();
  if (x < stripRect.left || x > stripRect.right) return null;
  if (y < stripRect.top - STRIP_Y_SLACK || y > stripRect.bottom + STRIP_Y_SLACK) return null;

  const hovered = document
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>("[data-tab-id]");
  if (hovered) {
    const hoveredId = hovered.dataset.tabId;
    if (!hoveredId || hoveredId === draggedId) return null;
    const rect = hovered.getBoundingClientRect();
    return { tabId: hoveredId, placeAfter: x > rect.left + rect.width / 2 };
  }

  const tabs = Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-id]")).filter(
    (tab) => tab.dataset.tabId && tab.dataset.tabId !== draggedId,
  );
  for (const tab of tabs) {
    const id = tab.dataset.tabId;
    if (!id) continue;
    const rect = tab.getBoundingClientRect();
    if (x < rect.left + rect.width / 2) return { tabId: id, placeAfter: false };
  }
  const lastId = tabs[tabs.length - 1]?.dataset.tabId;
  return lastId ? { tabId: lastId, placeAfter: true } : null;
}

/**
 * 顶部标签栏的左右拖动排序。
 *
 * 用 Pointer Events 而不是 HTML5 拖拽：Tauri 窗口默认开启原生 drag-drop 处理
 * （拖文件进编辑器需要它），WebView2 下 HTML5 dragover 拿不到放行，鼠标会一直显示
 * 禁止图标且无法落点。指针实现还能在靠近边缘时自动左右滚动、拖到首尾之外。
 */
export function useTabDragReorder(pane: EditorPane) {
  const moveTabInPane = useEditorStore((s) => s.moveTabInPane);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [hint, setHint] = useState<TabDropHint | null>(null);

  const sessionRef = useRef<DragSession | null>(null);
  const hintRef = useRef<TabDropHint | null>(null);
  const lastPointRef = useRef({ x: 0, y: 0 });
  const scrollRafRef = useRef<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const suppressClickUntilRef = useRef(0);

  const applyHint = useCallback((next: TabDropHint | null) => {
    const prev = hintRef.current;
    if (
      prev === next ||
      (prev && next && prev.tabId === next.tabId && prev.placeAfter === next.placeAfter)
    ) {
      return;
    }
    hintRef.current = next;
    setHint(next);
  }, []);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  const onTabPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, tabId: string) => {
      if (event.button !== 0 || sessionRef.current) return;
      // 输入框（重命名）与按钮（关闭）保持自己的按下行为
      if ((event.target as HTMLElement | null)?.closest("input, button, a")) return;

      const tabElement = event.currentTarget;
      const strip = tabElement.closest<HTMLElement>("[data-tab-strip]");
      const pointerId = event.pointerId;
      const session: DragSession = {
        tabId,
        strip,
        pointerId,
        startX: event.clientX,
        startY: event.clientY,
        started: false,
      };
      sessionRef.current = session;
      lastPointRef.current = { x: event.clientX, y: event.clientY };

      const updateHint = (x: number, y: number) => {
        if (!strip) return;
        applyHint(computeHint(strip, tabId, x, y));
      };

      const stopAutoScroll = () => {
        if (scrollRafRef.current !== null) {
          cancelAnimationFrame(scrollRafRef.current);
          scrollRafRef.current = null;
        }
      };

      const tickAutoScroll = () => {
        if (!sessionRef.current?.started || !strip) {
          scrollRafRef.current = null;
          return;
        }
        const rect = strip.getBoundingClientRect();
        const { x, y } = lastPointRef.current;
        let delta = 0;
        if (x < rect.left + EDGE_PX) {
          delta = -Math.ceil(((rect.left + EDGE_PX - x) / EDGE_PX) * MAX_SCROLL_STEP);
        } else if (x > rect.right - EDGE_PX) {
          delta = Math.ceil(((x - (rect.right - EDGE_PX)) / EDGE_PX) * MAX_SCROLL_STEP);
        }
        if (delta !== 0) {
          strip.scrollLeft += delta;
          updateHint(x, y);
        }
        scrollRafRef.current = requestAnimationFrame(tickAutoScroll);
      };

      const finish = (commit: boolean) => {
        const active = sessionRef.current;
        if (!active) return;
        sessionRef.current = null;
        cleanupRef.current?.();
        cleanupRef.current = null;
        stopAutoScroll();
        document.body.classList.remove("tab-dragging");
        const dropHint = hintRef.current;
        applyHint(null);
        setDraggingTabId(null);
        if (active.started) {
          suppressClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
        }
        if (commit && active.started && dropHint && dropHint.tabId !== active.tabId) {
          moveTabInPane(pane, active.tabId, dropHint.tabId, dropHint.placeAfter);
        }
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        lastPointRef.current = { x: moveEvent.clientX, y: moveEvent.clientY };
        if (!session.started) {
          if (
            Math.abs(moveEvent.clientX - session.startX) < DRAG_THRESHOLD &&
            Math.abs(moveEvent.clientY - session.startY) < DRAG_THRESHOLD
          ) {
            return;
          }
          session.started = true;
          setDraggingTabId(tabId);
          document.body.classList.add("tab-dragging");
          if (strip) scrollRafRef.current = requestAnimationFrame(tickAutoScroll);
        }
        updateHint(moveEvent.clientX, moveEvent.clientY);
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        finish(true);
      };

      const handlePointerCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId === pointerId) finish(false);
      };

      const handleKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === "Escape") finish(false);
      };

      // 指针在窗口外松开时也要结束拖动，避免卡在拖拽状态
      const handleWindowBlur = () => finish(false);

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerCancel);
      window.addEventListener("keydown", handleKeyDown, true);
      window.addEventListener("blur", handleWindowBlur);
      cleanupRef.current = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerCancel);
        window.removeEventListener("keydown", handleKeyDown, true);
        window.removeEventListener("blur", handleWindowBlur);
        stopAutoScroll();
        document.body.classList.remove("tab-dragging");
      };
    },
    [applyHint, moveTabInPane, pane],
  );

  /** 拖动结束后的那次 click 不应切换/关闭标签 */
  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if (performance.now() >= suppressClickUntilRef.current) {
      suppressClickUntilRef.current = 0;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    suppressClickUntilRef.current = 0;
  }, []);

  return { draggingTabId, hint, onTabPointerDown, onClickCapture };
}
