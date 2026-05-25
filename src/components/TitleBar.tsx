import WindowControls from "./WindowControls";

export default function TitleBar() {
  const handleDoubleClick = async () => {
    try {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      await getCurrentWebviewWindow().toggleMaximize();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div 
      data-tauri-drag-region
      onDoubleClick={handleDoubleClick}
      className="h-8 bg-deepest border-b border-border flex items-center justify-between select-none relative z-[100] cursor-default"
    >
      <div 
        className="flex-1 h-full flex items-center gap-2 px-3 pointer-events-none"
      >
        <div className="w-4 h-4 rounded bg-gradient-to-br from-accent to-accent-bright flex items-center justify-center shadow-sm">
          <svg width="10" height="10" viewBox="0 0 32 32" fill="none">
            <rect x="6" y="7" width="20" height="18" rx="3" stroke="white" strokeWidth="2.5" fill="none" />
            <path d="M10 13h12M10 17h8M10 21h6" stroke="white" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
        <span className="text-[11px] font-medium text-text-muted tracking-tight">
          Oops Editor
        </span>
      </div>
      
      <WindowControls />
    </div>
  );
}
