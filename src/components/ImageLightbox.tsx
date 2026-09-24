/**
 * ImageLightbox - 全屏图片查看器（滚轮缩放、拖拽平移、按钮缩放、Esc 关闭）
 *
 * 编辑器里的 markdown 图片与会话里的图片附件共用同一份实现，
 * 通过 store 的 imagePreview 请求驱动，任意位置都能调 openImagePreview() 打开。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEditorStore } from "@/store/editor";

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.25;
const WHEEL_STEP = 0.15;

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/** 图片时间戳：本地文件路径要转 asset 协议，data:/http: 等 URL 直接用 */
function toImageSrc(path: string, url?: string | null): string {
  if (url) return url;
  if (/^(data:|blob:|https?:|asset:)/i.test(path)) return path;
  return convertFileSrc(path);
}

export default function ImageLightbox() {
  const imagePreview = useEditorStore((s) => s.imagePreview);
  const closeImagePreview = useEditorStore((s) => s.closeImagePreview);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // 光标要跟着拖拽态变（渲染），拖拽判定要走 ref（pointermove 的闭包可能还是上一帧的）
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, baseX: 0, baseY: 0 });
  // 拖拽起点需要读到当前位移，用 ref 镜像保证 pointerdown 拿到最新值
  const panRef = useRef(pan);
  panRef.current = pan;

  // 换图时回到 1:1，避免上一张的缩放/位移带过来
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setIsDragging(false);
  }, [imagePreview?.path, imagePreview?.url]);

  useEffect(() => {
    if (!imagePreview) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeImagePreview();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [closeImagePreview, imagePreview]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => clamp(z + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP), MIN_ZOOM, MAX_ZOOM));
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // 先落拖拽态：setPointerCapture 对非活动指针会抛错，不能让它挡住拖拽
    dragRef.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      baseX: panRef.current.x,
      baseY: panRef.current.y,
    };
    setIsDragging(true);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // 指针已失效时忽略；移出图片外的 pointerup 由 onPointerCancel/失焦兜底
    }
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current.dragging) return;
    setPan({
      x: dragRef.current.baseX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.baseY + (e.clientY - dragRef.current.startY),
    });
  }, []);

  const handlePointerUp = useCallback(() => {
    dragRef.current.dragging = false;
    setIsDragging(false);
  }, []);

  if (!imagePreview) return null;

  const { path, url, name, revision } = imagePreview;
  // revision 作为查询参数，避免外部替换图片后仍命中浏览器缓存
  const src = `${toImageSrc(path, url)}${url ? "" : `?v=${revision ?? 0}`}`;

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center overflow-hidden"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={handleWheel}
    >
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={closeImagePreview} />

      <img
        src={src}
        alt={name}
        className="relative select-none rounded-lg shadow-2xl"
        style={{
          transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
          maxWidth: "90vw",
          maxHeight: "90vh",
          objectFit: "contain",
          cursor: isDragging ? "grabbing" : "grab",
        }}
        draggable={false}
        onPointerDown={handlePointerDown}
        onClick={(e) => e.stopPropagation()}
      />

      <button
        onClick={closeImagePreview}
        title="关闭 (Esc)"
        className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white text-xl leading-none transition-colors cursor-pointer"
      >
        ×
      </button>

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-2 rounded-full bg-black/40 backdrop-blur-sm max-w-[90vw]">
        <button
          onClick={() => setZoom((z) => clamp(z - ZOOM_STEP, MIN_ZOOM, MAX_ZOOM))}
          title="缩小"
          className="w-6 h-6 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/25 text-white text-sm leading-none transition-colors cursor-pointer"
        >
          −
        </button>
        <span className="text-white/60 text-xs tabular-nums min-w-[3.5em] text-center">
          {Math.round(zoom * 100)}%
        </span>
        <button
          onClick={() => setZoom((z) => clamp(z + ZOOM_STEP, MIN_ZOOM, MAX_ZOOM))}
          title="放大"
          className="w-6 h-6 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/25 text-white text-sm leading-none transition-colors cursor-pointer"
        >
          +
        </button>
        <span className="w-px h-4 bg-white/15" />
        <button
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          className="text-white/50 hover:text-white/80 text-xs transition-colors cursor-pointer"
        >
          重置
        </button>
        <span className="text-white/30 text-xs ml-1 truncate">{name}</span>
      </div>
    </div>
  );
}
