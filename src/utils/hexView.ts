const BYTES_PER_LINE = 16;
const GROUP_BYTES = 4;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join("");
}

export function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/\s+/g, "");
  if (!normalized) {
    return new Uint8Array();
  }

  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function formatHexViewFromHex(hex: string): string {
  const normalized = hex.replace(/\s+/g, "").toUpperCase();
  if (!normalized) {
    return "";
  }

  const pairs = normalized.match(/.{1,2}/g) ?? [];
  const lines: string[] = [];

  for (let i = 0; i < pairs.length; i += BYTES_PER_LINE) {
    const linePairs = pairs.slice(i, i + BYTES_PER_LINE);
    const groups: string[] = [];

    for (let j = 0; j < linePairs.length; j += GROUP_BYTES) {
      groups.push(linePairs.slice(j, j + GROUP_BYTES).join(" "));
    }

    lines.push(groups.join("  "));
  }

  return lines.join("\n");
}

export function bytesToHexView(bytes: Uint8Array): string {
  return formatHexViewFromHex(bytesToHex(bytes));
}

export function base64ToHexView(base64: string): string {
  return bytesToHexView(base64ToBytes(base64));
}

export function parseHexView(content: string) {
  const normalized = content.replace(/\s+/g, "");
  if (!normalized) {
    return {
      normalizedHex: "",
      bytes: new Uint8Array(),
      error: null as string | null,
    };
  }

  if (!/^[0-9A-Fa-f]+$/.test(normalized)) {
    return {
      normalizedHex: normalized,
      bytes: null,
      error: "左侧内容包含非十六进制字符。",
    };
  }

  if (normalized.length % 2 !== 0) {
    return {
      normalizedHex: normalized,
      bytes: null,
      error: "十六进制字符数量必须为偶数。",
    };
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }

  return {
    normalizedHex: normalized.toUpperCase(),
    bytes,
    error: null as string | null,
  };
}

export function hexViewToBase64(content: string): string {
  const parsed = parseHexView(content);
  if (parsed.error || !parsed.bytes) {
    throw new Error(parsed.error ?? "十六进制内容无效");
  }
  return bytesToBase64(parsed.bytes);
}

export function bytesToAsciiView(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }

  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += BYTES_PER_LINE) {
    const chunk = bytes.slice(i, i + BYTES_PER_LINE);
    const text = Array.from(chunk, (byte) =>
      byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "."
    ).join("");
    lines.push(text);
  }

  return lines.join("\n");
}

export function getHexOffsetLabel(lineNumber: number): string {
  return ((lineNumber - 1) * BYTES_PER_LINE).toString(16).toUpperCase().padStart(4, "0");
}
