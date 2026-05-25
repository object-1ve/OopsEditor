import { FolderOpen, Save, File, X } from "lucide-react";
import { useEditorStore } from "../store/editor";
import { detectLanguage } from "../types";

export default function Toolbar() {
  const { tabs, activeTabId, setActiveTab, closeTab } = useEditorStore();

  return (
    <div 
      className="flex items-center h-10 bg-secondary border-b border-border select-none relative z-10"
    >
      {/* Actions */}
      <div className="flex items-center gap-0.5 px-1.5">
        <ActionButton onClick={() => openFile()} title="打开文件 (Ctrl+O)" icon={<FolderOpen size={15} />} />
        <ActionButton onClick={() => saveCurrentFile()} title="保存 (Ctrl+S)" icon={<Save size={15} />} />
      </div>

      {/* Tabs */}
      <div className="flex items-center flex-1 overflow-x-auto h-full relative">
        <div className="flex items-center h-full">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`group relative flex items-center gap-1.5 px-3 h-full text-sm cursor-pointer transition-all duration-150 min-w-0 shrink-0 select-none ${
                tab.id === activeTabId
                  ? "bg-primary text-text-primary"
                  : "bg-secondary text-text-muted hover:text-text-secondary hover:bg-surface/50"
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.id === activeTabId && (
                <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-accent to-accent-bright rounded-full" />
              )}

              <File size={14} className="shrink-0 opacity-60" />
              <span className="truncate max-w-28">{tab.name}</span>
              {tab.isDirty && <span className="text-accent-warm text-xs shrink-0">&#9679;</span>}
              <button
                className="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-surface transition-all shrink-0 cursor-pointer text-text-muted hover:text-text-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ActionButton({ onClick, title, icon }: { onClick: () => void; title: string; icon: React.ReactNode }) {
  return (
    <button
      className="p-1.5 rounded-md hover:bg-surface text-text-muted hover:text-accent transition-all duration-150 cursor-pointer"
      onClick={onClick}
      title={title}
    >
      {icon}
    </button>
  );
}

async function openFile() {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const { invoke } = await import("@tauri-apps/api/core");

    const selected = await open({
      multiple: false,
      filters: [
        { name: "All Files", extensions: ["*"] },
        { name: "Text", extensions: ["txt", "md", "json", "yaml", "yml", "xml", "toml"] },
        { name: "Code", extensions: ["js", "ts", "jsx", "tsx", "rs", "py", "css", "html", "sql"] },
      ],
    });

    if (selected) {
      const name = selected.split(/[/\\]/).pop() ?? selected;
      const language = detectLanguage(name);
      let content = "";

      if (language !== "image") {
        try {
          content = await readTextFile(selected);
        } catch {
          content = await invoke<string>("read_file", { path: selected });
        }
      }

      const id = selected;

      useEditorStore.getState().openTab({
        id,
        name,
        path: selected,
        language,
        content,
        isDirty: false,
      });
    }
  } catch (err) {
    useEditorStore.getState().showNotification(`无法打开所选文件 (可能是不支持的二进制格式)`, "error");
  }
}

async function saveCurrentFile() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const state = useEditorStore.getState();
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (tab) {
      await invoke("save_file", { path: tab.path, content: tab.content });
      useEditorStore.getState().markClean(tab.id);
    }
  } catch {
    // Not in Tauri context
  }
}
