/**
 * Excel 工作簿缓存与持久化。
 *
 * 工作簿按标签 id 常驻内存（切换标签、分屏不会丢失未保存的改动），
 * 脏标记沿用 FileTab.isDirty，保存统一走既有的二进制写入命令
 * `save_file_from_base64`，无需新增 Rust 命令。
 */
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import type { Workbook } from "exceljs";

export interface ExcelDoc {
  /** 已解析的工作簿，编辑直接作用于它 */
  workbook: Workbook;
  /** 加载时对应的 FileTab.revision，外部修改后据此重新加载 */
  revision: number;
  /** 加载时的文件路径，另存为后随之更新 */
  path: string;
  /** 原文件是空文件（0 字节），按空白工作簿打开，保存后才成为有效 xlsx */
  isBlank: boolean;
}

/** 按需加载的 exceljs 入口（体积大，只在真正打开表格时进入单独 chunk） */
interface ExcelJSApi {
  Workbook: new () => Workbook;
}

const docs = new Map<string, ExcelDoc>();

let exceljsPromise: Promise<ExcelJSApi> | null = null;

function loadExcelJS(): Promise<ExcelJSApi> {
  if (!exceljsPromise) {
    exceljsPromise = import("exceljs").then((mod) => {
      const interop = mod as unknown as { default?: ExcelJSApi };
      return interop.default ?? mod;
    });
  }
  return exceljsPromise;
}

/** 读取并解析工作簿；已有同版本缓存时直接复用，避免重复解析 */
export async function loadExcelDoc(
  tabId: string,
  path: string,
  revision: number,
): Promise<ExcelDoc> {
  const cached = docs.get(tabId);
  if (cached && cached.revision === revision && cached.path === path) {
    return cached;
  }

  const ExcelJS = await loadExcelJS();

  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`无法读取文件（${detail}）`);
  }

  const workbook = new ExcelJS.Workbook();
  const isBlank = bytes.byteLength === 0;

  if (isBlank) {
    // 空文件（例如编辑器里新建的 .xlsx）按空白工作簿打开，
    // 否则 exceljs 会把它当压缩包解析并抛出 “Corrupted zip” 之类的底层错误
    workbook.addWorksheet("Sheet1");
  } else {
    try {
      await workbook.xlsx.load(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`不是有效的 Excel 工作簿（文件已损坏或格式不受支持）：${detail}`);
    }
  }

  const doc: ExcelDoc = { workbook, revision, path, isBlank };
  docs.set(tabId, doc);
  return doc;
}

/** 标签关闭时释放；重复释放无副作用 */
export function evictExcelDoc(tabId: string) {
  docs.delete(tabId);
}

/** 序列化工作簿并写回磁盘（targetPath 用于“保存到默认文件夹”之类的另存） */
export async function saveExcelDoc(tabId: string, targetPath?: string) {
  const doc = docs.get(tabId);
  if (!doc) {
    throw new Error("工作簿尚未加载完成");
  }

  const buffer = await doc.workbook.xlsx.writeBuffer();
  const path = targetPath ?? doc.path;
  await invoke("save_file_from_base64", {
    path,
    content: bufferToBase64(buffer),
  });
  doc.path = path;
  // 写盘后文件已有内容，不再算空白工作簿
  doc.isBlank = false;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
