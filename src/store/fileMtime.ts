/**
 * fileMtime - 跟踪文件修改时间，用于检测外部变更
 *
 * 记录每个文件已知的 modified_at 值，供 externalSync 服务轮询时判断是否发生变化。
 * 独立模块，无 store 依赖，避免循环引用。
 */
import { invoke } from "@tauri-apps/api/core";
import { normalizePath } from "@/utils/path";

const knownMtimes = new Map<string, number>();

/** 设置文件已知修改时间 */
export function setFileMtime(path: string, mtime: number) {
  if (path) knownMtimes.set(normalizePath(path), mtime);
}

/** 获取文件已知修改时间 */
export function getFileMtime(path: string): number | undefined {
  return knownMtimes.get(normalizePath(path));
}

/** 清除文件已知修改时间 */
export function clearFileMtime(path: string) {
  knownMtimes.delete(normalizePath(path));
}

/** 从磁盘获取文件修改时间并记录 */
export async function fetchAndSetFileMtime(path: string): Promise<number | undefined> {
  if (!path) return undefined;
  try {
    const info = await invoke<{ modified_at: number }>("get_file_info", { path });
    setFileMtime(path, info.modified_at);
    return info.modified_at;
  } catch {
    return undefined;
  }
}