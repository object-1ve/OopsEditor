import { ArrowUpCircle, X } from "lucide-react";
import { confirmUpdate, dismissUpdate, useUpdaterDialog } from "@/hooks/useUpdater";

/** 应用内更新弹窗：挂在 App 根节点。available 确认 → downloading 进度 → ready 退出安装。 */
export default function UpdateDialog() {
  const { stage, version, body, progress } = useUpdaterDialog();

  if (stage === "idle") return null;

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" />

      <div className="relative w-full max-w-md overflow-hidden rounded-xl border border-border bg-secondary shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between border-b border-border bg-surface/50 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <ArrowUpCircle size={18} className="text-accent" />
            <h3 className="text-sm font-bold tracking-tight uppercase text-text">
              {stage === "downloading" ? "正在下载更新" : stage === "ready" ? "更新就绪" : "发现新版本"}
            </h3>
          </div>
          {stage === "available" && (
            <button
              onClick={dismissUpdate}
              className="rounded-md p-1 transition-colors hover:bg-surface hover:text-text"
              title="稍后更新"
            >
              <X size={16} />
            </button>
          )}
        </div>

        <div className="space-y-4 px-5 py-5">
          <div className="text-sm font-medium text-text">v{version}</div>
          {stage === "available" && body && (
            <div className="max-h-48 overflow-y-auto rounded-md bg-deepest/60 px-3 py-2 text-xs leading-relaxed text-text-secondary whitespace-pre-wrap">
              {body}
            </div>
          )}
          {stage === "available" && !body && (
            <p className="text-xs leading-relaxed text-text-secondary">已有新版本可用，建议更新后继续使用。</p>
          )}
          {(stage === "downloading" || stage === "ready") && (
            <div className="space-y-2">
              <div className="h-2 overflow-hidden rounded-full bg-surface">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="text-xs text-text-secondary">
                {stage === "ready" ? "下载完成，正在退出并启动安装…" : `下载中 ${progress}%`}
              </div>
            </div>
          )}
        </div>

        {stage === "available" && (
          <div className="flex justify-end gap-2 border-t border-border bg-surface/30 px-5 py-4">
            <button
              onClick={dismissUpdate}
              className="rounded-md border border-border px-4 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface hover:text-text"
            >
              稍后
            </button>
            <button
              onClick={() => void confirmUpdate()}
              className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-accent-bright"
            >
              立即更新
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
