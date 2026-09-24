/**
 * 会话输入区的拖放目标登记。
 *
 * Tauri 的 OS 拖放事件只给坐标 + 路径，命中判定与派发都在 App 侧统一做；
 * 这里保留「会话输入区」那个 DOM 节点与它注册的路径处理函数，
 * 避免把这些跨组件引用塞进 store 或层层透传 props。
 */

type ChatDropHandler = (paths: string[]) => void;
type DragOverListener = (isOver: boolean) => void;

let dropElement: HTMLElement | null = null;
let dropHandler: ChatDropHandler | null = null;
const dragOverListeners = new Set<DragOverListener>();

/** 输入区挂载时登记节点与处理函数，卸载时传 null 清空 */
export function registerChatDropZone(
  element: HTMLElement | null,
  handler: ChatDropHandler | null = null,
) {
  dropElement = element;
  dropHandler = handler;
}

/** 拖到输入区上方时的高亮订阅（由 App 的拖放事件驱动） */
export function subscribeChatDragOver(listener: DragOverListener): () => void {
  dragOverListeners.add(listener);
  return () => {
    dragOverListeners.delete(listener);
  };
}

export function notifyChatDragOver(isOver: boolean) {
  dragOverListeners.forEach((listener) => listener(isOver));
}

/**
 * 坐标是否落在会话输入区上。
 * Tauri 报的是物理像素，需按 devicePixelRatio 折回 CSS 像素——与 App 里
 * 终端/编辑器的判定保持一致。
 */
export function isPointInsideChatDropZone(position?: { x: number; y: number }): boolean {
  if (!position || !dropElement) return false;
  const factor = window.devicePixelRatio || 1;
  const x = position.x / factor;
  const y = position.y / factor;
  const rect = dropElement.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** 把拖进来的路径交给会话输入区；返回是否已被消费（未登记处理函数时为 false） */
export function dispatchPathsToChat(paths: string[]): boolean {
  if (!dropHandler || paths.length === 0) return false;
  dropHandler(paths);
  return true;
}
