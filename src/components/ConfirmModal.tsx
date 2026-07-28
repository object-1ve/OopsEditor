import { X, AlertTriangle, Info } from "lucide-react";
import { useEditorStore } from "@/store/editor";
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

  const renderMessage = (text: string) => {
    const parts = text.split(/("[^"]+")/);
    return parts.map((part, index) => {
      if (part.startsWith('"') && part.endsWith('"')) {
        return (
          <span key={index} className="text-text font-bold bg-surface px-1.5 py-0.5 rounded border border-border/50 mx-0.5">
            {part}
          </span>
        );
      }
      return part;
    });
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
        <div className="px-6 py-4 flex items-center justify-between border-b border-border bg-surface/50">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-surface/50 border border-border/50">
              {getIcon()}
            </div>
            <h3 className="text-sm font-bold text-text tracking-tight">{title}</h3>
          </div>
          <button 
            onClick={handleCancel}
            className="p-1.5 hover:bg-surface rounded-lg transition-all text-text-muted hover:text-text hover:rotate-90"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-10">
          <p className="text-base text-text-secondary leading-relaxed text-center font-medium">
            {renderMessage(message)}
          </p>
        </div>

        <div className="px-6 py-5 bg-surface/30 grid grid-cols-2 gap-4">
          <button
            onClick={handleCancel}
            className="w-full px-4 py-2.5 text-sm font-semibold text-text-secondary hover:text-text bg-surface border border-border rounded-xl transition-all hover:border-text-muted/30 active:scale-[0.98]"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            className={`w-full px-4 py-2.5 text-sm font-semibold rounded-xl shadow-lg shadow-black/10 transition-all transform active:scale-[0.98] ${getConfirmButtonClass()}`}
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
