/**
 * InfoPanel - File information panel in right sidebar
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined) return "未知";
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatModifiedTime(timestamp: number | undefined): string {
  if (!timestamp) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

interface FileInfo {
  size: number;
  modified_at: number;
}

interface InfoPanelProps {
  filePath?: string;
}

export default function InfoPanel({ filePath }: InfoPanelProps) {
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);

  useEffect(() => {
    if (!filePath) {
      setFileInfo(null);
      return;
    }
    let cancelled = false;
    invoke<FileInfo>("get_file_info", { path: filePath })
      .then((info) => { if (!cancelled) setFileInfo(info); })
      .catch(() => { if (!cancelled) setFileInfo(null); });
    return () => { cancelled = true; };
  }, [filePath]);

  if (!filePath) {
    return (
      <div className="p-4 text-xs text-text-muted italic">
        未选择文件
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="space-y-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted/85">文件信息</h3>
        <div className="space-y-1.5">
          <div className="flex justify-between">
            <span className="text-xs text-text-muted">大小</span>
            <span className="text-xs text-text-secondary">{fileInfo ? formatFileSize(fileInfo.size) : "加载中..."}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-xs text-text-muted">修改时间</span>
            <span className="text-xs text-text-secondary">{fileInfo ? formatModifiedTime(fileInfo.modified_at) : "加载中..."}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-xs text-text-muted">路径</span>
            <span className="text-xs text-text-secondary truncate max-w-[180px]" title={filePath}>{filePath}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
