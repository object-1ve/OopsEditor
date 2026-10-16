/**
 * xlsx 结构探测：保存前用来判断“编辑器重写会丢掉哪些内容”。
 *
 * ExcelJS 只建模它认识的部分（工作表、样式、共享字符串、图片/绘图、主题、文档属性），
 * 写盘时会丢弃其余 part（图表、批注、表格、数据透视表、切片器、控件、外部链接等）。
 * 这里零依赖地解析 zip 中央目录把它们找出来，再解压工作表 XML 检查冻结窗格、迷你图
 * 这类“part 级看不出来”的特性。
 */

/** 重写时会丢失的部件 → 中文标签 */
const LOSSY_PART_LABELS: { pattern: RegExp; label: string }[] = [
  { pattern: /^xl\/charts\//, label: "图表" },
  { pattern: /^xl\/chartsheets\//, label: "图表工作表" },
  { pattern: /^xl\/comments\d*\.xml$/i, label: "批注" },
  { pattern: /^xl\/threadedComments\//i, label: "批注（会话式）" },
  { pattern: /^xl\/tables\//i, label: "表格" },
  { pattern: /^xl\/pivotTables\//i, label: "数据透视表" },
  { pattern: /^xl\/pivotCache\//i, label: "数据透视表缓存" },
  { pattern: /^xl\/slicers?\//i, label: "切片器" },
  { pattern: /^xl\/slicerCaches\//i, label: "切片器缓存" },
  { pattern: /^xl\/timelines?\//i, label: "时间线" },
  { pattern: /^xl\/activeX\//i, label: "ActiveX 控件" },
  { pattern: /^xl\/ctrlProps\//i, label: "表单控件" },
  { pattern: /^xl\/drawings\/vmlDrawing/i, label: "批注/控件图形(vml)" },
  { pattern: /^xl\/externalLinks\//i, label: "外部链接" },
  { pattern: /^xl\/queryTables\//i, label: "查询表" },
  { pattern: /^xl\/customXml\//i, label: "自定义 XML" },
  { pattern: /^xl\/diagrams\//i, label: "SmartArt" },
  { pattern: /^xl\/embeddings\//i, label: "嵌入对象(OLE)" },
  { pattern: /^xl\/vbaProject\.bin$/i, label: "VBA 宏" },
  { pattern: /^xl\/macrosheets\//i, label: "宏工作表" },
  { pattern: /^xl\/richData\//i, label: "富数据（单元格内图片）" },
  { pattern: /^xl\/revisions\//i, label: "修订记录" },
];

export interface XlsxFidelityReport {
  /** 重写后会丢失的内容类别（去重，中文） */
  lossyLabels: string[];
  /** 命中的部件/特性标识，便于排查与提示细节 */
  lossyParts: string[];
}

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

/** 读取 zip 中央目录；遇到 zip64 等无法处理的结构返回 null（探针只做尽力而为） */
function readCentralDirectory(bytes: Uint8Array): ZipEntry[] | null {
  if (bytes.byteLength < 22) return null;
  const view = new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);

  const scanLimit = Math.min(bytes.byteLength, 0x10000 + 22);
  let endOfCentralDirectory = -1;
  for (let offset = bytes.byteLength - 22; offset >= bytes.byteLength - scanLimit; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOfCentralDirectory = offset;
      break;
    }
  }
  if (endOfCentralDirectory < 0) return null;

  const count = view.getUint16(endOfCentralDirectory + 10, true);
  let cursor = view.getUint32(endOfCentralDirectory + 16, true);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== 0x02014b50) break;
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    // 目录条目（以 / 结尾）只是打包痕迹，不参与内容判断
    if (!name.endsWith("/")) {
      entries.push({
        name,
        compressionMethod: view.getUint16(cursor + 10, true),
        compressedSize: view.getUint32(cursor + 20, true),
        localHeaderOffset: view.getUint32(cursor + 42, true),
      });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** 解压单个 zip 条目的文本内容（支持 store 与 deflate） */
async function readEntryText(bytes: Uint8Array, entry: ZipEntry): Promise<string | null> {
  const view = new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  const header = entry.localHeaderOffset;
  if (header + 30 > bytes.byteLength || view.getUint32(header, true) !== 0x04034b50) return null;

  const nameLength = view.getUint16(header + 26, true);
  const extraLength = view.getUint16(header + 28, true);
  const start = header + 30 + nameLength + extraLength;
  if (entry.compressedSize <= 0) return null;

  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.compressionMethod === 0) return new TextDecoder().decode(data);
  if (entry.compressionMethod !== 8 || typeof DecompressionStream === "undefined") return null;

  const stream = new Blob([data as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}

export async function probeXlsxFidelity(bytes: Uint8Array): Promise<XlsxFidelityReport> {
  const labels = new Set<string>();
  const parts: string[] = [];
  if (bytes.byteLength === 0) return { lossyLabels: [], lossyParts: parts };

  const entries = readCentralDirectory(bytes);
  if (!entries) return { lossyLabels: [], lossyParts: parts };

  for (const entry of entries) {
    const match = LOSSY_PART_LABELS.find((item) => item.pattern.test(entry.name));
    if (!match) continue;
    labels.add(match.label);
    parts.push(entry.name);
  }

  // 工作表 XML 内的特性：冻结窗格、迷你图（part 级看不出来）
  for (const entry of entries) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(entry.name)) continue;
    const xml = await readEntryText(bytes, entry);
    if (!xml) continue;
    if (/<pane[\s/>]/.test(xml)) {
      labels.add("冻结窗格");
      parts.push(`${entry.name}#pane`);
    }
    if (/<sparklineGroups/.test(xml)) {
      labels.add("迷你图");
      parts.push(`${entry.name}#sparkline`);
    }
  }

  return { lossyLabels: [...labels], lossyParts: parts };
}
