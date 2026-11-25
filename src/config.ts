import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalMode, LingerMcpConfig, RoomMode } from "./types.js";

const DEFAULT_ALLOW_TOOLS = ["read_file", "list_dir", "grep_search", "find_by_name", "view_file"];
const DEFAULT_ALLOW_CMD_PREFIXES = [
  "git status",
  "git diff",
  "git log",
  "npm test",
  "npm run test",
  "npm run typecheck",
  "npm run build",
  "tsc",
  "ls",
  "pwd",
];

function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) {
    return [...fallback];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Splits comma-delimited regex strings without breaking `{m,n}` quantifiers. */
function splitCommaOutsideBraces(raw: string): string[] {
  const parts: string[] = [];
  let braceDepth = 0;
  let escaped = false;
  let current = "";
  for (const ch of raw) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === "{") {
      braceDepth++;
    } else if (ch === "}" && braceDepth > 0) {
      braceDepth--;
    } else if (ch === "," && braceDepth === 0) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function parseDenyPatterns(raw: string | undefined): RegExp[] {
  if (!raw || !raw.trim()) {
    return [];
  }
  const trimmed = raw.trim();
  let patterns: string[];
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Invalid LINGER_APPROVAL_DENY_PATTERNS JSON array: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string" && item.length > 0)) {
      throw new Error("LINGER_APPROVAL_DENY_PATTERNS JSON must be an array of non-empty strings");
    }
    patterns = parsed;
  } else {
    patterns = splitCommaOutsideBraces(trimmed);
  }
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern, "i");
    } catch (err) {
      throw new Error(`Invalid regex in LINGER_APPROVAL_DENY_PATTERNS (${pattern}): ${(err as Error).message}`);
    }
  });
}

function parseIntInRange(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new Error(`Invalid boolean value: ${raw}`);
}

function isLoopbackHost(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): LingerMcpConfig {
  const rawUrl = env.LINGER_URL?.trim();
  if (!rawUrl) {
    throw new Error("LINGER_URL is required (e.g. http://localhost:8080)");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error("LINGER_URL is not a valid URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`LINGER_URL must use http or https scheme, got "${parsedUrl.protocol}"`);
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error("LINGER_URL must not embed username or password credentials");
  }
  const allowInsecureHttp = parseBool(env.LINGER_ALLOW_INSECURE_HTTP, false);
  if (parsedUrl.protocol === "http:" && !isLoopbackHost(parsedUrl.hostname) && !allowInsecureHttp) {
    throw new Error(
      `LINGER_URL uses cleartext http for non-loopback host "${parsedUrl.hostname}". Use https:// or set LINGER_ALLOW_INSECURE_HTTP=true.`
    );
  }
  const baseUrl = parsedUrl.toString().replace(/\/+$/, "");

  let localIdentityOrigin: string | undefined;
  const rawOrigin = env.LINGER_LOCAL_IDENTITY_ORIGIN?.trim();
  if (rawOrigin) {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(rawOrigin);
    } catch {
      throw new Error(`LINGER_LOCAL_IDENTITY_ORIGIN is not a valid URL: ${rawOrigin}`);
    }
    localIdentityOrigin = parsedOrigin.origin;
  }

  const roomModeRaw = (env.LINGER_ROOM_MODE ?? "bridge").trim().toLowerCase();
  if (roomModeRaw !== "bridge" && roomModeRaw !== "direct") {
    throw new Error(`LINGER_ROOM_MODE must be "bridge" or "direct", got "${roomModeRaw}"`);
  }
  const roomMode = roomModeRaw as RoomMode;

  const approvalModeRaw = (env.LINGER_APPROVAL_MODE ?? "tiered").trim().toLowerCase();
  if (approvalModeRaw !== "tiered" && approvalModeRaw !== "relay" && approvalModeRaw !== "manual") {
    throw new Error(`LINGER_APPROVAL_MODE must be "tiered", "relay", or "manual", got "${approvalModeRaw}"`);
  }
  const approvalMode = approvalModeRaw as ApprovalMode;

  const sessionFile =
    env.LINGER_SESSION_FILE?.trim() || join(homedir(), ".config", "linger-mcp", "session.json");
  const downloadDir =
    env.LINGER_DOWNLOAD_DIR?.trim() || join(tmpdir(), "linger-mcp-downloads");
  if (sessionFile.includes("\0") || downloadDir.includes("\0")) {
    throw new Error("File paths in config must not contain NUL bytes");
  }

  return {
    baseUrl,
    email: env.LINGER_EMAIL?.trim() || undefined,
    password: env.LINGER_PASSWORD || undefined,
    keychainService: env.LINGER_KEYCHAIN_SERVICE?.trim() || undefined,
    sessionFile,
    localIdentityKey: env.LINGER_LOCAL_IDENTITY_KEY?.trim() || undefined,
    localIdentityOrigin,
    roomMode,
    bridgeRoomName: env.LINGER_BRIDGE_ROOM_NAME?.trim() || "Codex Bridge",
    approvalPolicy: {
      mode: approvalMode,
      allowedTools: parseList(env.LINGER_APPROVAL_ALLOW_TOOLS, DEFAULT_ALLOW_TOOLS),
      allowedCommandPrefixes: parseList(env.LINGER_APPROVAL_ALLOW_CMD_PREFIXES, DEFAULT_ALLOW_CMD_PREFIXES),
      denyPatterns: parseDenyPatterns(env.LINGER_APPROVAL_DENY_PATTERNS),
      allowGuiAutoApprove: parseBool(env.LINGER_ALLOW_GUI_APPROVAL, false),
      allowHumanConfirmedRelay: parseBool(env.LINGER_ALLOW_HUMAN_CONFIRMED_RELAY, approvalMode === "relay"),
    },
    pollIntervalMs: parseIntInRange(env.LINGER_POLL_INTERVAL_MS, 1500, 100, 30_000, "LINGER_POLL_INTERVAL_MS"),
    defaultWaitSeconds: parseIntInRange(env.LINGER_DEFAULT_WAIT_SECONDS, 60, 0, 300, "LINGER_DEFAULT_WAIT_SECONDS"),
    maxConcurrency: parseIntInRange(env.LINGER_MAX_CONCURRENCY, 2, 1, 10, "LINGER_MAX_CONCURRENCY"),
    requestTimeoutMs: parseIntInRange(env.LINGER_REQUEST_TIMEOUT_MS, 30_000, 1000, 120_000, "LINGER_REQUEST_TIMEOUT_MS"),
    autoInlineDocuments: parseBool(env.LINGER_AUTO_INLINE_DOCUMENTS, true),
    inlineDocumentMaxChars: parseIntInRange(
      env.LINGER_INLINE_DOCUMENT_MAX_CHARS,
      32_768,
      1024,
      200_000,
      "LINGER_INLINE_DOCUMENT_MAX_CHARS"
    ),
    documentMaxDownloadBytes: parseIntInRange(
      env.LINGER_DOC_MAX_BYTES,
      10_485_760,
      65_536,
      52_428_800,
      "LINGER_DOC_MAX_BYTES"
    ),
    downloadDir,
  };
}
