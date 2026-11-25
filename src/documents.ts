import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { LingerApiError, LingerClient } from "./client.js";
import type {
  DocumentMetadata,
  LingerMcpConfig,
  Message,
  ReplyDocumentRef,
  ReplyDocumentSummary,
  ReplyHtmlFragment,
} from "./types.js";

const MAX_AUTO_INLINE_DOCS = 5;

const TEXT_APPLICATION_MEDIA_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/sql",
  "application/csv",
]);

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".tsv",
  ".html",
  ".htm",
  ".xml",
  ".svg",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ini",
  ".cfg",
  ".log",
  ".css",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".zip",
  ".gz",
  ".tar",
  ".tgz",
  ".7z",
  ".mp3",
  ".mp4",
  ".mov",
  ".wav",
  ".exe",
  ".bin",
]);

const NATIVE_TEXT_FORMATS = new Set(["markdown", "plain_text", "html"]);

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Slices UTF-16 strings without splitting surrogate pairs across pagination boundaries.
 */
export function sliceUtf16Safe(
  text: string,
  offset: number,
  maxChars: number
): {
  content: string;
  returnedChars: number;
  totalChars: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | undefined;
} {
  const totalChars = text.length;
  let safeOffset = Math.max(0, Math.min(offset, totalChars));
  if (
    safeOffset > 0 &&
    safeOffset < totalChars &&
    isLowSurrogate(text.charCodeAt(safeOffset)) &&
    isHighSurrogate(text.charCodeAt(safeOffset - 1))
  ) {
    safeOffset++;
  }

  let end = Math.min(totalChars, safeOffset + Math.max(1, maxChars));
  if (end < totalChars && end > safeOffset && isHighSurrogate(text.charCodeAt(end - 1))) {
    if (end - 1 > safeOffset) {
      end -= 1;
    } else {
      end += 1;
    }
  }

  const content = text.slice(safeOffset, end);
  const hasMore = end < totalChars;
  return {
    content,
    returnedChars: content.length,
    totalChars,
    offset: safeOffset,
    hasMore,
    nextOffset: hasMore ? end : undefined,
  };
}

export function extractMessageDocumentRefs(msg: Message): ReplyDocumentRef[] {
  const byId = new Map<string, ReplyDocumentRef>();

  const upsert = (incoming: ReplyDocumentRef) => {
    const existing = byId.get(incoming.document_id);
    if (!existing) {
      byId.set(incoming.document_id, { ...incoming });
      return;
    }
    byId.set(incoming.document_id, {
      ...existing,
      document_version_id: existing.document_version_id ?? incoming.document_version_id,
      presentation: existing.presentation ?? incoming.presentation,
      filename: existing.filename ?? incoming.filename,
      media_type: existing.media_type ?? incoming.media_type,
      size_bytes: existing.size_bytes ?? incoming.size_bytes,
      title: existing.title || incoming.title,
    });
  };

  for (const segment of msg.segments ?? []) {
    if (!segment || typeof segment !== "object") {
      continue;
    }
    if (segment.type === "document" && typeof segment.document_id === "string" && segment.document_id) {
      const pres = segment.presentation;
      upsert({
        document_id: segment.document_id,
        title: typeof segment.content === "string" && segment.content ? segment.content : segment.document_id,
        source_type: "document",
        presentation: pres === "inline" || pres === "card" || pres === "canvas" ? pres : undefined,
      });
    } else if (segment.type === "file" && typeof segment.document_id === "string" && segment.document_id) {
      const filename = typeof segment.filename === "string" && segment.filename ? segment.filename : undefined;
      upsert({
        document_id: segment.document_id,
        document_version_id:
          typeof segment.document_version_id === "string" ? segment.document_version_id : undefined,
        title: filename ?? (typeof segment.content === "string" && segment.content ? segment.content : segment.document_id),
        source_type: "file",
        filename,
        media_type: typeof segment.media_type === "string" ? segment.media_type : undefined,
      });
    } else if (
      segment.type === "artifact_tree" &&
      typeof segment.entry_document_id === "string" &&
      segment.entry_document_id
    ) {
      upsert({
        document_id: segment.entry_document_id,
        document_version_id:
          typeof segment.entry_document_version_id === "string" ? segment.entry_document_version_id : undefined,
        title:
          typeof segment.root_path === "string" && segment.root_path
            ? segment.root_path
            : typeof segment.content === "string" && segment.content
              ? segment.content
              : segment.entry_document_id,
        source_type: "artifact_tree",
      });
    }
  }

  for (const attachment of msg.attachments ?? []) {
    if (!attachment?.document_id) {
      continue;
    }
    upsert({
      document_id: attachment.document_id,
      document_version_id: attachment.document_version_id,
      title: attachment.filename || attachment.document_id,
      source_type: "attachment",
      filename: attachment.filename,
      media_type: attachment.media_type,
      size_bytes: attachment.size_bytes,
    });
  }

  return [...byId.values()];
}

export function extractMessageHtmlFragments(msg: Message, maxChars: number): ReplyHtmlFragment[] {
  const fragments: ReplyHtmlFragment[] = [];
  for (const segment of msg.segments ?? []) {
    if (segment?.type === "html_fragment" && typeof segment.html === "string") {
      const sliced = sliceUtf16Safe(segment.html, 0, maxChars);
      fragments.push({
        title: typeof segment.content === "string" && segment.content ? segment.content : "fragment",
        html: sliced.content,
        truncated: sliced.hasMore,
      });
    }
  }
  return fragments;
}

export function isTextLikeDocument(params: {
  mediaType?: string;
  format?: string;
  representationFormat?: string;
  filename?: string;
  bytes: Buffer;
}): boolean {
  const sample = params.bytes.subarray(0, Math.min(params.bytes.length, 8192));
  if (sample.includes(0)) {
    return false;
  }

  const ext = params.filename ? extname(params.filename).toLowerCase() : "";
  if (ext && BINARY_EXTENSIONS.has(ext)) {
    return false;
  }

  const mediaType = (params.mediaType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (
    mediaType.startsWith("text/") ||
    TEXT_APPLICATION_MEDIA_TYPES.has(mediaType) ||
    mediaType.endsWith("+json") ||
    mediaType.endsWith("+xml")
  ) {
    return true;
  }

  const rep = params.representationFormat?.trim().toLowerCase() ?? "";
  const fmt = params.format?.trim().toLowerCase() ?? "";
  if (NATIVE_TEXT_FORMATS.has(rep) || NATIVE_TEXT_FORMATS.has(fmt) || TEXT_EXTENSIONS.has(ext)) {
    return isValidUtf8Sample(sample);
  }

  if (mediaType === "" || mediaType === "application/octet-stream") {
    return params.bytes.length > 0 && TEXT_EXTENSIONS.has(ext) && isValidUtf8Sample(sample);
  }

  return false;
}

function isValidUtf8Sample(sample: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeDownloadFilename(rawName: string, documentId: string): string {
  const docPrefix = documentId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 36) || "doc";
  const lastSegment = rawName.split(/[/\\]/).pop() ?? "";
  const cleaned = lastSegment
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[/:*?"<>|\\]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "");

  const base = cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "document";
  const combined = `${docPrefix}-${base}`;
  if (combined.length <= 180) {
    return combined;
  }
  const ext = extname(base).slice(0, 24);
  const stemLimit = Math.max(16, 180 - docPrefix.length - 1 - ext.length);
  const stem = base.slice(0, Math.max(1, base.length - ext.length)).slice(0, stemLimit);
  return `${docPrefix}-${stem}${ext}`;
}

export async function saveDownloadedFile(
  downloadDir: string,
  documentId: string,
  preferredName: string,
  bytes: Buffer
): Promise<string> {
  await mkdir(downloadDir, { recursive: true, mode: 0o700 });
  const dirStat = await lstat(downloadDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`Refusing download directory that is not a real directory: ${downloadDir}`);
  }
  if ((dirStat.mode & 0o077) !== 0) {
    await chmod(downloadDir, 0o700);
  }

  const rootResolved = resolve(downloadDir);
  const safeName = sanitizeDownloadFilename(preferredName, documentId);
  const ext = extname(safeName);
  const stem = ext ? safeName.slice(0, safeName.length - ext.length) : safeName;

  for (let attempt = 0; attempt < 4; attempt++) {
    const candidateName =
      attempt === 0 ? safeName : `${stem}-${randomBytes(4).toString("hex")}${ext}`;
    const targetPath = resolve(rootResolved, candidateName);
    if (!targetPath.startsWith(rootResolved + sep)) {
      throw new Error("Resolved download path escaped target directory");
    }
    try {
      await writeFile(targetPath, bytes, { flag: "wx", mode: 0o600 });
      return targetPath;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Unable to create unique file for ${safeName} in ${downloadDir}`);
}

export function validateDocumentId(documentId: string): string {
  const trimmed = documentId.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..") || /[\x00-\x1f\x7f?#]/.test(trimmed)) {
    throw new Error(`Invalid document_id: "${documentId}"`);
  }
  return trimmed;
}

export async function readDocument(
  client: LingerClient,
  config: LingerMcpConfig,
  input: {
    documentId: string;
    documentVersionId?: string;
    offset?: number;
    maxChars?: number;
    saveToFile?: boolean;
  }
): Promise<Record<string, unknown>> {
  const documentId = validateDocumentId(input.documentId);
  const meta: DocumentMetadata = await client.getDocument(documentId);
  if (meta.status !== "active") {
    throw new Error(`Document "${meta.id}" is ${meta.status} and cannot be read`);
  }
  if (!meta.capabilities.read) {
    throw new Error(`Read access is not permitted for Document "${meta.id}"`);
  }

  const versionId = input.documentVersionId?.trim() || undefined;
  const download = versionId
    ? await client.downloadDocumentVersion(versionId, config.documentMaxDownloadBytes)
    : await client.downloadLatestDocument(meta.id, config.documentMaxDownloadBytes);

  const preferredName = download.filename !== "document" ? download.filename : meta.title || meta.id;
  const savedPath = input.saveToFile
    ? await saveDownloadedFile(config.downloadDir, meta.id, preferredName, download.bytes)
    : undefined;

  const textLike = isTextLikeDocument({
    mediaType: download.media_type,
    format: meta.format,
    representationFormat: meta.representation_format,
    filename: preferredName,
    bytes: download.bytes,
  });

  if (!textLike) {
    return {
      document_id: meta.id,
      ...(versionId ? { document_version_id: versionId } : meta.current_version ? { document_version_id: meta.current_version.id } : {}),
      title: meta.title,
      format: meta.format,
      representation_format: meta.representation_format,
      filename: download.filename,
      media_type: download.media_type,
      size_bytes: download.size_bytes,
      ...(download.sha256 ? { sha256: download.sha256 } : {}),
      is_binary: true,
      ...(savedPath
        ? { saved_path: savedPath }
        : {
            message:
              "Binary file cannot be rendered as UTF-8 text. Call linger_read_document with save_to_file=true to save it locally.",
          }),
    };
  }

  const fullText = download.bytes.toString("utf8");
  const maxChars = Math.max(256, Math.min(200_000, input.maxChars ?? config.inlineDocumentMaxChars));
  const slice = sliceUtf16Safe(fullText, input.offset ?? 0, maxChars);

  return {
    document_id: meta.id,
    ...(versionId ? { document_version_id: versionId } : meta.current_version ? { document_version_id: meta.current_version.id } : {}),
    title: meta.title,
    format: meta.format,
    representation_format: meta.representation_format,
    filename: download.filename,
    media_type: download.media_type,
    size_bytes: download.size_bytes,
    ...(download.sha256 ? { sha256: download.sha256 } : {}),
    is_binary: false,
    offset: slice.offset,
    returned_chars: slice.returnedChars,
    total_chars: slice.totalChars,
    has_more: slice.hasMore,
    ...(slice.nextOffset !== undefined ? { next_offset: slice.nextOffset } : {}),
    content: slice.content,
    ...(savedPath ? { saved_path: savedPath } : {}),
  };
}

export async function hydrateReplyDocuments(
  client: LingerClient,
  config: LingerMcpConfig,
  refs: ReplyDocumentRef[],
  cache: Map<string, ReplyDocumentSummary>
): Promise<ReplyDocumentSummary[]> {
  if (refs.length === 0) {
    return [];
  }

  const totalCharBudget = Math.max(config.inlineDocumentMaxChars * 2, 65_536);
  const autoInlineMaxBytes = Math.min(
    config.documentMaxDownloadBytes,
    Math.max(config.inlineDocumentMaxChars * 6, 524_288)
  );

  let remainingBudget = totalCharBudget;
  let hydratedCount = 0;
  const results: ReplyDocumentSummary[] = [];

  for (const ref of refs) {
    const cacheKey = `${ref.document_id}:${ref.document_version_id ?? "latest"}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.status !== "error") {
      if (cached.returned_chars) {
        remainingBudget = Math.max(0, remainingBudget - cached.returned_chars);
      }
      if (cached.status === "inlined" || cached.status === "truncated") {
        hydratedCount++;
      }
      results.push(cached);
      continue;
    }

    const base: Omit<ReplyDocumentSummary, "status"> = {
      document_id: ref.document_id,
      ...(ref.document_version_id ? { document_version_id: ref.document_version_id } : {}),
      title: ref.title,
      source_type: ref.source_type,
      ...(ref.presentation ? { presentation: ref.presentation } : {}),
      ...(ref.filename ? { filename: ref.filename } : {}),
      ...(ref.media_type ? { media_type: ref.media_type } : {}),
      ...(ref.size_bytes !== undefined ? { size_bytes: ref.size_bytes } : {}),
    };

    if (!config.autoInlineDocuments) {
      results.push({ ...base, status: "skipped", error: "Auto-inlining disabled; call linger_read_document." });
      continue;
    }

    if (hydratedCount >= MAX_AUTO_INLINE_DOCS || remainingBudget <= 0) {
      results.push({
        ...base,
        status: "skipped",
        error: "Auto-inline budget exceeded; call linger_read_document to inspect this document.",
      });
      continue;
    }

    if (ref.size_bytes !== undefined && ref.size_bytes > autoInlineMaxBytes) {
      const skipped: ReplyDocumentSummary = {
        ...base,
        status: "skipped",
        error: `Document (${ref.size_bytes} bytes) exceeds auto-inline limit; call linger_read_document.`,
      };
      cache.set(cacheKey, skipped);
      results.push(skipped);
      continue;
    }

    try {
      const meta = await client.getDocument(ref.document_id);
      if (meta.status !== "active" || !meta.capabilities.read) {
        const skipped: ReplyDocumentSummary = {
          ...base,
          title: meta.title || ref.title,
          format: meta.format,
          representation_format: meta.representation_format,
          status: "skipped",
          error: meta.status !== "active" ? `Document status is ${meta.status}` : "Read capability not granted",
        };
        cache.set(cacheKey, skipped);
        results.push(skipped);
        continue;
      }

      const download = ref.document_version_id
        ? await client.downloadDocumentVersion(ref.document_version_id, autoInlineMaxBytes)
        : await client.downloadLatestDocument(meta.id, autoInlineMaxBytes);

      const textLike = isTextLikeDocument({
        mediaType: download.media_type,
        format: meta.format,
        representationFormat: meta.representation_format,
        filename: download.filename !== "document" ? download.filename : ref.filename,
        bytes: download.bytes,
      });

      if (!textLike) {
        const binarySummary: ReplyDocumentSummary = {
          ...base,
          title: meta.title || ref.title,
          format: meta.format,
          representation_format: meta.representation_format,
          filename: download.filename,
          media_type: download.media_type,
          size_bytes: download.size_bytes,
          status: "binary",
        };
        cache.set(cacheKey, binarySummary);
        results.push(binarySummary);
        continue;
      }

      const fullText = download.bytes.toString("utf8");
      const maxCharsThisDoc = Math.min(config.inlineDocumentMaxChars, remainingBudget);
      const slice = sliceUtf16Safe(fullText, 0, maxCharsThisDoc);
      remainingBudget = Math.max(0, remainingBudget - slice.returnedChars);
      hydratedCount++;

      const summary: ReplyDocumentSummary = {
        ...base,
        ...(meta.current_version && !ref.document_version_id ? { document_version_id: meta.current_version.id } : {}),
        title: meta.title || ref.title,
        format: meta.format,
        representation_format: meta.representation_format,
        filename: download.filename,
        media_type: download.media_type,
        size_bytes: download.size_bytes,
        status: slice.hasMore ? "truncated" : "inlined",
        total_chars: slice.totalChars,
        returned_chars: slice.returnedChars,
        content: slice.content,
        has_more: slice.hasMore,
        ...(slice.nextOffset !== undefined ? { next_offset: slice.nextOffset } : {}),
      };
      cache.set(cacheKey, summary);
      results.push(summary);
    } catch (err) {
      if (err instanceof LingerApiError && err.code === "DOCUMENT_TOO_LARGE") {
        const skipped: ReplyDocumentSummary = {
          ...base,
          status: "skipped",
          error: "Document exceeds auto-inline size limit; call linger_read_document to paginate or save locally.",
        };
        cache.set(cacheKey, skipped);
        results.push(skipped);
        continue;
      }
      // Do not cache transient errors so subsequent linger_get_reply calls can retry.
      results.push({
        ...base,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
