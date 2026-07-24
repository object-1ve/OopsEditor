import type { ReactNode } from "react";
import { isValidElement } from "react";

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
