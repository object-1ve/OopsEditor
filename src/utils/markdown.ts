import type { ReactNode } from "react";
import { isValidElement } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { collapsePathSegments } from "./path";

export interface MarkdownHeading {
  id: string;
  level: number;
  text: string;
  line: number;
}

function normalizeHeadingText(text: string): string {
  return text
    .replace(/\s+#+\s*$/, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

export function slugifyMarkdownHeading(text: string): string {
  const normalized = normalizeHeadingText(text)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

  return normalized || "section";
}

export function createMarkdownHeadingIdFactory() {
  const seen = new Map<string, number>();

  return (text: string, line?: number) => {
    if (line !== undefined) {
      return `${slugifyMarkdownHeading(text)}-L${line}`;
    }
    const slug = slugifyMarkdownHeading(text);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    return count === 0 ? slug : `${slug}-${count}`;
  };
}

export interface LineUrlHit {
  /** 地址本身在行内的区间（0 起、左闭右开） */
  start: number;
  end: number;
  /** 可以直接交给系统浏览器打开的 http(s) 地址 */
  url: string;
}

const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
const BARE_URL_PATTERN = /https?:\/\/[^\s)<>]+/g;

/**
 * 在一行文本里找 column（0 起）命中的网址。
 *
 * Markdown 链接 `[文本](地址)` 优先于裸链接，避免把链接内部地址重复命中成两段；
 * 裸链接尾部的句读（.,;:!?）不算地址的一部分。
 */
export function findUrlAtColumn(line: string, column: number): LineUrlHit | null {
  const patterns: Array<{ regex: RegExp; asUrl: (match: RegExpExecArray) => string }> = [
    { regex: MARKDOWN_LINK_PATTERN, asUrl: (match) => match[2] },
    {
      regex: BARE_URL_PATTERN,
      asUrl: (match) => match[0].replace(/[.,;:!?]+$/, ""),
    },
  ];

  for (const { regex, asUrl } of patterns) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (column >= start && column < end) {
        const url = asUrl(match);
        const startOffset = match[0].indexOf(url);
        const urlStart = startOffset < 0 ? start : start + startOffset;
        return { start: urlStart, end: urlStart + url.length, url };
      }
    }
  }

  return null;
}

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\n]+)\)/g;

export interface LineImageHit {
  /** 整段 `![alt](地址)` 在行内的区间 */
  start: number;
  end: number;
  alt: string;
  /** 原样的地址（可能是相对路径、attachment:、http(s) 等） */
  src: string;
}

/** 在一行文本里找 column（0 起）命中的 Markdown 图片语法 */
export function findMarkdownImageAtColumn(
  line: string,
  column: number,
): LineImageHit | null {
  MARKDOWN_IMAGE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_IMAGE_PATTERN.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (column >= start && column < end) {
      return { start, end, alt: match[1], src: match[2].trim() };
    }
  }
  return null;
}

/** Markdown 图片地址 → 本地绝对路径；http/data/asset/attachment 等非文件地址返回 null */
export function resolveMarkdownImagePath(
  rawSrc: string,
  docPath?: string | null,
): string | null {
  let src = rawSrc.trim();
  if (!src || /^(https?|data|blob|asset|attachment):/i.test(src)) return null;

  if (src.startsWith("file://")) {
    src = src.replace(/^file:\/\/\/?/, "");
  }
  try {
    if (src.includes("%")) src = decodeURIComponent(src);
  } catch {
    // 保留原样，交给后面的路径拼接
  }

  // 绝对路径（Windows: C:\... / C:/...，Unix: /...）
  if (/^(?:[A-Za-z]:[/\\]?|[/\\])/.test(src)) {
    const absolute = /^[A-Za-z]:[^/\\]/.test(src) ? `${src.substring(0, 2)}\\${src.substring(2)}` : src;
    return collapsePathSegments(absolute);
  }

  if (!docPath) return null;
  const lastSeparator = Math.max(docPath.lastIndexOf("/"), docPath.lastIndexOf("\\"));
  if (lastSeparator <= 0) return null;
  const separator = docPath.includes("\\") ? "\\" : "/";
  return collapsePathSegments(`${docPath.substring(0, lastSeparator)}${separator}${src}`);
}

/** 预览用的图片 src：本地文件转 asset 协议，URL / attachment: 原样返回 */
export function resolveMarkdownImageSrc(rawSrc: string, docPath?: string | null): string {
  if (/^(https?|data|blob|asset|attachment):/i.test(rawSrc.trim())) return rawSrc;
  const absolute = resolveMarkdownImagePath(rawSrc, docPath);
  return absolute ? convertFileSrc(absolute) : rawSrc;
}

export function parseMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const lines = markdown.split(/\r?\n/);
  const nextId = createMarkdownHeadingIdFactory();
  const headings: MarkdownHeading[] = [];
  let activeFence: string | null = null;

  lines.forEach((line, index) => {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!activeFence) {
        activeFence = marker;
      } else if (activeFence === marker) {
        activeFence = null;
      }
      return;
    }

    if (activeFence) {
      return;
    }

    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) {
      return;
    }

    const text = normalizeHeadingText(match[2]);
    if (!text) {
      return;
    }

    const lineNumber = index + 1;
    headings.push({
      id: nextId(text, lineNumber),
      level: match[1].length,
      text,
      line: lineNumber,
    });
  });

  return headings;
}

export function extractTextFromReactNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(extractTextFromReactNode).join("");
  }

  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractTextFromReactNode(node.props.children);
  }

  return "";
}
