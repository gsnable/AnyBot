import { existsSync, statSync } from "node:fs";
import path from "node:path";

import type { ReplyPayload, TextMessageContent, ImageMessageContent, FileMessageContent } from "./types.js";

export function parseIncomingText(content: string): string {
  try {
    const parsed = JSON.parse(content) as TextMessageContent;
    return (parsed.text || "").trim();
  } catch {
    return content.trim();
  }
}

export function sanitizeUserText(text: string): string {
  return text.replace(/<at[^>]*>.*?<\/at>/g, "").trim();
}

export function parseIncomingImageKey(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as ImageMessageContent;
    return parsed.image_key?.trim() || null;
  } catch {
    return null;
  }
}

export function parseIncomingFileKey(content: string): { key: string; name: string } | null {
  try {
    const parsed = JSON.parse(content) as FileMessageContent;
    if (parsed.file_key && parsed.file_name) {
      return { key: parsed.file_key.trim(), name: parsed.file_name.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

export function getImageExtension(contentType?: string): string {
  switch ((contentType || "").split(";")[0].trim().toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/tiff":
      return ".tiff";
    case "image/bmp":
      return ".bmp";
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return ".ico";
    default:
      return ".img";
  }
}

const SUPPORTED_IMAGE_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".tiff", ".tif", ".bmp", ".ico",
]);

export function isSupportedImagePath(filePath: string): boolean {
  return SUPPORTED_IMAGE_EXTS.has(path.extname(filePath).toLowerCase());
}

export function normalizeCandidateImagePath(
  filePath: string,
  workdir: string,
): string | null {
  const normalized = filePath.trim();
  if (!normalized || !isSupportedImagePath(normalized)) {
    return null;
  }

  const resolved = path.isAbsolute(normalized)
    ? normalized
    : path.resolve(workdir, normalized);

  return existsSync(resolved) ? resolved : null;
}

function unwrapPathToken(raw: string): string {
  const trimmed = raw.trim();
  const markdownLinkMatch = trimmed.match(/^\[[^\]]*]\(([^)\n]+)\)$/);
  const value = (markdownLinkMatch?.[1] || trimmed).trim();

  if (
    (value.startsWith("`") && value.endsWith("`")) ||
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function tryResolveExistingFilePath(candidate: string, workdir: string): string | null {
  const resolved = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(workdir, candidate);
  if (!existsSync(resolved)) {
    return null;
  }
  try {
    return statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

export function normalizeCandidateFilePath(filePath: string, workdir: string): string | null {
  const normalized = unwrapPathToken(filePath);
  if (!normalized || isSupportedImagePath(normalized)) {
    return null;
  }

  const direct = tryResolveExistingFilePath(normalized, workdir);
  if (direct) {
    return direct;
  }

  const withoutLine = normalized.replace(/:(\d+)(:\d+)?$/, "");
  if (withoutLine !== normalized) {
    return tryResolveExistingFilePath(withoutLine, workdir);
  }
  return null;
}

export function parseReplyPayload(reply: string, workdir: string): ReplyPayload {
  const imagePaths = new Set<string>();
  const filePaths = new Set<string>();

  const markdownImagePattern = /!\[[^\]]*]\(([^)\n]+)\)/g;
  for (const match of reply.matchAll(markdownImagePattern)) {
    const imagePath = normalizeCandidateImagePath(match[1] || "", workdir);
    if (imagePath) {
      imagePaths.add(imagePath);
    }
  }

  const plainPathPattern =
    /(^|\n)(\.{0,2}\/?[^\s<>"')\]]+\.(?:png|jpe?g|webp|gif|tiff?|bmp|ico))(?=\n|$)/gi;
  for (const match of reply.matchAll(plainPathPattern)) {
    const imagePath = normalizeCandidateImagePath(match[2] || "", workdir);
    if (imagePath) {
      imagePaths.add(imagePath);
    }
  }

  const inlineCodePathPattern = /`([^`\n]+\.(?:png|jpe?g|webp|gif|tiff?|bmp|ico))`/gi;
  for (const match of reply.matchAll(inlineCodePathPattern)) {
    const imagePath = normalizeCandidateImagePath(match[1] || "", workdir);
    if (imagePath) {
      imagePaths.add(imagePath);
    }
  }

  const fileDirectivePattern = /(^|\n)\s*FILE:\s*([^\n]+)(?=\n|$)/gi;
  for (const match of reply.matchAll(fileDirectivePattern)) {
    const filePath = normalizeCandidateFilePath(match[2] || "", workdir);
    if (filePath) {
      filePaths.add(filePath);
    }
  }

  let text = reply.replace(markdownImagePattern, (fullMatch, imgPath: string) => {
    return normalizeCandidateImagePath(imgPath, workdir) ? "" : fullMatch;
  });
  text = text.replace(plainPathPattern, (fullMatch, prefix: string, imgPath: string) => {
    return normalizeCandidateImagePath(imgPath, workdir) ? prefix : fullMatch;
  });
  text = text.replace(inlineCodePathPattern, (fullMatch, imgPath: string) => {
    return normalizeCandidateImagePath(imgPath, workdir) ? "" : fullMatch;
  });
  text = text.replace(fileDirectivePattern, (fullMatch, prefix: string, filePath: string) => {
    return normalizeCandidateFilePath(filePath, workdir) ? prefix : fullMatch;
  });
  text = text.trim();
  text = text.replace(/\n{3,}/g, "\n\n");

  return {
    text,
    imagePaths: [...imagePaths],
    filePaths: [...filePaths],
  };
}
