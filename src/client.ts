import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { SessionStore, readMacOsKeychainPassword } from "./session-store.js";
import type {
  CurrentIdentity,
  DecisionRequest,
  DocumentDownloadResult,
  DocumentMetadata,
  DocumentVersionMetadata,
  LingerMcpConfig,
  Message,
  MessagePage,
  MessageSegment,
  Room,
  RoomEventPage,
  RoomListItem,
  RoomPage,
  RoomRunCancelResult,
  RoomRunStatusList,
  Session,
  TenantAgent,
  TenantAgentAvailabilityPage,
  TenantAgentAvailabilitySnapshot,
  TenantAgentPage,
} from "./types.js";

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const LOCAL_IDENTITY_PROOF_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_MESSAGE_RUNES = 50_000;
const MAX_202_RETRIES = 3;
const MAX_ERROR_BODY_BYTES = 65_536;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseContentDispositionFilename(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  const starMatch = /(?:^|;)\s*filename\*\s*=\s*(?:UTF-8|utf-8)''([^;\r\n]+)/i.exec(header);
  if (starMatch?.[1]) {
    try {
      const decoded = decodeURIComponent(starMatch[1].trim().replace(/^"|"$/g, ""));
      if (decoded) {
        return decoded;
      }
    } catch {
      // Fall through to plain filename parameter.
    }
  }
  const quotedMatch = /(?:^|;)\s*filename\s*=\s*"((?:\\.|[^"\\\r\n])+)"/i.exec(header);
  if (quotedMatch?.[1]) {
    const unescaped = quotedMatch[1].replace(/\\(.)/g, "$1").trim();
    if (unescaped) {
      return unescaped;
    }
  }
  const bareMatch = /(?:^|;)\s*filename\s*=\s*([^;\s\r\n]+)/i.exec(header);
  if (bareMatch?.[1]?.trim()) {
    return bareMatch[1].trim();
  }
  return undefined;
}

function normalizeMediaType(header: string | null): string {
  const base = (header ?? "application/octet-stream").split(";")[0]?.trim().toLowerCase();
  return base || "application/octet-stream";
}

function parseSha256Header(headers: Headers): string | undefined {
  const direct = headers.get("x-content-sha256")?.trim().toLowerCase();
  if (direct && /^[a-f0-9]{64}$/.test(direct)) {
    return direct;
  }
  const etag = headers.get("etag")?.trim().replace(/^W\//i, "").replace(/^"|"$/g, "").toLowerCase();
  if (etag && /^[a-f0-9]{64}$/.test(etag)) {
    return etag;
  }
  return undefined;
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  truncateOnLimit: boolean = false
): Promise<Buffer> {
  const contentLenRaw = response.headers.get("content-length");
  if (contentLenRaw && !truncateOnLimit) {
    const declared = Number.parseInt(contentLenRaw, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new LingerApiError(
        413,
        "DOCUMENT_TOO_LARGE",
        `Document size (${declared} bytes) exceeds limit (${maxBytes} bytes)`
      );
    }
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      if (total + value.byteLength > maxBytes) {
        if (truncateOnLimit) {
          const remaining = Math.max(0, maxBytes - total);
          if (remaining > 0) {
            chunks.push(Buffer.from(value.subarray(0, remaining)));
            total += remaining;
          }
          await reader.cancel().catch(() => undefined);
          break;
        }
        await reader.cancel().catch(() => undefined);
        throw new LingerApiError(
          413,
          "DOCUMENT_TOO_LARGE",
          `Downloaded document exceeds limit (${maxBytes} bytes)`
        );
      }
      total += value.byteLength;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export class LingerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSeconds?: number,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = "LingerApiError";
  }
}

interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
  };
}

function extractSessionCookie(headers: Headers): string | null {
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : headers.get("set-cookie")
        ? [headers.get("set-cookie") as string]
        : [];

  for (const header of setCookies) {
    const match = /(?:^|,\s*)(teamhub_session=[^\s;,]+)/.exec(header);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export class LingerClient {
  private cookie: string | null = null;
  private tenantId: string | null = null;
  private humanActorId: string | null = null;
  private loginPromise: Promise<void> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private localIdentityVerified = false;

  constructor(
    private readonly config: LingerMcpConfig,
    private readonly sessionStore: SessionStore
  ) {}

  getTenantId(): string | null {
    return this.tenantId;
  }

  getHumanActorId(): string | null {
    return this.humanActorId;
  }

  /**
   * Verifies a local Linger installation before sending credentials or cached cookies
   * when LINGER_LOCAL_IDENTITY_KEY (32-byte standard base64) is configured.
   */
  async verifyLocalIdentity(): Promise<void> {
    if (!this.config.localIdentityKey || this.localIdentityVerified) {
      return;
    }
    const key = Buffer.from(this.config.localIdentityKey, "base64");
    if (key.length !== 32) {
      throw new Error("LINGER_LOCAL_IDENTITY_KEY must decode to exactly 32 bytes");
    }
    const nonce = randomBytes(32).toString("base64url");
    const origin = this.config.localIdentityOrigin ?? new URL(this.config.baseUrl).origin;
    const expected = createHmac("sha256", key)
      .update(`linger-local-identity\n${nonce}\n${origin}`)
      .digest();

    const response = await this.rawFetch("/v0/local/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce }),
    });
    if (!response.ok) {
      throw await this.buildApiError(response);
    }
    const data = (await response.json()) as { proof?: string };
    if (!data.proof || !LOCAL_IDENTITY_PROOF_RE.test(data.proof)) {
      throw new Error("Local identity verification returned invalid proof format");
    }
    const actual = Buffer.from(data.proof, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("Local identity proof mismatch: target server is not the expected local Linger instance");
    }
    this.localIdentityVerified = true;
  }

  async ensureSession(): Promise<void> {
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }
    if (this.cookie && this.tenantId) {
      return;
    }
    if (!this.loginPromise) {
      this.loginPromise = this.resolveOrLogin().finally(() => {
        this.loginPromise = null;
      });
    }
    await this.loginPromise;
  }

  private async refreshSessionAfter401(failedCookie: string | null): Promise<void> {
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }
    if (this.loginPromise) {
      await this.loginPromise;
      if (this.cookie && failedCookie && this.cookie !== failedCookie) {
        return;
      }
    }
    if (this.cookie && failedCookie && this.cookie !== failedCookie) {
      // Another concurrent call already refreshed the session cookie.
      return;
    }
    this.refreshPromise = (async () => {
      this.cookie = null;
      this.tenantId = null;
      this.humanActorId = null;
      await this.sessionStore.clear();
      if (!this.loginPromise) {
        this.loginPromise = this.resolveOrLogin().finally(() => {
          this.loginPromise = null;
        });
      }
      await this.loginPromise;
    })().finally(() => {
      this.refreshPromise = null;
    });
    await this.refreshPromise;
  }

  private async resolveOrLogin(): Promise<void> {
    await this.verifyLocalIdentity();

    if (!this.cookie) {
      const cached = await this.sessionStore.load(this.config.baseUrl, this.config.email);
      if (cached) {
        if (cached.tenantId) {
          this.cookie = cached.cookie;
          this.tenantId = cached.tenantId;
          this.humanActorId = cached.humanActorId ?? null;
          return;
        }
        // Query /v0/me directly via rawFetch to avoid re-entering ensureSession() on 401.
        try {
          const meResp = await this.rawFetch("/v0/me", {
            method: "GET",
            headers: { Cookie: cached.cookie },
          });
          if (meResp.ok) {
            const me = (await meResp.json()) as CurrentIdentity;
            const actor = me.actors.find((a) => a.kind === "human") ?? me.actors[0];
            if (actor?.tenant_id) {
              this.cookie = cached.cookie;
              this.tenantId = actor.tenant_id;
              this.humanActorId = actor.id;
              await this.sessionStore.save({
                ...cached,
                tenantId: actor.tenant_id,
                humanActorId: actor.id,
              });
              return;
            }
          } else {
            await meResp.body?.cancel().catch(() => undefined);
          }
        } catch {
          // Fall through to full login.
        }
        await this.sessionStore.clear();
      }
    }

    await this.login();
  }

  private async login(): Promise<void> {
    const email = this.config.email;
    if (!email) {
      throw new Error("LINGER_EMAIL is required when no valid cached session exists");
    }

    let password = this.config.password;
    if (!password && this.config.keychainService) {
      password = await readMacOsKeychainPassword(this.config.keychainService, email);
    }
    if (!password) {
      throw new Error(
        "LINGER_PASSWORD or LINGER_KEYCHAIN_SERVICE is required when no valid cached session exists"
      );
    }

    await this.verifyLocalIdentity();

    const response = await this.rawFetch("/v0/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: email, password }),
    });
    if (!response.ok) {
      throw await this.buildApiError(response);
    }

    const sessionCookie = extractSessionCookie(response.headers);
    if (!sessionCookie) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Login succeeded but server did not return teamhub_session Set-Cookie");
    }
    const session = (await response.json()) as Session;
    const actor = session.identity.actors.find((a) => a.kind === "human") ?? session.identity.actors[0];
    if (!actor?.tenant_id) {
      throw new Error("Login succeeded but account has no active Human Actor / Tenant");
    }

    this.cookie = sessionCookie;
    this.tenantId = actor.tenant_id;
    this.humanActorId = actor.id;

    await this.sessionStore.save({
      baseUrl: this.config.baseUrl,
      email,
      cookie: sessionCookie,
      expiresAt: session.expires_at,
      tenantId: actor.tenant_id,
      humanActorId: actor.id,
    });
  }

  private async rawFetch(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${this.config.baseUrl}${path}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
  }

  private async buildApiError(response: Response): Promise<LingerApiError> {
    const retryAfterHeader = response.headers.get("retry-after")?.trim();
    const retryAfterParsed =
      retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number.parseInt(retryAfterHeader, 10) : undefined;
    const retryAfterSeconds =
      retryAfterParsed !== undefined && retryAfterParsed >= 1 ? retryAfterParsed : undefined;
    const rawBuf = await readBoundedResponseBody(response, MAX_ERROR_BODY_BYTES, true).catch(() => Buffer.alloc(0));
    const rawText = rawBuf.toString("utf8");
    try {
      const parsed = JSON.parse(rawText) as ErrorBody;
      if (parsed.error?.message) {
        return new LingerApiError(
          response.status,
          parsed.error.code ?? `HTTP_${response.status}`,
          parsed.error.message,
          Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
          parsed.error.request_id
        );
      }
    } catch {
      // Fall through to status text.
    }
    const safeText = rawText.slice(0, 500) || response.statusText || `HTTP ${response.status}`;
    return new LingerApiError(
      response.status,
      `HTTP_${response.status}`,
      safeText,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined
    );
  }

  private async fetchWithAuth<T>(
    method: string,
    path: string,
    options?: { body?: unknown; headers?: Record<string, string> },
    retriedAfter401: boolean = false
  ): Promise<T> {
    await this.ensureSession();
    const usedCookie = this.cookie;

    const headers: Record<string, string> = {
      ...(options?.headers ?? {}),
      Cookie: usedCookie as string,
    };
    let encodedBody: string | undefined;
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      encodedBody = JSON.stringify(options.body);
    }

    const response = await this.rawFetch(path, {
      method,
      headers,
      body: encodedBody,
    });

    if (response.status === 401 && !retriedAfter401) {
      await response.body?.cancel().catch(() => undefined);
      await this.refreshSessionAfter401(usedCookie);
      return this.fetchWithAuth<T>(method, path, options, true);
    }

    if (!response.ok) {
      throw await this.buildApiError(response);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async fetchBinaryWithAuth(
    path: string,
    options: { maxBytes: number; retryOn202?: boolean },
    retriedAfter401: boolean = false,
    attempt202: number = 0
  ): Promise<DocumentDownloadResult> {
    await this.ensureSession();
    const usedCookie = this.cookie;

    const response = await this.rawFetch(path, {
      method: "GET",
      headers: { Cookie: usedCookie as string },
    });

    if (response.status === 401 && !retriedAfter401) {
      await response.body?.cancel().catch(() => undefined);
      await this.refreshSessionAfter401(usedCookie);
      return this.fetchBinaryWithAuth(path, options, true, attempt202);
    }

    if (response.status === 202 && options.retryOn202 && attempt202 < MAX_202_RETRIES) {
      const retryRaw = response.headers.get("retry-after");
      const retrySec = retryRaw ? Number.parseInt(retryRaw, 10) : 1;
      await response.body?.cancel().catch(() => undefined);
      const waitMs = Math.max(1000, Math.min(3000, Number.isFinite(retrySec) ? retrySec * 1000 : 1000));
      await sleepMs(waitMs);
      return this.fetchBinaryWithAuth(path, options, retriedAfter401, attempt202 + 1);
    }

    if (response.status === 202 || !response.ok) {
      throw await this.buildApiError(response);
    }

    const bytes = await readBoundedResponseBody(response, options.maxBytes);
    const filename = parseContentDispositionFilename(response.headers.get("content-disposition"));
    return {
      filename,
      media_type: normalizeMediaType(response.headers.get("content-type")),
      sha256: parseSha256Header(response.headers),
      size_bytes: bytes.length,
      bytes,
    };
  }

  private async requireTenantId(): Promise<string> {
    await this.ensureSession();
    if (!this.tenantId) {
      throw new Error("Unable to determine Tenant ID for authenticated Linger account");
    }
    return this.tenantId;
  }

  async listAgents(): Promise<TenantAgent[]> {
    const tenantId = await this.requireTenantId();
    const items: TenantAgent[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const qs = new URLSearchParams({ limit: "200" });
      if (cursor) {
        qs.set("cursor", cursor);
      }
      const res = await this.fetchWithAuth<TenantAgentPage>("GET", `/v0/tenants/${encodeURIComponent(tenantId)}/agents?${qs}`);
      items.push(...res.items);
      if (!res.page.has_more || !res.page.next_cursor || res.page.next_cursor === cursor) {
        break;
      }
      cursor = res.page.next_cursor;
    }
    return items;
  }

  async listAgentAvailability(): Promise<TenantAgentAvailabilitySnapshot[]> {
    const tenantId = await this.requireTenantId();
    const items: TenantAgentAvailabilitySnapshot[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const qs = new URLSearchParams({ limit: "200" });
      if (cursor) {
        qs.set("cursor", cursor);
      }
      const res = await this.fetchWithAuth<TenantAgentAvailabilityPage>(
        "GET",
        `/v0/tenants/${encodeURIComponent(tenantId)}/agent-availability?${qs}`
      );
      items.push(...res.items);
      if (!res.page.has_more || !res.page.next_cursor || res.page.next_cursor === cursor) {
        break;
      }
      cursor = res.page.next_cursor;
    }
    return items;
  }

  async listRooms(limit: number = 50): Promise<RoomListItem[]> {
    const tenantId = await this.requireTenantId();
    const bounded = Math.max(1, Math.min(200, limit));
    const items: RoomListItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ limit: String(bounded) });
      if (cursor) {
        qs.set("cursor", cursor);
      }
      const res = await this.fetchWithAuth<RoomPage>("GET", `/v0/tenants/${encodeURIComponent(tenantId)}/rooms?${qs}`);
      items.push(...res.items);
      if (!res.page.has_more || !res.page.next_cursor || items.length >= bounded || res.page.next_cursor === cursor) {
        break;
      }
      cursor = res.page.next_cursor;
    }
    return items.slice(0, bounded);
  }

  private async findRoomByName(roomName: string): Promise<RoomListItem | undefined> {
    const tenantId = await this.requireTenantId();
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const qs = new URLSearchParams({ limit: "200" });
      if (cursor) {
        qs.set("cursor", cursor);
      }
      const res = await this.fetchWithAuth<RoomPage>("GET", `/v0/tenants/${encodeURIComponent(tenantId)}/rooms?${qs}`);
      const match = res.items.find((room) => room.kind === "room" && room.name === roomName);
      if (match) {
        return match;
      }
      if (!res.page.has_more || !res.page.next_cursor || res.page.next_cursor === cursor) {
        break;
      }
      cursor = res.page.next_cursor;
    }
    return undefined;
  }

  async createRoom(name: string, description?: string): Promise<Room> {
    const tenantId = await this.requireTenantId();
    return this.fetchWithAuth<Room>("POST", `/v0/tenants/${encodeURIComponent(tenantId)}/rooms`, {
      body: description ? { name, description } : { name },
    });
  }

  async openDirectRoom(peerActorId: string): Promise<Room> {
    const tenantId = await this.requireTenantId();
    return this.fetchWithAuth<Room>("POST", `/v0/tenants/${encodeURIComponent(tenantId)}/direct-rooms`, {
      body: { peer_actor_id: peerActorId },
    });
  }

  async ensureBridgeRoom(roomName: string): Promise<Room> {
    const existing = await this.findRoomByName(roomName);
    if (existing) {
      return existing;
    }
    try {
      return await this.createRoom(roomName, "Bridge room for Codex MCP agent calls");
    } catch (err) {
      if (err instanceof LingerApiError && err.status === 409 && err.code === "ROOM_NAME_TAKEN") {
        const found = await this.findRoomByName(roomName);
        if (found) {
          return found;
        }
      }
      throw err;
    }
  }

  async getRoom(roomId: string): Promise<Room> {
    return this.fetchWithAuth<Room>("GET", `/v0/rooms/${encodeURIComponent(roomId)}`);
  }

  async sendMessage(roomId: string, segments: MessageSegment[], idempotencyKey?: string): Promise<Message> {
    if (segments.length === 0) {
      throw new Error("Message must include at least one segment");
    }
    for (const segment of segments) {
      if (typeof segment.content !== "string" || segment.content.length === 0) {
        throw new Error("Every message segment must have non-empty content");
      }
    }
    // TeamHub strictly validates that raw_message equals concatenated segment contents.
    const rawMessage = segments.map((segment) => segment.content).join("");
    if (!rawMessage.trim()) {
      throw new Error("Message raw_message must not be blank");
    }
    if ([...rawMessage].length > MAX_MESSAGE_RUNES) {
      throw new Error(`Message exceeds TeamHub limit of ${MAX_MESSAGE_RUNES} characters`);
    }
    const key = idempotencyKey ?? `mcp-${randomUUID()}`;
    if (!IDEMPOTENCY_KEY_RE.test(key)) {
      throw new Error("Invalid Idempotency-Key format");
    }
    return this.fetchWithAuth<Message>("POST", `/v0/rooms/${encodeURIComponent(roomId)}/messages`, {
      headers: { "Idempotency-Key": key },
      body: { raw_message: rawMessage, segments },
    });
  }

  async listMessages(roomId: string, limit: number = 20, cursor?: string): Promise<MessagePage> {
    const qs = new URLSearchParams({ limit: String(Math.max(1, Math.min(200, limit))) });
    if (cursor) {
      qs.set("cursor", cursor);
    }
    return this.fetchWithAuth<MessagePage>("GET", `/v0/rooms/${encodeURIComponent(roomId)}/messages?${qs}`);
  }

  async getMessage(roomId: string, messageId: string): Promise<Message> {
    return this.fetchWithAuth<Message>(
      "GET",
      `/v0/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`
    );
  }

  async listRoomEvents(roomId: string, afterSeq: number = 0, limit: number = 200): Promise<RoomEventPage> {
    const qs = new URLSearchParams({
      after: String(Math.max(0, afterSeq)),
      limit: String(Math.max(1, Math.min(200, limit))),
    });
    return this.fetchWithAuth<RoomEventPage>("GET", `/v0/rooms/${encodeURIComponent(roomId)}/events?${qs}`);
  }

  async listRunStatuses(roomId: string): Promise<RoomRunStatusList> {
    return this.fetchWithAuth<RoomRunStatusList>("GET", `/v0/rooms/${encodeURIComponent(roomId)}/run-statuses`);
  }

  async cancelRun(roomId: string, runId: string): Promise<RoomRunCancelResult> {
    return this.fetchWithAuth<RoomRunCancelResult>(
      "POST",
      `/v0/rooms/${encodeURIComponent(roomId)}/runs/${encodeURIComponent(runId)}/cancel`,
      { body: { request_id: `mcp-${randomUUID()}` } }
    );
  }

  async decideDecision(decisionId: string, request: DecisionRequest): Promise<Message> {
    if (!Number.isInteger(request.expected_version) || request.expected_version < 1) {
      throw new Error("expected_version must be an integer >= 1");
    }
    // TeamHub typedcard/decisions.go rejects approve requests that carry a comment.
    if (request.decision === "approve" && request.comment !== undefined && request.comment.trim() !== "") {
      throw new Error("TeamHub does not allow comment when decision is approve");
    }
    const payload: DecisionRequest = {
      expected_version: request.expected_version,
      decision: request.decision,
    };
    if (request.comment && request.comment.trim() !== "") {
      payload.comment = request.comment.trim();
    }
    if (request.answers) {
      payload.answers = request.answers;
    }
    return this.fetchWithAuth<Message>("POST", `/v0/decisions/${encodeURIComponent(decisionId)}`, {
      body: payload,
    });
  }

  async getDecisionScreenshot(decisionId: string): Promise<{ mimeType: string; base64: string }> {
    const result = await this.fetchBinaryWithAuth(
      `/v0/decisions/${encodeURIComponent(decisionId)}/screenshot`,
      { maxBytes: this.config.documentMaxDownloadBytes, retryOn202: false }
    );
    return {
      mimeType: result.media_type,
      base64: result.bytes.toString("base64"),
    };
  }

  async getDocument(documentId: string): Promise<DocumentMetadata> {
    return this.fetchWithAuth<DocumentMetadata>("GET", `/v0/documents/${encodeURIComponent(documentId)}`);
  }

  async getDocumentVersion(documentVersionId: string): Promise<DocumentVersionMetadata> {
    return this.fetchWithAuth<DocumentVersionMetadata>(
      "GET",
      `/v0/document-versions/${encodeURIComponent(documentVersionId)}`
    );
  }

  async downloadLatestDocument(
    documentId: string,
    maxBytes: number = this.config.documentMaxDownloadBytes
  ): Promise<DocumentDownloadResult> {
    return this.fetchBinaryWithAuth(`/v0/documents/${encodeURIComponent(documentId)}/downloads`, {
      maxBytes,
      retryOn202: true,
    });
  }

  async downloadDocumentVersion(
    documentVersionId: string,
    maxBytes: number = this.config.documentMaxDownloadBytes
  ): Promise<DocumentDownloadResult> {
    return this.fetchBinaryWithAuth(`/v0/document-versions/${encodeURIComponent(documentVersionId)}/content`, {
      maxBytes,
      retryOn202: false,
    });
  }
}
