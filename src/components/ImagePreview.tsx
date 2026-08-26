import { useState, useEffect, useRef } from "react";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";

interface ImagePreviewProps {
  src: string;
  name: string;
  path: string;
}

export default function ImagePreview({ src, name, path }: ImagePreviewProps) {
  const [zoom, setZoom] = useState(1);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    // Reset zoom when image changes
    setZoom(1);
    
    // Get file info from path if possible (simulated for now, could use Tauri fs)
    // In a real app, we might want to call a Rust command to get metadata
  }, [src]);

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = e.currentTarget;
    setDimensions({ width: naturalWidth, height: naturalHeight });
  };

  const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.25, 5));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.25, 0.1));
  const handleResetZoom = () => setZoom(1);

  return (
    <div className="flex-1 h-full flex flex-col bg-deepest overflow-hidden relative group">
      {/* Top Toolbar */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-1 p-1 rounded-full bg-surface/80 backdrop-blur-md border border-border shadow-xl z-30 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
        <button 
          onClick={handleZoomOut}
          className="p-2 rounded-full hover:bg-white/10 text-text-muted hover:text-text-primary transition-colors"
          title="缩小"
        >
          <ZoomOut size={16} />
        </button>
        <div className="text-[11px] font-medium text-text-muted min-w-[3rem] text-center">
          {Math.round(zoom * 100)}%
        </div>
        <button 
          onClick={handleZoomIn}
          className="p-2 rounded-full hover:bg-white/10 text-text-muted hover:text-text-primary transition-colors"
          title="放大"
        >
          <ZoomIn size={16} />
        </button>
        <div className="w-px h-4 bg-border mx-1" />
        <button 
          onClick={handleResetZoom}
          className="p-2 rounded-full hover:bg-white/10 text-text-muted hover:text-text-primary transition-colors"
          title="重置"
        >
          <RotateCcw size={16} />
        </button>
      </div>

      {/* Image Container */}
      <div className="flex-1 overflow-auto flex items-center justify-center p-8 custom-scrollbar bg-deepest">
        <div className="relative group/img">
          {/* Checkerboard background for transparent images */}
          <div className="absolute inset-0 z-0 bg-checkerboard opacity-20" />
          
          <img
            ref={imgRef}
            src={src}
            alt={name}
            onLoad={handleImageLoad}
            className="block relative z-10 border border-border/50 rounded-sm shadow-2xl transition-[width,height] duration-200 ease-out"
            style={{ 
              width: dimensions ? `${dimensions.width * zoom}px` : 'auto',
              height: dimensions ? `${dimensions.height * zoom}px` : 'auto',
              imageRendering: zoom > 1 ? 'pixelated' : 'auto',
              maxWidth: 'none',
              maxHeight: 'none'
            }}
          />
        </div>
      </div>

      {/* Bottom Status Bar */}
      <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between px-4 py-2 rounded-xl bg-surface/60 backdrop-blur-sm border border-border/40 text-text-muted text-[10px] z-30 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-text-secondary">文件名:</span>
            <span>{name}</span>
          </div>
          {dimensions && (
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-text-secondary">尺寸:</span>
              <span>{dimensions.width} × {dimensions.height}</span>
            </div>
          )}
        </div>
        <div className="truncate ml-8 text-text-muted/60">
          {path}
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .bg-checkerboard {
          background-image: linear-gradient(45deg, #888 25%, transparent 25%),
            linear-gradient(-45deg, #888 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, #888 75%),
            linear-gradient(-45deg, transparent 75%, #888 75%);
          background-size: 20px 20px;
          background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
        }
      `}} />
    </div>
  );
}
