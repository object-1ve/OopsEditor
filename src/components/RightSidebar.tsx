import { useCallback, useRef } from "react";
import { Info, Share2, HelpCircle } from "lucide-react";
import { useEditorStore } from "../store/editor";

export default function RightSidebar() {
  const { rightSidebarWidth, setRightSidebarWidth } = useEditorStore();
  const isResizing = useRef(false);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", stopResizing);
    document.body.style.cursor = "col-resize";
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing.current) return;
    const newWidth = window.innerWidth - e.clientX;
    if (newWidth > 36 && newWidth < 400) {
      setRightSidebarWidth(newWidth);
    }
  }, [setRightSidebarWidth]);

  const stopResizing = useCallback(() => {
    isResizing.current = false;
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", stopResizing);
    document.body.style.cursor = "default";
  }, [handleMouseMove]);

  return (
    <div 
      className="h-full bg-deepest border-l border-border flex flex-col items-center py-4 gap-4 relative group/right-sidebar"
      style={{ width: `${rightSidebarWidth}px` }}
    >
      {/* Resize Handle */}
      <div
        onMouseDown={startResizing}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors z-50"
      />

      <div className="flex-1 flex flex-col items-center gap-4">
        <SidebarIcon icon={<Info size={18} />} title="文件信息" />
        <SidebarIcon icon={<Share2 size={18} />} title="分享" />
      </div>
      
      <div className="flex flex-col items-center gap-4">
        <SidebarIcon icon={<HelpCircle size={18} />} title="帮助" />
      </div>
    </div>
  );
}

function SidebarIcon({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <button
      className="p-2 rounded-lg text-text-muted hover:text-accent hover:bg-surface transition-all duration-200 cursor-pointer group relative"
      title={title}
    >
      {icon}
      <span className="absolute right-full mr-2 px-2 py-1 rounded bg-secondary text-text-primary text-[10px] whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity shadow-sm border border-border z-50">
        {title}
      </span>
    </button>
  );
}
