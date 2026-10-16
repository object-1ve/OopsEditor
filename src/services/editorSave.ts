import { invoke } from "@tauri-apps/api/core";
import type { FileTab } from "@/types";
import { hexViewToBase64 } from "@/utils/hexView";
import { saveExcelDoc } from "@/services/excelDocs";

type SaveTargetPath = string | undefined;

function resolveTargetPath(tab: FileTab, targetPath?: SaveTargetPath) {
  return targetPath ?? tab.path;
}

async function saveTextTab(tab: FileTab, targetPath?: SaveTargetPath) {
  await invoke("save_file", {
    path: resolveTargetPath(tab, targetPath),
    content: tab.content,
  });
}

async function saveBase64Tab(tab: FileTab, targetPath?: SaveTargetPath) {
  await invoke("save_file_from_base64", {
    path: resolveTargetPath(tab, targetPath),
    content: hexViewToBase64(tab.content),
  });
}

async function copyImageTab(tab: FileTab, targetPath?: SaveTargetPath) {
  const resolvedTargetPath = resolveTargetPath(tab, targetPath);
  await invoke("copy_file", {
    sourcePath: tab.path,
    targetPath: resolvedTargetPath,
  });
}

/**
 * 统一保存入口：按标签类型分派到文本 / 二进制 / 图片 / Excel 的写入通道。
 * 返回 false 表示用户取消了保存（例如 Excel 提示“会丢失内容”时选择取消）。
 */
export async function saveTab(tab: FileTab, targetPath?: string): Promise<boolean> {
  if (tab.language === "image") {
    await copyImageTab(tab, targetPath);
    return true;
  }

  if (tab.language === "excel") {
    return await saveExcelDoc(tab.id, targetPath);
  }

  if (tab.viewMode === "base64") {
    await saveBase64Tab(tab, targetPath);
    return true;
  }

  await saveTextTab(tab, targetPath);
  return true;
}
