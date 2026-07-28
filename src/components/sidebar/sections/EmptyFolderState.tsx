/**
 * EmptyFolderState - Placeholder shown when no folders are open
 */
import { Folder } from "lucide-react";

interface EmptyFolderStateProps {
  onOpenFolder: () => void;
}

export default function EmptyFolderState({ onOpenFolder }: EmptyFolderStateProps) {
  return (
    <div className="flex flex-col items-center justify-center p-6 text-center space-y-4 mt-4">
      <div className="w-10 h-10 rounded-full bg-accent/5 flex items-center justify-center text-accent/30">
        <Folder size={20} />
      </div>
      <div className="space-y-1">
        <p className="text-xs text-text-secondary font-medium">未打开文件夹</p>
        <p className="text-[10px] text-text-muted">添加文件夹到工作区来查看文件结构</p>
      </div>
      <button
        onClick={onOpenFolder}
        className="px-3 py-1.5 bg-accent hover:bg-accent-bright text-white text-xs rounded-md shadow-sm transition-colors"
      >
        打开文件夹
      </button>
    </div>
  );
}
