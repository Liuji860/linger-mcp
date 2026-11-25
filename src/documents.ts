import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { LingerApiError, LingerClient } from "./client.js";
import type {
  CachedDocumentEntry,
  DocumentDownloadResult,
  DocumentMetadata,
  LingerMcpConfig,
  Message,
  ReplyDocumentRef,
  ReplyDocumentSummary,
  ReplyHtmlFragment,
} from "./types.js";

const MAX_AUTO_INLINE_DOCS = 5;
const MAX_HTML_FRAGMENTS_PER_SNAPSHOT = 10;
const ENTITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

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
  const normalizedOffset = Number.isFinite(offset) ? Math.trunc(offset) : 0;
  const normalizedMax = Number.isFinite(maxChars) ? Math.trunc(maxChars) : 0;

  let safeOffset = Math.max(0, Math.min(normalizedOffset, totalChars));
  if (
    safeOffset > 0 &&
    safeOffset < totalChars &&
    isLowSurrogate(text.charCodeAt(safeOffset)) &&
    isHighSurrogate(text.charCodeAt(safeOffset - 1))
  ) {
    safeOffset++;
  }

  if (normalizedMax <= 0 || safeOffset >= totalChars) {
    const hasMore = safeOffset < totalChars;
    return {
      content: "",
      returnedChars: 0,
      totalChars,
      offset: safeOffset,
      hasMore,
      nextOffset: hasMore ? safeOffset : undefined,
    };
  }

  let end = Math.min(totalChars, safeOffset + normalizedMax);
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

export function documentRefKey(ref: Pick<ReplyDocumentRef, "document_id" | "document_version_id">): string {
  return `${ref.document_id}:${ref.document_version_id ?? "latest"}`;
}

function mergeRefPair(existing: ReplyDocumentRef, incoming: ReplyDocumentRef): ReplyDocumentRef {
  const merged: ReplyDocumentRef = {
    ...existing,
    document_version_id: existing.document_version_id ?? incoming.document_version_id,
    presentation: existing.presentation ?? incoming.presentation,
    filename: existing.filename ?? incoming.filename,
    media_type: existing.media_type ?? incoming.media_type,
    size_bytes: existing.size_bytes ?? incoming.size_bytes,
    title:
      existing.title && existing.title !== existing.document_id
        ? existing.title
        : incoming.title || existing.title,
  };
  if (existing.unavailable || incoming.unavailable) {
    merged.unavailable = true;
  }
  return merged;
}

/**
 * Merges document refs keyed by document_id + version while preserving original order.
 */
export function mergeDocumentRefs(refs: ReplyDocumentRef[]): ReplyDocumentRef[] {
  const entries: ReplyDocumentRef[] = [];
  const indexByKey = new Map<string, number>();
  const unversionedIndexByDocId = new Map<string, number>();

  for (const incoming of refs) {
    const key = documentRefKey(incoming);
    if (incoming.source_type === "attachment" && incoming.document_version_id && !indexByKey.has(key)) {
      const unversionedIdx = unversionedIndexByDocId.get(incoming.document_id);
      if (unversionedIdx !== undefined) {
        const prev = entries[unversionedIdx]!;
        indexByKey.delete(documentRefKey(prev));
        indexByKey.set(key, unversionedIdx);
        unversionedIndexByDocId.delete(incoming.document_id);
        entries[unversionedIdx] = mergeRefPair(prev, incoming);
        continue;
      }
    }

    const existingIdx = indexByKey.get(key);
    if (existingIdx !== undefined) {
      entries[existingIdx] = mergeRefPair(entries[existingIdx]!, incoming);
      continue;
    }

    const nextIdx = entries.length;
    entries.push({ ...incoming });
    indexByKey.set(key, nextIdx);
    if (!incoming.document_version_id) {
      unversionedIndexByDocId.set(incoming.document_id, nextIdx);
    }
  }

  return entries;
}

export function extractMessageDocumentRefs(msg: Message): ReplyDocumentRef[] {
  const collected: ReplyDocumentRef[] = [];

  for (const segment of msg.segments ?? []) {
    if (!segment || typeof segment !== "object") {
      continue;
    }
    if (segment.type === "document" && typeof segment.document_id === "string" && segment.document_id) {
      const pres = segment.presentation;
      collected.push({
        document_id: segment.document_id,
        title: typeof segment.content === "string" && segment.content ? segment.content : segment.document_id,
        source_type: "document",
        presentation: pres === "inline" || pres === "card" || pres === "canvas" ? pres : undefined,
      });
    } else if (segment.type === "file" && typeof segment.document_id === "string" && segment.document_id) {
      const filename = typeof segment.filename === "string" && segment.filename ? segment.filename : undefined;
      collected.push({
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
      collected.push({
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
    collected.push({
      document_id: attachment.document_id,
      document_version_id: attachment.document_version_id,
      title: attachment.filename || attachment.document_id,
      source_type: "attachment",
      filename: attachment.filename,
      media_type: attachment.media_type,
      size_bytes: attachment.size_bytes,
      ...(attachment.available === false ? { unavailable: true } : {}),
    });
  }

  return mergeDocumentRefs(collected);
}

export function extractMessageHtmlFragments(msg: Message, maxChars: number): ReplyHtmlFragment[] {
  const fragments: ReplyHtmlFragment[] = [];
  for (const segment of msg.segments ?? []) {
    if (segment?.type === "html_fragment" && typeof segment.html === "string") {
      if (fragments.length >= MAX_HTML_FRAGMENTS_PER_SNAPSHOT) {
        break;
      }
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

export function extractBoundedMessageHtmlFragments(
  messages: Message[],
  maxPerDocChars: number
): Map<string, ReplyHtmlFragment[]> {
  const byMessageId = new Map<string, ReplyHtmlFragment[]>();
  let remainingBudget = Math.max(maxPerDocChars * 2, 65_536);
  let remainingCount = MAX_HTML_FRAGMENTS_PER_SNAPSHOT;

  for (const msg of messages) {
    const out: ReplyHtmlFragment[] = [];
    for (const segment of msg.segments ?? []) {
      if (segment?.type !== "html_fragment" || typeof segment.html !== "string") {
        continue;
      }
      if (remainingCount <= 0 || remainingBudget <= 0) {
        out.push({
          title: typeof segment.content === "string" && segment.content ? segment.content : "fragment",
          html: "",
          truncated: true,
        });
        continue;
      }
      const limit = Math.min(maxPerDocChars, remainingBudget);
      const sliced = sliceUtf16Safe(segment.html, 0, limit);
      remainingBudget = Math.max(0, remainingBudget - sliced.returnedChars);
      remainingCount--;
      out.push({
        title: typeof segment.content === "string" && segment.content ? segment.content : "fragment",
        html: sliced.content,
        truncated: sliced.hasMore || sliced.returnedChars < segment.html.length,
      });
    }
    byMessageId.set(msg.id, out);
  }
  return byMessageId;
}

function isValidUtf8Sample(sample: Buffer, hasMoreBytes: boolean): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: hasMoreBytes });
    return true;
  } catch {
    return false;
  }
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
  const hasMoreBytes = params.bytes.length > sample.length;

  const rep = params.representationFormat?.trim().toLowerCase() ?? "";
  const fmt = params.format?.trim().toLowerCase() ?? "";
  if (NATIVE_TEXT_FORMATS.has(rep) || NATIVE_TEXT_FORMATS.has(fmt)) {
    return isValidUtf8Sample(sample, hasMoreBytes);
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
    return isValidUtf8Sample(sample, hasMoreBytes);
  }

  if (mediaType === "" || mediaType === "application/octet-stream") {
    return params.bytes.length > 0 && TEXT_EXTENSIONS.has(ext) && isValidUtf8Sample(sample, hasMoreBytes);
  }

  return false;
}

export function sanitizeDisplayFilename(rawName: string): string | undefined {
  const lastSegment = rawName.split(/[/\\]/).pop() ?? "";
  const cleaned = lastSegment
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  return cleaned || undefined;
}

export function sanitizeDownloadFilename(rawName: string, documentId: string): string {
  const docPrefix = documentId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 36) || "doc";
  const display = sanitizeDisplayFilename(rawName) ?? "";
  const cleaned = display
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
  // Resolve first so trailing slashes cannot dereference a symlinked directory on lstat().
  const rootResolved = resolve(downloadDir);
  await mkdir(rootResolved, { recursive: true, mode: 0o700 });

  const dirStat = await lstat(rootResolved);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`Refusing download directory that is not a real directory: ${rootResolved}`);
  }
  if (typeof process.getuid === "function" && dirStat.uid !== process.getuid()) {
    throw new Error(`Refusing download directory not owned by current user: ${rootResolved}`);
  }
  if ((dirStat.mode & 0o077) !== 0) {
    await chmod(rootResolved, 0o700);
  }

  const safeName = sanitizeDownloadFilename(preferredName, documentId);
  const ext = extname(safeName);
  const stem = ext ? safeName.slice(0, safeName.length - ext.length) : safeName;
  const openFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

  for (let attempt = 0; attempt < 4; attempt++) {
    const candidateName =
      attempt === 0 ? safeName : `${stem}-${randomBytes(4).toString("hex")}${ext}`;
    const targetPath = resolve(rootResolved, candidateName);
    if (!targetPath.startsWith(rootResolved + sep)) {
      throw new Error("Resolved download path escaped target directory");
    }
    try {
      const handle = await open(targetPath, openFlags, 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      return targetPath;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Unable to create unique file for ${safeName} in ${rootResolved}`);
}

export function validateEntityId(rawId: string, label: string = "document_id"): string {
  const trimmed = rawId.trim();
  if (!ENTITY_ID_RE.test(trimmed)) {
    throw new Error(`Invalid ${label}: "${rawId}"`);
  }
  return trimmed;
}

export function validateDocumentId(documentId: string): string {
  return validateEntityId(documentId, "document_id");
}

async function downloadAuthorizedDocumentContent(
  client: LingerClient,
  meta: DocumentMetadata,
  versionId: string | undefined,
  maxBytes: number
): Promise<{ download: DocumentDownloadResult; resolvedVersionId?: string }> {
  if (versionId) {
    if (meta.current_version?.id !== versionId) {
      const versionMeta = await client.getDocumentVersion(versionId);
      if (versionMeta.document_id !== meta.id) {
        throw new Error(`Version "${versionId}" does not belong to Document "${meta.id}"`);
      }
    }
    return {
      download: await client.downloadDocumentVersion(versionId, maxBytes),
      resolvedVersionId: versionId,
    };
  }

  if (!meta.capabilities.export) {
    // Wiki pages and read-only versioned docs set export=false but still permit version content reads.
    if (meta.current_version?.id) {
      return {
        download: await client.downloadDocumentVersion(meta.current_version.id, maxBytes),
        resolvedVersionId: meta.current_version.id,
      };
    }
    throw new LingerApiError(403, "EXPORT_FORBIDDEN", `Export capability is not granted for Document "${meta.id}"`);
  }

  return {
    download: await client.downloadLatestDocument(meta.id, maxBytes),
    resolvedVersionId: meta.current_version?.id,
  };
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
  const documentId = validateEntityId(input.documentId, "document_id");
  const versionId = input.documentVersionId !== undefined
    ? validateEntityId(input.documentVersionId, "document_version_id")
    : undefined;

  const meta: DocumentMetadata = await client.getDocument(documentId);
  if (meta.status !== "active") {
    throw new Error(`Document "${meta.id}" is ${meta.status} and cannot be read`);
  }
  if (!meta.capabilities.read) {
    throw new Error(`Read access is not permitted for Document "${meta.id}"`);
  }

  const { download, resolvedVersionId } = await downloadAuthorizedDocumentContent(
    client,
    meta,
    versionId,
    config.documentMaxDownloadBytes
  );

  const safeResponseName = download.filename ? sanitizeDisplayFilename(download.filename) : undefined;
  const preferredName = safeResponseName ?? sanitizeDisplayFilename(meta.title) ?? meta.id;
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
      ...(resolvedVersionId ? { document_version_id: resolvedVersionId } : {}),
      title: meta.title,
      format: meta.format,
      representation_format: meta.representation_format,
      filename: preferredName,
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
    ...(resolvedVersionId ? { document_version_id: resolvedVersionId } : {}),
    title: meta.title,
    format: meta.format,
    representation_format: meta.representation_format,
    filename: preferredName,
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
  cache: Map<string, CachedDocumentEntry>
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
    const cacheKey = documentRefKey(ref);
    const displayFilename = ref.filename ? sanitizeDisplayFilename(ref.filename) : undefined;
    const base: Omit<ReplyDocumentSummary, "status"> = {
      document_id: ref.document_id,
      ...(ref.document_version_id ? { document_version_id: ref.document_version_id } : {}),
      title: ref.title,
      source_type: ref.source_type,
      ...(ref.presentation ? { presentation: ref.presentation } : {}),
      ...(displayFilename ? { filename: displayFilename } : {}),
      ...(ref.media_type ? { media_type: ref.media_type } : {}),
      ...(ref.size_bytes !== undefined ? { size_bytes: ref.size_bytes } : {}),
    };

    try {
      validateEntityId(ref.document_id, "document_id");
      if (ref.document_version_id !== undefined) {
        validateEntityId(ref.document_version_id, "document_version_id");
      }
    } catch (err) {
      results.push({
        ...base,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (ref.unavailable) {
      results.push({
        ...base,
        status: "skipped",
        error: "Attachment bytes are not available.",
      });
      continue;
    }

    if (!config.autoInlineDocuments) {
      results.push({ ...base, status: "skipped", error: "Auto-inlining disabled; call linger_read_document." });
      continue;
    }

    const existing = cache.get(cacheKey);
    if (existing?.immutable) {
      const { summary } = existing;
      if ((summary.status === "inlined" || summary.status === "truncated") && (hydratedCount >= MAX_AUTO_INLINE_DOCS || remainingBudget <= 0)) {
        results.push({
          ...base,
          status: "skipped",
          error: "Auto-inline budget exceeded; call linger_read_document to inspect this document.",
        });
        continue;
      }
      if (summary.returned_chars) {
        remainingBudget = Math.max(0, remainingBudget - summary.returned_chars);
      }
      if (summary.status === "inlined" || summary.status === "truncated") {
        hydratedCount++;
      }
      results.push(summary);
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
      cache.set(cacheKey, { summary: skipped, maxChars: 0, immutable: true });
      results.push(skipped);
      continue;
    }

    try {
      const meta = await client.getDocument(ref.document_id);
      if (meta.status !== "active" || !meta.capabilities.read) {
        results.push({
          ...base,
          title: meta.title || ref.title,
          format: meta.format,
          representation_format: meta.representation_format,
          status: "skipped",
          error: meta.status !== "active" ? `Document status is ${meta.status}` : "Read capability not granted",
        });
        continue;
      }

      const maxCharsThisDoc = Math.min(config.inlineDocumentMaxChars, remainingBudget);
      if (
        existing &&
        !existing.immutable &&
        existing.updatedAt === meta.updated_at &&
        maxCharsThisDoc >= existing.maxChars
      ) {
        if (existing.summary.returned_chars) {
          remainingBudget = Math.max(0, remainingBudget - existing.summary.returned_chars);
        }
        if (existing.summary.status === "inlined" || existing.summary.status === "truncated") {
          hydratedCount++;
        }
        results.push(existing.summary);
        continue;
      }

      const { download, resolvedVersionId } = await downloadAuthorizedDocumentContent(
        client,
        meta,
        ref.document_version_id,
        autoInlineMaxBytes
      );

      const safeFilename =
        (download.filename ? sanitizeDisplayFilename(download.filename) : undefined) ??
        displayFilename ??
        sanitizeDisplayFilename(meta.title) ??
        meta.id;

      const textLike = isTextLikeDocument({
        mediaType: download.media_type,
        format: meta.format,
        representationFormat: meta.representation_format,
        filename: safeFilename,
        bytes: download.bytes,
      });

      const isImmutable = Boolean(ref.document_version_id) || meta.draft_capability === "none";

      if (!textLike) {
        const binarySummary: ReplyDocumentSummary = {
          ...base,
          ...(resolvedVersionId ? { document_version_id: resolvedVersionId } : {}),
          title: meta.title || ref.title,
          format: meta.format,
          representation_format: meta.representation_format,
          filename: safeFilename,
          media_type: download.media_type,
          size_bytes: download.size_bytes,
          status: "binary",
        };
        cache.set(cacheKey, {
          summary: binarySummary,
          updatedAt: meta.updated_at,
          maxChars: 0,
          immutable: isImmutable,
        });
        results.push(binarySummary);
        continue;
      }

      const fullText = download.bytes.toString("utf8");
      const slice = sliceUtf16Safe(fullText, 0, maxCharsThisDoc);
      remainingBudget = Math.max(0, remainingBudget - slice.returnedChars);
      hydratedCount++;

      const summary: ReplyDocumentSummary = {
        ...base,
        ...(resolvedVersionId ? { document_version_id: resolvedVersionId } : {}),
        title: meta.title || ref.title,
        format: meta.format,
        representation_format: meta.representation_format,
        filename: safeFilename,
        media_type: download.media_type,
        size_bytes: download.size_bytes,
        status: slice.hasMore ? "truncated" : "inlined",
        total_chars: slice.totalChars,
        returned_chars: slice.returnedChars,
        content: slice.content,
        has_more: slice.hasMore,
        ...(slice.nextOffset !== undefined ? { next_offset: slice.nextOffset } : {}),
      };
      cache.set(cacheKey, {
        summary,
        updatedAt: meta.updated_at,
        maxChars: maxCharsThisDoc,
        immutable: isImmutable,
      });
      results.push(summary);
    } catch (err) {
      if (err instanceof LingerApiError && err.code === "DOCUMENT_TOO_LARGE") {
        const skipped: ReplyDocumentSummary = {
          ...base,
          status: "skipped",
          error: "Document exceeds auto-inline size limit; call linger_read_document to paginate or save locally.",
        };
        cache.set(cacheKey, { summary: skipped, maxChars: 0, immutable: true });
        results.push(skipped);
        continue;
      }
      if (err instanceof LingerApiError && err.code === "EXPORT_FORBIDDEN") {
        results.push({
          ...base,
          status: "skipped",
          error: err.message,
        });
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
