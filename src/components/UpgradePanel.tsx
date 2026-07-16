import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Plus, Copy, ClipboardPaste, Trash2, Check, Clock, Edit2, Save, Filter } from "lucide-react";

interface UpgradeItem {
  id: number;
  title: string;
  description: string;
  status: string;
  priority: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface UpgradePanelProps {
  onClose: () => void;
}

type StatusFilter = "all" | "pending" | "completed";

export default function UpgradePanel({ onClose }: UpgradePanelProps) {
  const [items, setItems] = useState<UpgradeItem[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [showImportBox, setShowImportBox] = useState(false);
  const [importText, setImportText] = useState("");
  const [exportCopied, setExportCopied] = useState(false);

  const loadItems = useCallback(async () => {
    try {
      const result = await invoke<UpgradeItem[]>("get_all_upgrade_items");
      setItems(result);
    } catch (err) {
      console.error("加载升级项失败:", err);
    }
  }, []);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  const filteredItems = items.filter((item) => {
    if (filter === "all") return true;
    return item.status === filter;
  });

  const handleAdd = async () => {
    if (!newTitle.trim()) return;
    try {
      await invoke("add_upgrade_item", {
        item: { title: newTitle.trim(), description: newDescription.trim() || null },
      });
      setNewTitle("");
      setNewDescription("");
      setShowAddForm(false);
      await loadItems();
    } catch (err) {
      console.error("添加升级项失败:", err);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await invoke("delete_upgrade_item", { id });
      await loadItems();
    } catch (err) {
      console.error("删除升级项失败:", err);
    }
  };

  const handleToggleStatus = async (item: UpgradeItem) => {
    const newStatus = item.status === "completed" ? "pending" : "completed";
    try {
      await invoke("update_upgrade_item", { id: item.id, status: newStatus });
      await loadItems();
    } catch (err) {
      console.error("更新状态失败:", err);
    }
  };

  const handleStartEdit = (item: UpgradeItem) => {
    setEditingId(item.id);
    setEditTitle(item.title);
    setEditDescription(item.description);
  };

  const handleSaveEdit = async (id: number) => {
    if (!editTitle.trim()) return;
    try {
      await invoke("update_upgrade_item", {
        id,
        title: editTitle.trim(),
        description: editDescription.trim(),
      });
      setEditingId(null);
      await loadItems();
    } catch (err) {
      console.error("更新升级项失败:", err);
    }
  };

  const handleExportJson = async () => {
    try {
      const jsonStr = await invoke<string>("export_upgrade_items_json");
      await navigator.clipboard.writeText(jsonStr);
      setExportCopied(true);
      setTimeout(() => setExportCopied(false), 2000);
    } catch (err) {
      console.error("导出失败:", err);
    }
  };

  const handleImportFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setImportText(text);
    } catch (err) {
      console.error("读取剪贴板失败:", err);
    }
  };

  const handleConfirmImport = async () => {
    if (!importText.trim()) return;
    try {
      const count = await invoke<number>("import_upgrade_items_json", { jsonContent: importText.trim() });
      console.log(`已导入 ${count} 项`);
      setImportText("");
      setShowImportBox(false);
      await loadItems();
    } catch (err) {
      console.error("导入失败:", err);
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-2xl h-[80vh] max-h-[700px] flex flex-col overflow-hidden rounded-xl border border-border bg-secondary shadow-2xl animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-surface/50 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-accent/10 border border-accent/20">
              <Filter size={16} className="text-accent" />
            </div>
            <h3 className="text-sm font-bold tracking-tight uppercase text-text">升级日志</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-surface transition-colors text-text-muted hover:text-text">
            <X size={16} />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-primary/30 shrink-0">
          <div className="flex items-center gap-1.5">
            {(["all", "pending", "completed"] as StatusFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  filter === f
                    ? "bg-accent text-white"
                    : "bg-surface/50 text-text-muted hover:text-text hover:bg-surface"
                }`}
              >
                {f === "all" ? "全部" : f === "pending" ? "待完成" : "已完成"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowImportBox(!showImportBox)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-surface/50 text-text-muted hover:text-accent hover:bg-surface transition-colors"
              title="导入 JSON"
            >
              <ClipboardPaste size={14} />
              导入
            </button>
            <button
              onClick={handleExportJson}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                exportCopied
                  ? "bg-accent/10 text-accent"
                  : "bg-surface/50 text-text-muted hover:text-accent hover:bg-surface"
              }`}
              title="复制 JSON 到剪贴板"
            >
              <Copy size={14} />
              {exportCopied ? "已复制" : "导出"}
            </button>
            <button
              onClick={() => setShowAddForm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent-bright transition-colors"
            >
              <Plus size={14} />
              新建
            </button>
          </div>
        </div>

        {/* Import Box */}
        {showImportBox && (
          <div className="px-5 py-4 border-b border-border bg-surface/30 shrink-0">
            <textarea
              placeholder="粘贴 JSON 内容到此处..."
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={5}
              className="w-full px-3 py-2 mb-3 text-xs font-mono bg-primary border border-border rounded-lg text-text placeholder-text-muted focus:outline-none focus:border-accent resize-none"
              autoFocus
            />
            <div className="flex justify-between items-center">
              <button
                onClick={handleImportFromClipboard}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-surface/50 text-text-muted hover:text-accent hover:bg-surface transition-colors"
              >
                <ClipboardPaste size={12} />
                从剪贴板粘贴
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => { setShowImportBox(false); setImportText(""); }}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-surface text-text-muted hover:text-text transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleConfirmImport}
                  disabled={!importText.trim()}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent-bright disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  导入
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Add Form */}
        {showAddForm && (
          <div className="px-5 py-4 border-b border-border bg-surface/30 shrink-0">
            <input
              type="text"
              placeholder="标题"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              className="w-full px-3 py-2 mb-2 text-sm bg-primary border border-border rounded-lg text-text placeholder-text-muted focus:outline-none focus:border-accent"
              autoFocus
            />
            <textarea
              placeholder="描述（可选）"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 mb-3 text-sm bg-primary border border-border rounded-lg text-text placeholder-text-muted focus:outline-none focus:border-accent resize-none"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowAddForm(false); setNewTitle(""); setNewDescription(""); }}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-surface text-text-muted hover:text-text transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleAdd}
                disabled={!newTitle.trim()}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent-bright disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                添加
              </button>
            </div>
          </div>
        )}

        {/* Items List */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-text-muted">
              <Filter size={32} className="mb-3 opacity-30" />
              <p className="text-sm">{filter === "all" ? "暂无升级项" : filter === "pending" ? "没有待完成项" : "没有已完成项"}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredItems.map((item) => (
                <div
                  key={item.id}
                  className={`group rounded-xl border p-4 transition-all ${
                    item.status === "completed"
                      ? "border-border/50 bg-surface/30 opacity-75"
                      : "border-border bg-primary/40 hover:border-accent/30"
                  }`}
                >
                  {editingId === item.id ? (
                    /* Edit Mode */
                    <div>
                      <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="w-full px-3 py-2 mb-2 text-sm bg-deepest border border-border rounded-lg text-text focus:outline-none focus:border-accent"
                        autoFocus
                      />
                      <textarea
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        rows={2}
                        className="w-full px-3 py-2 mb-3 text-sm bg-deepest border border-border rounded-lg text-text focus:outline-none focus:border-accent resize-none"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setEditingId(null)}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-surface text-text-muted hover:text-text transition-colors"
                        >
                          取消
                        </button>
                        <button
                          onClick={() => handleSaveEdit(item.id)}
                          className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent-bright transition-colors"
                        >
                          <Save size={12} />
                          保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Display Mode */
                    <div className="flex items-start gap-3">
                      {/* Status Toggle */}
                      <button
                        onClick={() => handleToggleStatus(item)}
                        className={`mt-0.5 shrink-0 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${
                          item.status === "completed"
                            ? "bg-accent border-accent text-white"
                            : "border-border hover:border-accent/50 text-transparent hover:text-accent/30"
                        }`}
                        title={item.status === "completed" ? "标记为待完成" : "标记为已完成"}
                      >
                        {item.status === "completed" && <Check size={12} />}
                      </button>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h4 className={`text-sm font-semibold ${item.status === "completed" ? "line-through text-text-muted" : "text-text"}`}>
                            {item.title}
                          </h4>
                          <span
                            className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${
                              item.status === "completed"
                                ? "bg-accent/10 text-accent"
                                : "bg-orange-500/10 text-orange-500"
                            }`}
                          >
                            {item.status === "completed" ? "已完成" : "待完成"}
                          </span>
                        </div>
                        {item.description && (
                          <p className="text-xs text-text-secondary leading-relaxed mt-1">{item.description}</p>
                        )}
                        <div className="flex items-center gap-3 mt-2 text-[10px] text-text-muted">
                          <span>{formatDate(item.created_at)}</span>
                          {item.updated_at !== item.created_at && (
                            <span className="opacity-60">更新于 {formatDate(item.updated_at)}</span>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => handleStartEdit(item)}
                          className="p-1.5 rounded-lg hover:bg-surface text-text-muted hover:text-accent transition-colors"
                          title="编辑"
                        >
                          <Edit2 size={14} />
                        </button>
                        <button
                          onClick={() => handleDelete(item.id)}
                          className="p-1.5 rounded-lg hover:bg-surface text-text-muted hover:text-error transition-colors"
                          title="删除"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer Stats */}
        <div className="px-5 py-3 border-t border-border bg-surface/30 shrink-0">
          <div className="flex items-center justify-between text-[11px] text-text-muted">
            <span>共 {items.length} 项</span>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <Clock size={11} />
                待完成 {items.filter((i) => i.status === "pending").length}
              </span>
              <span className="flex items-center gap-1">
                <Check size={11} />
                已完成 {items.filter((i) => i.status === "completed").length}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
