/**
 * Hex/Base64 utility functions for editor modes
 */
import { parseHexView, bytesToAsciiView, getHexOffsetLabel } from "@/utils/hexView";

export { getHexOffsetLabel };

export function decodeHexPreview(content: string) {
  const parsed = parseHexView(content);
  if (parsed.error || !parsed.bytes) {
    return {
      text: "",
      byteLength: 0,
      error: parsed.error ?? "当前十六进制内容无法解析。",
    };
  }

  return {
    text: bytesToAsciiView(parsed.bytes),
    byteLength: parsed.bytes.length,
    error: null as string | null,
  };
}

export function countHexDigits(text: string) {
  const matches = text.match(/[0-9A-Fa-f]/g);
  return matches ? matches.length : 0;
}

export function getSelectedByteRange(
  text: string,
  startOffset: number,
  endOffset: number,
) {
  const startHexDigits = countHexDigits(text.slice(0, startOffset));
  const endHexDigits = countHexDigits(text.slice(0, endOffset));
  const startByte = Math.floor(startHexDigits / 2);
  const endByte = Math.ceil(endHexDigits / 2);

  if (endByte <= startByte) {
    return null;
  }

  return { startByte, endByte };
}

export function byteIndexToAsciiPosition(byteIndex: number) {
  const lineOffset = byteIndex % 16;
  // 4字符一组，组内紧密，组间双空格
  // 组0: cols 1-4, 组1: cols 7-10, 组2: cols 13-16, 组3: cols 19-22
  const groupIndex = Math.floor(lineOffset / 4);
  const posInGroup = lineOffset % 4;
  const column = groupIndex * 6 + posInGroup + 1; // group*6: 4chars + 2spaces
  return {
    lineNumber: Math.floor(byteIndex / 16) + 1,
    column,
  };
}
