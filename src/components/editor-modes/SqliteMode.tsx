/**
 * SQLite database viewer mode
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Database, RefreshCw, Table } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { EditorModeContext, EditorModeAdapter } from "./types";

function SqliteModeView({
  activeTab,
  showNotification,
}: Pick<EditorModeContext, "activeTab" | "showNotification">) {
  const [tables, setTables] = useState<{ name: string }[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableData, setTableData] = useState<{ columns: string[]; rows: any[][] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const pageSize = 50;

  const loadTables = useCallback(async () => {
    try {
      setLoading(true);
      const result = await invoke<{ name: string }[]>("get_sqlite_tables", { path: activeTab.path });
      setTables(result);
      if (result.length > 0 && !selectedTable) {
        setSelectedTable(result[0].name);
      }
    } catch (err) {
      showNotification(`加载表失败: ${err}`, "error");
    } finally {
      setLoading(false);
    }
  }, [activeTab.path, activeTab.revision, showNotification]);

  const loadTableData = useCallback(async () => {
    if (!selectedTable) return;
    try {
      setLoading(true);
      const result = await invoke<{ columns: string[]; rows: any[][] }>("get_sqlite_table_data", {
        path: activeTab.path,
        table: selectedTable,
        limit: pageSize,
        offset: page * pageSize,
      });
      setTableData(result);
    } catch (err) {
      showNotification(`加载数据失败: ${err}`, "error");
    } finally {
      setLoading(false);
    }
  }, [activeTab.path, selectedTable, page, activeTab.revision, showNotification]);

  useEffect(() => {
    loadTables();
  }, [loadTables]);

  useEffect(() => {
    loadTableData();
  }, [loadTableData]);

  return (
    <div className="flex h-full bg-primary overflow-hidden">
      {/* Sidebar for tables */}
      <div className="w-64 border-r border-border flex flex-col bg-deepest shrink-0">
        <div className="p-3 border-b border-border flex items-center justify-between bg-surface/40">
          <div className="flex items-center gap-2 text-xs font-bold text-text-secondary uppercase tracking-wider">
            <Database size={14} />
            <span>数据库表</span>
          </div>
          <button
            onClick={loadTables}
            className="p-1 hover:bg-surface rounded text-text-muted hover:text-accent transition-colors"
            title="刷新表列表"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-1 space-y-0.5">
          {tables.map((table) => (
            <button
              key={table.name}
              onClick={() => {
                setSelectedTable(table.name);
                setPage(0);
              }}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded text-sm transition-all text-left ${
                selectedTable === table.name
                  ? "bg-accent/10 text-accent font-medium shadow-sm"
                  : "text-text-secondary hover:bg-surface/50"
              }`}
            >
              <Table size={14} className={selectedTable === table.name ? "text-accent" : "text-text-muted"} />
              <span className="truncate">{table.name}</span>
            </button>
          ))}
          {tables.length === 0 && !loading && (
            <div className="p-4 text-center text-xs text-text-muted italic">
              无可用表
            </div>
          )}
        </div>
      </div>

      {/* Main content for data */}
      <div className="flex-1 flex flex-col min-w-0 bg-primary">
        <div className="p-3 border-b border-border flex items-center justify-between bg-surface/20 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Table size={14} className="text-accent shrink-0" />
            <span className="font-medium text-sm truncate">
              {selectedTable || "未选择表"}
            </span>
            {tableData && (
              <span className="text-[10px] bg-accent/10 text-accent px-1.5 py-0.5 rounded-full font-bold">
                {tableData.rows.length} 条记录
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            <div className="flex items-center bg-deepest rounded-md border border-border p-0.5 shadow-sm">
              <button
                disabled={page === 0 || loading}
                onClick={() => setPage(p => Math.max(0, p - 1))}
                className="p-1 hover:bg-surface disabled:opacity-30 disabled:hover:bg-transparent rounded transition-colors text-text-secondary"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="text-[10px] px-2 font-mono font-bold text-text-muted">
                P.{page + 1}
              </span>
              <button
                disabled={(tableData?.rows.length || 0) < pageSize || loading}
                onClick={() => setPage(p => p + 1)}
                className="p-1 hover:bg-surface disabled:opacity-30 disabled:hover:bg-transparent rounded transition-colors text-text-secondary"
              >
                <ChevronRight size={14} />
              </button>
            </div>
            <button
              onClick={loadTableData}
              className="p-1.5 hover:bg-surface rounded border border-border bg-deepest text-text-muted hover:text-accent transition-all shadow-sm"
              title="刷新数据"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto relative scrollbar-thin">
          {tableData ? (
            <div className="inline-block min-w-full align-middle">
              <table className="min-w-full divide-y divide-border border-separate border-spacing-0">
                <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur-sm shadow-sm">
                  <tr>
                    {tableData.columns.map((col) => (
                      <th
                        key={col}
                        className="px-4 py-2.5 text-left text-xs font-bold text-text uppercase tracking-wider border-b border-border border-r last:border-r-0 whitespace-nowrap"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="bg-primary divide-y divide-border">
                  {tableData.rows.map((row, i) => (
                    <tr key={i} className="hover:bg-surface/30 transition-colors group">
                      {row.map((val, j) => (
                        <td
                          key={j}
                          className="px-4 py-2 text-sm text-text-secondary border-r border-border last:border-r-0 whitespace-nowrap max-w-xs truncate"
                          title={val === null ? "NULL" : String(val)}
                        >
                          {val === null ? (
                            <span className="text-text-muted/70 italic text-xs">NULL</span>
                          ) : typeof val === 'boolean' ? (
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${val ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>
                              {val ? 'TRUE' : 'FALSE'}
                            </span>
                          ) : (
                            String(val)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {tableData.rows.length === 0 && (
                    <tr>
                      <td colSpan={tableData.columns.length} className="px-6 py-12 text-center text-text-muted italic bg-surface/5">
                        <div className="flex flex-col items-center gap-2">
                          <Database size={24} className="opacity-20" />
                          <span>此表中没有数据</span>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-text-muted gap-4 bg-surface/5">
              {loading ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="w-8 h-8 border-2 border-accent/20 border-t-accent rounded-full animate-spin" />
                  <span className="text-xs font-medium animate-pulse">正在查询数据...</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 max-w-xs text-center">
                  <Table size={32} className="opacity-20 mb-2" />
                  <p className="text-sm font-medium">请从左侧选择一个表</p>
                  <p className="text-xs text-text-muted/85">SQLite 数据库已就绪，点击左侧表名开始查看数据</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const sqliteMode: EditorModeAdapter = {
  id: "sqlite",
  match: (tab) => tab.language === "sqlite",
  render: (context) => (
    <SqliteModeView
      activeTab={context.activeTab}
      showNotification={context.showNotification}
    />
  ),
};
