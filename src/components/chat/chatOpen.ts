/**
 * 会话附件的打开 / 定位。
 *
 * 附件是落在应用数据目录里的副本，按扩展名分派：能预览的走编辑器标签页
 * （复用既有的 image / pdf / text 模式），不能预览的交给系统默认程序。
 */
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { detectLanguage, isPreviewOnlyLanguage } from "@/types";
import { useEditorStore } from "@/store/editor";
import { chatDisplayName } from "./chatFormat";

type Notify = (message: string, type?: "info" | "error" | "success") => void;

/**
 * 全屏查看会话图片。
 * 会话视图下主编辑区被对话占据，开标签页等于看不见，因此图片默认放大查看。
 */
export function previewChatImage(path: string, name?: string) {
  useEditorStore.getState().openImagePreview({
    path,
    name: name || path.split(/[/\\]/).pop() || path,
  });
}

export async function openChatFile(path: string, showNotification: Notify) {
  const storedName = path.split(/[/\\]/).pop() ?? path;
  // 存储文件名带内容哈希（去重用），编辑器标签页显示去哈希后的名字
  const name = chatDisplayName(storedName);
  const { language, unsupportedReason } = detectLanguage(storedName);

  // 视频之类不能在编辑器里预览的类型，交给系统默认程序
  if (language === "unsupported") {
    try {
      await openPath(path);
    } catch (err) {
      showNotification(`${unsupportedReason ?? `无法打开附件: ${name}`} (${String(err)})`, "error");
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
  } catch (err) {
    showNotification(`无法打开附件: ${name} (${String(err)})`, "error");
  }
}

/** 在资源管理器中定位会话附件 */
export async function revealChatFile(path: string, showNotification: Notify) {
  try {
    await revealItemInDir(path);
  } catch (err) {
    showNotification(`定位附件失败: ${String(err)}`, "error");
  }
}
