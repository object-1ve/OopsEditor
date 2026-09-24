/**
 * 会话附件的打开 / 定位。
 *
 * 两种路径来源：
 * - `file` 消息：记录的是**原始本地路径**，直接按扩展名分派打开；
 * - `image` 消息：记录的是应用数据目录里的副本路径（asset 协议渲染缩略图用）。
 *
 * 会话视图下主编辑区被对话占据，所以打开文件必须先切回编辑器视图，
 * 否则标签页建好了也看不见（用户表现为「点了打不开」）。
 */
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { detectLanguage, isPreviewOnlyLanguage } from "@/types";
import { useEditorStore } from "@/store/editor";
import { chatDisplayName } from "./chatFormat";

type Notify = (message: string, type?: "info" | "error" | "success") => void;

/**
 * 全屏查看图片。
 * 会话视图下开标签页等于看不见，所以图片默认在查看器里放大。
 */
export function previewChatImage(path: string, name?: string) {
  useEditorStore.getState().openImagePreview({
    path,
    name: name || path.split(/[/\\]/).pop() || path,
  });
}

/**
 * 打开会话附件（文件走编辑器标签页，不能预览的交给系统程序）。
 * 发送文件时只记了路径，原文件可能已被移动或删除，这里显式校验并给出可读提示。
 */
export async function openChatFile(
  path: string,
  showNotification: Notify,
  displayName?: string | null,
) {
  const storedName = path.split(/[/\\]/).pop() ?? path;
  // 展示名由调用方给出（它知道是原始文件还是带哈希的图片副本），缺省退回去哈希
  const name = displayName?.trim() || chatDisplayName(storedName);
  const { language, unsupportedReason } = detectLanguage(storedName);

  let exists = false;
  try {
    exists = await invoke<boolean>("path_exists", { path });
  } catch {
    exists = false;
  }
  if (!exists) {
    showNotification(`文件已不在原位置: ${name}（可能被移动或删除）`, "error");
    return;
  }

  // 视频之类不能在编辑器里预览的类型，交给系统默认程序
  if (language === "unsupported") {
    try {
      await openPath(path);
    } catch (err) {
      showNotification(`${unsupportedReason ?? `无法打开文件: ${name}`} (${String(err)})`, "error");
    }
    return;
  }

  try {
    // 预览类模式（图片/PDF/Word/SQLite）由各自的模式自行读盘，不必预读内容
    const content = isPreviewOnlyLanguage(language)
      ? ""
      : await invoke<string>("read_file", { path });

    useEditorStore.getState().openTab({
      id: path,
      name,
      path,
      language,
      content,
      isDirty: false,
      viewMode: "text",
      isReadOnly: false,
    });
    useEditorStore.getState().recordRecentFile(path);
    // 关键：会话视图下必须切回编辑器，否则标签页不可见
    useEditorStore.getState().setActiveView("files");
  } catch (err) {
    showNotification(`无法打开文件: ${name} (${String(err)})`, "error");
  }
}

/** 在资源管理器中定位会话附件 */
export async function revealChatFile(path: string, showNotification: Notify) {
  try {
    await revealItemInDir(path);
  } catch (err) {
    showNotification(`定位文件失败: ${String(err)}`, "error");
  }
}

/** 分享的文件/图片是否仍在原位置（用于在气泡上提示失效） */
export async function chatFileExists(path: string): Promise<boolean> {
  try {
    return await invoke<boolean>("path_exists", { path });
  } catch {
    return false;
  }
}
