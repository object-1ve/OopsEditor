import { X, AlertTriangle, Info } from "lucide-react";
import { useEditorStore } from "../store/editor";
import { useEffect, useRef } from "react";

export default function ConfirmModal() {
  const { modal, closeModal } = useEditorStore();
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && modal) {
        closeModal();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [modal, closeModal]);

  if (!modal) return null;

  const { title, message, onConfirm, onCancel, kind = "info" } = modal;

  const handleConfirm = () => {
    onConfirm();
    closeModal();
  };

  const handleCancel = () => {
    if (onCancel) onCancel();
    closeModal();
  };

  const getIcon = () => {
    switch (kind) {
      case "danger":
      case "warning":
        return <AlertTriangle size={20} className="text-error" />;
      default:
        return <Info size={20} className="text-accent" />;
    }
  };

  const getConfirmButtonClass = () => {
    switch (kind) {
      case "danger":
        return "bg-error hover:bg-error/80 text-white";
      case "warning":
        return "bg-orange-500 hover:bg-orange-600 text-white";
      default:
        return "bg-accent hover:bg-accent-bright text-white";
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
        onClick={handleCancel}
      />
      
      {/* Modal Content */}
      <div 
        ref={modalRef}
        className="relative w-full max-w-sm bg-secondary border border-border rounded-xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200"
      >
        <div className="px-5 py-4 flex items-center justify-between border-b border-border bg-surface/50">
          <div className="flex items-center gap-2.5">
            {getIcon()}
            <h3 className="text-sm font-bold text-text tracking-tight uppercase">{title}</h3>
          </div>
          <button 
            onClick={handleCancel}
            className="p-1 hover:bg-surface rounded-md transition-colors text-text-muted hover:text-text"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-6 py-8">
          <p className="text-sm text-text-secondary leading-relaxed">
            {message}
          </p>
        </div>

        <div className="px-5 py-4 bg-surface/30 flex justify-end gap-3">
          <button
            onClick={handleCancel}
            className="px-4 py-1.5 text-xs font-medium text-text-secondary hover:text-text hover:bg-surface rounded-md transition-all"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            className={`px-4 py-1.5 text-xs font-medium rounded-md shadow-sm transition-all transform active:scale-95 ${getConfirmButtonClass()}`}
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
