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

  const getKindStyle = () => {
    switch (kind) {
      case "danger":
        return {
          icon: <AlertTriangle size={20} className="text-error" />,
          badge: "bg-error/10 border-error/25",
        };
      case "warning":
        return {
          icon: <AlertTriangle size={20} className="text-orange-500" />,
          badge: "bg-orange-500/10 border-orange-500/25",
        };
      default:
        return {
          icon: <Info size={20} className="text-accent" />,
          badge: "bg-accent/10 border-accent/25",
        };
    }
  };

  const getConfirmButtonClass = () => {
    const base =
      "text-white shadow-md hover:shadow-lg transition-all duration-150 transform hover:-translate-y-px active:translate-y-0 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2";
    switch (kind) {
      case "danger":
        return `${base} bg-error hover:bg-error/90 hover:shadow-[0_6px_18px_rgba(192,57,43,0.35)] focus-visible:ring-error/40`;
      case "warning":
        return `${base} bg-orange-500 hover:bg-orange-600 hover:shadow-[0_6px_18px_rgba(249,115,22,0.35)] focus-visible:ring-orange-500/40`;
      default:
        return `${base} bg-accent hover:bg-accent-bright hover:shadow-[0_6px_18px_rgba(200,106,78,0.35)] focus-visible:ring-accent/40`;
    }
  };

  const kindStyle = getKindStyle();

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 select-none">
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
            <div className={`p-2 rounded-lg border ${kindStyle.badge}`}>
              {kindStyle.icon}
            </div>
            <h3 className="text-sm font-bold text-text tracking-tight">{title}</h3>
          </div>
          <button
            onClick={handleCancel}
            className="p-1.5 rounded-lg transition-all duration-150 cursor-pointer text-text-muted hover:bg-surface hover:text-text hover:rotate-90 active:scale-90"
            title="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-9">
          <p className="text-base text-text-secondary leading-relaxed text-center font-medium">
            {renderMessage(message)}
          </p>
        </div>

        <div className="px-6 py-5 bg-surface/30 grid grid-cols-2 gap-4">
          <button
            onClick={handleCancel}
            className="w-full px-4 py-2.5 text-sm font-semibold cursor-pointer text-text-secondary bg-surface/70 border border-border rounded-xl shadow-sm transition-all duration-150 hover:bg-surface hover:text-text hover:border-text-muted/40 hover:shadow-md active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            className={`w-full px-4 py-2.5 text-sm font-semibold cursor-pointer rounded-xl ${getConfirmButtonClass()}`}
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
