import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { LingerClient } from "../src/client.js";
import { LingerApiError } from "../src/client.js";
import { parseConfig } from "../src/config.js";
import {
  extractMessageDocumentRefs,
  extractMessageHtmlFragments,
  hydrateReplyDocuments,
  isTextLikeDocument,
  readDocument,
  sanitizeDownloadFilename,
  saveDownloadedFile,
  sliceUtf16Safe,
  validateDocumentId,
} from "../src/documents.js";
import type { DocumentMetadata, Message, ReplyDocumentSummary } from "../src/types.js";

function makeMessage(partial: Partial<Message>): Message {
  return {
    id: "msg_1",
    tenant_id: "tenant_1",
    room_id: "room_1",
    author: { id: "agent_bk", tenant_id: "tenant_1", kind: "agent", display_name: "bk" },
    message_kind: "conversation",
    raw_message: "summary",
    segments: [],
    attachments: [],
    created_at: new Date().toISOString(),
    ...partial,
  };
}

function makeDocMeta(overrides: Partial<DocumentMetadata> = {}): DocumentMetadata {
  return {
    id: "document_1",
    tenant_id: "tenant_1",
    title: "Research Report",
    format: "native",
    representation_format: "markdown",
    status: "active",
    current_version: null,
    draft_capability: "read",
    can_edit_native_content: true,
    capabilities: {
      read: true,
      write: false,
      manage: false,
      delete: false,
      duplicate: true,
      export: true,
      comment: true,
      use_as_context: true,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

test("extractMessageDocumentRefs deduplicates segments and attachments while merging metadata", () => {
  const msg = makeMessage({
    segments: [
      { type: "text", content: "See report: " },
      { type: "document", content: "Research Brief", document_id: "doc_1", presentation: "card" },
      { type: "file", content: "notes.txt", document_id: "doc_2", document_version_id: "ver_2", filename: "notes.txt", media_type: "text/plain" },
      { type: "artifact_tree", content: "site", publication_group_id: "pg_1", root_path: "/site", file_count: 2, directory_count: 1, total_bytes: 120, entry_document_id: "doc_3", entry_document_version_id: "ver_3" },
      { type: "html_fragment", content: "Chart", html: "<div>hello</div>" },
    ],
    attachments: [
      { id: "att_1", document_id: "doc_1", document_version_id: "ver_1", filename: "brief.md", media_type: "text/markdown", size_bytes: 512, sha256: "a".repeat(64), available: true },
    ],
  });

  const refs = extractMessageDocumentRefs(msg);
  assert.equal(refs.length, 3);
  assert.deepEqual(refs[0], {
    document_id: "doc_1",
    document_version_id: "ver_1",
    title: "Research Brief",
    source_type: "document",
    presentation: "card",
    filename: "brief.md",
    media_type: "text/markdown",
    size_bytes: 512,
  });
  assert.equal(refs[1]?.document_id, "doc_2");
  assert.equal(refs[2]?.document_id, "doc_3");

  const fragments = extractMessageHtmlFragments(msg, 10);
  assert.deepEqual(fragments, [{ title: "Chart", html: "<div>hello", truncated: true }]);
});

test("sliceUtf16Safe paginates without splitting UTF-16 surrogate pairs", () => {
  const text = "A🚀B🚀C"; // Each emoji is 2 UTF-16 code units.
  const first = sliceUtf16Safe(text, 0, 2);
  // Boundary at index 2 falls in the middle of the first emoji surrogate pair; backs up to index 1.
  assert.equal(first.content, "A");
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 1);

  const second = sliceUtf16Safe(text, first.nextOffset!, 2);
  assert.equal(second.content, "🚀");
  assert.equal(second.nextOffset, 3);

  const third = sliceUtf16Safe(text, second.nextOffset!, 10);
  assert.equal(third.content, "B🚀C");
  assert.equal(third.hasMore, false);
  assert.equal(third.nextOffset, undefined);
});

test("isTextLikeDocument separates UTF-8 text from NUL/binary payloads", () => {
  assert.equal(isTextLikeDocument({ mediaType: "text/markdown; charset=utf-8", bytes: Buffer.from("# Title\nBody") }), true);
  assert.equal(isTextLikeDocument({ mediaType: "application/json", bytes: Buffer.from('{"ok":true}') }), true);
  assert.equal(isTextLikeDocument({ representationFormat: "markdown", bytes: Buffer.from("中文正文") }), true);
  assert.equal(isTextLikeDocument({ mediaType: "text/plain", bytes: Buffer.from([0x41, 0x00, 0x42]) }), false);
  assert.equal(isTextLikeDocument({ mediaType: "application/pdf", filename: "report.pdf", bytes: Buffer.from("%PDF-1.7") }), false);
  assert.equal(isTextLikeDocument({ mediaType: "application/octet-stream", filename: "notes.txt", bytes: Buffer.from([0xff, 0xfe]) }), false);
});

test("sanitizeDownloadFilename and saveDownloadedFile enforce traversal safety and 0700/0600 modes", async () => {
  assert.equal(validateDocumentId("document_123-abc"), "document_123-abc");
  assert.throws(() => validateDocumentId("../etc/passwd"), /Invalid document_id/);
  assert.throws(() => validateDocumentId("doc/1"), /Invalid document_id/);

  const sanitized = sanitizeDownloadFilename("../../weird:name?.md\x00", "doc_1/2");
  assert.equal(sanitized.startsWith("doc_1_2-"), true);
  assert.equal(sanitized.includes(".."), false);
  assert.equal(sanitized.includes("/"), false);
  assert.equal(sanitized.endsWith(".md"), true);

  const root = await mkdtemp(join(tmpdir(), "linger-doc-save-"));
  try {
    const dlDir = join(root, "downloads");
    const path1 = await saveDownloadedFile(dlDir, "doc_abc", "../../report.md", Buffer.from("hello"));
    const path2 = await saveDownloadedFile(dlDir, "doc_abc", "../../report.md", Buffer.from("world"));
    assert.notEqual(path1, path2);
    assert.equal(basename(path1), "doc_abc-report.md");
    assert.equal(await readFile(path1, "utf8"), "hello");
    assert.equal(await readFile(path2, "utf8"), "world");

    const dirStat = await stat(dlDir);
    const fileStat = await stat(path1);
    assert.equal(dirStat.mode & 0o777, 0o700);
    assert.equal(fileStat.mode & 0o777, 0o600);

    const realTarget = join(root, "real-dir");
    const linkDir = join(root, "link-dir");
    await mkdir(realTarget);
    await symlink(realTarget, linkDir);
    await assert.rejects(() => saveDownloadedFile(linkDir, "doc_abc", "test.txt", Buffer.from("x")), /not a real directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readDocument and hydrateReplyDocuments handle pagination, caching, budget caps, binary files, and transient errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linger-hydrate-"));
  try {
    const config = parseConfig({
      LINGER_URL: "http://127.0.0.1:3000",
      LINGER_INLINE_DOCUMENT_MAX_CHARS: "1024",
      LINGER_DOWNLOAD_DIR: join(dir, "dl"),
    });

    const docs = new Map<string, { meta: DocumentMetadata; bytes: Buffer; mediaType: string; filename: string }>([
      [
        "doc_small",
        {
          meta: makeDocMeta({ id: "doc_small", title: "Small Doc" }),
          bytes: Buffer.from("# Heading\nConcise findings."),
          mediaType: "text/markdown",
          filename: "small.md",
        },
      ],
      [
        "doc_large",
        {
          meta: makeDocMeta({ id: "doc_large", title: "Large Doc" }),
          bytes: Buffer.from("X".repeat(2500)),
          mediaType: "text/markdown",
          filename: "large.md",
        },
      ],
      [
        "doc_bin",
        {
          meta: makeDocMeta({ id: "doc_bin", title: "diagram.png", format: "file", representation_format: "binary" }),
          bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
          mediaType: "image/png",
          filename: "diagram.png",
        },
      ],
    ]);

    let failOnce = true;
    let smallFetchCount = 0;
    const mockClient = {
      async getDocument(id: string) {
        if (id === "doc_flaky" && failOnce) {
          failOnce = false;
          throw new LingerApiError(503, "UNAVAILABLE", "temporary outage");
        }
        if (id === "doc_flaky") {
          return makeDocMeta({ id: "doc_flaky", title: "Recovered Doc" });
        }
        const entry = docs.get(id);
        if (!entry) {
          throw new LingerApiError(404, "NOT_FOUND", "missing");
        }
        return entry.meta;
      },
      async downloadLatestDocument(id: string) {
        if (id === "doc_small") smallFetchCount++;
        if (id === "doc_flaky") {
          return { filename: "flaky.md", media_type: "text/markdown", size_bytes: 9, bytes: Buffer.from("recovered") };
        }
        const entry = docs.get(id)!;
        return {
          filename: entry.filename,
          media_type: entry.mediaType,
          size_bytes: entry.bytes.length,
          bytes: entry.bytes,
        };
      },
      async downloadDocumentVersion() {
        throw new Error("not used");
      },
    } as unknown as LingerClient;

    const cache = new Map<string, ReplyDocumentSummary>();
    const refs = [
      { document_id: "doc_small", title: "Small Doc", source_type: "document" as const, presentation: "card" as const },
      { document_id: "doc_large", title: "Large Doc", source_type: "document" as const },
      { document_id: "doc_bin", title: "diagram.png", source_type: "attachment" as const },
      { document_id: "doc_flaky", title: "Flaky Doc", source_type: "document" as const },
    ];

    const first = await hydrateReplyDocuments(mockClient, config, refs, cache);
    assert.equal(first[0]?.status, "inlined");
    assert.equal(first[0]?.content, "# Heading\nConcise findings.");
    assert.equal(first[1]?.status, "truncated");
    assert.equal(first[1]?.returned_chars, 1024);
    assert.equal(first[1]?.next_offset, 1024);
    assert.equal(first[2]?.status, "binary");
    assert.equal(first[3]?.status, "error");

    // Second pass reuses cache for doc_small (fetch count stays 1) and retries doc_flaky.
    const second = await hydrateReplyDocuments(mockClient, config, refs, cache);
    assert.equal(smallFetchCount, 1);
    assert.equal(second[3]?.status, "inlined");
    assert.equal(second[3]?.content, "recovered");

    // Paginate doc_large and save binary doc_bin.
    const page2 = await readDocument(mockClient, config, { documentId: "doc_large", offset: 1024, maxChars: 1024 });
    assert.equal(page2.returned_chars, 1024);
    assert.equal(page2.has_more, true);
    assert.equal(page2.next_offset, 2048);

    const savedBin = await readDocument(mockClient, config, { documentId: "doc_bin", saveToFile: true });
    assert.equal(savedBin.is_binary, true);
    assert.ok(typeof savedBin.saved_path === "string");
    assert.deepEqual(await readFile(savedBin.saved_path as string), docs.get("doc_bin")!.bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
