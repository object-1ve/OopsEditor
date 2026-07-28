import { invoke } from "@tauri-apps/api/core";
import type { FileTab } from "@/types";
import { hexViewToBase64 } from "@/utils/hexView";

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

export async function saveTab(tab: FileTab, targetPath?: string) {
  if (tab.language === "image") {
    await copyImageTab(tab, targetPath);
    return;
  }

  if (tab.viewMode === "base64") {
    await saveBase64Tab(tab, targetPath);
    return;
  }

  await saveTextTab(tab, targetPath);
}
