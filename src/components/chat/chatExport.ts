/**
 * 会话导出：把 JSONL 会话文件另存到用户选择的位置。
 *
 * 单会话导出从聊天头部 / 侧边栏会话右键触发；批量导出从侧边栏「会话」分组标题触发。
 */
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  exportAllChatSessions,
  exportChatSession,
  type ChatSession,
} from "@/services/chat";

export type Notify = (
  message: string,
  type?: "info" | "error" | "success",
) => void;

/** 去掉 Windows 文件名非法字符，并限制长度 */
export function chatExportFileName(
  session: Pick<ChatSession, "id" | "title">,
): string {
  const cleaned = session.title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 60);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  const base =
    cleaned && !reserved.test(cleaned) ? cleaned : `session-${session.id}`;
  return `${base}.jsonl`;
}

/** 导出当前会话；用户取消对话框时返回 false */
export async function exportSessionToJsonl(
  session: Pick<ChatSession, "id" | "title">,
  notify: Notify,
): Promise<boolean> {
  try {
    const target = await save({
      defaultPath: chatExportFileName(session),
      filters: [{ name: "JSONL", extensions: ["jsonl"] }],
    });
    if (!target) return false;
    const exportedPath = await exportChatSession(session.id, target);
    const name = exportedPath.split(/[/\\]/).pop() ?? exportedPath;
    notify(`已导出会话: ${name}`, "success");
    return true;
  } catch (err) {
    console.error("导出会话失败:", err);
    notify(`导出会话失败: ${String(err)}`, "error");
    return false;
  }
}

/** 批量导出全部会话到用户选择的目录；用户取消时返回 false */
export async function exportAllSessionsToJsonl(notify: Notify): Promise<boolean> {
  try {
    const dir = await open({ directory: true, multiple: false });
    if (!dir || typeof dir !== "string") return false;
    const count = await exportAllChatSessions(dir);
    if (count === 0) {
      notify("没有可导出的会话", "info");
    } else {
      notify(`已导出 ${count} 个会话`, "success");
    }
    return true;
  } catch (err) {
    console.error("批量导出会话失败:", err);
    notify(`批量导出会话失败: ${String(err)}`, "error");
    return false;
  }
}
