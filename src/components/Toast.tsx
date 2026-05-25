import { X, AlertCircle, CheckCircle, Info } from "lucide-react";
import { useEditorStore } from "../store/editor";

export default function Toast() {
  const { notification, clearNotification } = useEditorStore();

  if (!notification) return null;

  const { message, type } = notification;

  const iconMap = {
    info: <Info size={18} className="text-blue-500" />,
    error: <AlertCircle size={18} className="text-red-500" />,
    success: <CheckCircle size={18} className="text-green-500" />,
  };

  const bgMap = {
    info: "bg-[var(--bg-primary)] border-[var(--border)]",
    error: "bg-red-50 border-red-200",
    success: "bg-green-50 border-green-200",
  };

  return (
    <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[999] animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border shadow-xl ${bgMap[type]} min-w-[320px] backdrop-blur-md`}>
        {iconMap[type]}
        <span className="text-sm font-medium text-[var(--text-primary)] flex-1">{message}</span>
        <button 
          onClick={clearNotification}
          className="p-1 hover:bg-[var(--bg-hover)] rounded-full transition-colors text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
