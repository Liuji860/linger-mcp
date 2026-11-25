import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LingerApiError, LingerClient } from "../src/client.js";
import { parseConfig } from "../src/config.js";
import { SessionStore } from "../src/session-store.js";

test("LingerClient login, 0600 cache, /v0/me 401 recovery, concurrent 401 safety, cancelRun contract, and config guards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linger-client-test-"));
  const sessionFile = join(dir, "session.json");
  const localKey = randomBytes(32);

  let loginCalls = 0;
  let activeCookie = "cookie_v1";
  let force401Once = true;
  let forceConcurrent401 = false;
  let return429OnRooms = false;
  let tamperIdentity = false;
  let capturedOriginHeader: string | undefined;
  let capturedCancelBody: Record<string, unknown> | undefined;

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const url = req.url ?? "/";

    if (req.method === "POST" && url === "/v0/local/identity") {
      const { nonce } = JSON.parse(bodyText) as { nonce: string };
      const origin = `http://${req.headers.host}`;
      let proof = createHmac("sha256", localKey)
        .update(`linger-local-identity\n${nonce}\n${origin}`)
        .digest("base64url");
      if (tamperIdentity) {
        proof = "a".repeat(43);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proof }));
      return;
    }

    if (req.method === "POST" && url === "/v0/auth/login") {
      capturedOriginHeader = req.headers.origin;
      loginCalls++;
      activeCookie = `cookie_v${loginCalls}`;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `teamhub_session=${activeCookie}; Path=/; HttpOnly; SameSite=Lax`,
      });
      res.end(
        JSON.stringify({
          id: "sess_1",
          account_id: "acct_1",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          identity: {
            account: { id: "acct_1", email: "user@example.com", created_at: new Date().toISOString() },
            actors: [{ id: "actor_human", tenant_id: "tenant_1", kind: "human", display_name: "Human", created_at: new Date().toISOString() }],
          },
        })
      );
      return;
    }

    const cookie = req.headers.cookie ?? "";
    if (!cookie.includes(`teamhub_session=${activeCookie}`)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "expired", request_id: "req_1" } }));
      return;
    }

    if (req.method === "GET" && url === "/v0/me") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          account: { id: "acct_1", email: "user@example.com", created_at: new Date().toISOString() },
          actors: [{ id: "actor_human", tenant_id: "tenant_1", kind: "human", display_name: "Human", created_at: new Date().toISOString() }],
        })
      );
      return;
    }

    if (req.method === "GET" && url.startsWith("/v0/tenants/tenant_1/agents")) {
      if (force401Once) {
        force401Once = false;
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "revoked", request_id: "req_2" } }));
        return;
      }
      if (forceConcurrent401 && cookie.includes("teamhub_session=cookie_v2")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "expired both", request_id: "req_2b" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items: [], page: { has_more: false } }));
      return;
    }

    if (req.method === "GET" && url.startsWith("/v0/tenants/tenant_1/rooms")) {
      if (return429OnRooms) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "12" });
        res.end(JSON.stringify({ error: { code: "RATE_LIMITED", message: "slow down", request_id: "req_3" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items: [], page: { has_more: false } }));
      return;
    }

    if (req.method === "POST" && url === "/v0/rooms/room_1/runs/run_1/cancel") {
      capturedCancelBody = JSON.parse(bodyText) as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ run_id: "run_1", status: "active", agent_actor_id: "agent_1", message_ids: [] }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // Config rejects remote cleartext HTTP and embedded credentials, and parses regex quantifiers safely.
    assert.throws(() => parseConfig({ LINGER_URL: "http://remote.example.com:8080" }), /cleartext http/);
    assert.throws(() => parseConfig({ LINGER_URL: "https://user:pass@remote.example.com" }), /credentials/);
    const cfgQuantifier = parseConfig({
      LINGER_URL: baseUrl,
      LINGER_APPROVAL_DENY_PATTERNS: "foo\\d{1,3},bar",
    });
    assert.equal(cfgQuantifier.approvalPolicy.denyPatterns.length, 2);

    const config = parseConfig({
      LINGER_URL: baseUrl,
      LINGER_EMAIL: "user@example.com",
      LINGER_PASSWORD: "secret",
      LINGER_SESSION_FILE: sessionFile,
      LINGER_LOCAL_IDENTITY_KEY: localKey.toString("base64"),
    });

    const client1 = new LingerClient(config, new SessionStore(sessionFile));
    // First call logs in (loginCalls=1), hits forced 401 once, re-logins (loginCalls=2), and succeeds.
    const agents = await client1.listAgents();
    assert.deepEqual(agents, []);
    assert.equal(loginCalls, 2);
    assert.equal(capturedOriginHeader, undefined);

    const fileStats = await stat(sessionFile);
    assert.equal(fileStats.mode & 0o777, 0o600);

    // Concurrent 401 responses should only perform ONE re-login (loginCalls: 2 -> 3), not clobber each other.
    forceConcurrent401 = true;
    await Promise.all([client1.listAgents(), client1.listAgents()]);
    assert.equal(loginCalls, 3);
    forceConcurrent401 = false;

    // Second client loads cached session without another login call.
    const client2 = new LingerClient(config, new SessionStore(sessionFile));
    await client2.listRooms();
    assert.equal(loginCalls, 3);

    // cancelRun sends strict OpenAPI RoomRunCancelRequest ({ request_id }) without reason.
    await client2.cancelRun("room_1", "run_1");
    assert.ok(typeof capturedCancelBody?.request_id === "string");
    assert.match(capturedCancelBody.request_id as string, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
    assert.equal("reason" in (capturedCancelBody ?? {}), false);

    // Cached session without tenantId that returns 401 on /v0/me recovers cleanly (no deadlock!).
    const store = new SessionStore(sessionFile);
    await store.save({
      baseUrl,
      email: "user@example.com",
      cookie: "teamhub_session=stale_cookie",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const client3 = new LingerClient(config, store);
    await client3.listRooms();
    assert.equal(loginCalls, 4);

    // SessionStore refuses mismatched email, world-readable permissions, and symlinks.
    assert.equal(await store.load(baseUrl, "other@example.com"), null);
    await chmod(sessionFile, 0o644);
    assert.equal(await store.load(baseUrl, "user@example.com"), null);
    const linkPath = join(dir, "session-link.json");
    await writeFile(join(dir, "real.json"), "{}", { mode: 0o600 });
    await symlink(join(dir, "real.json"), linkPath);
    assert.equal(await new SessionStore(linkPath).load(baseUrl), null);

    // 429 error propagates Retry-After cleanly.
    return429OnRooms = true;
    await assert.rejects(
      () => client3.listRooms(),
      (err: unknown) =>
        err instanceof LingerApiError && err.status === 429 && err.retryAfterSeconds === 12
    );

    // decideDecision rejects approve + comment locally before sending HTTP.
    await assert.rejects(
      () => client3.decideDecision("dec_1", { expected_version: 1, decision: "approve", comment: "not allowed" }),
      /does not allow comment/
    );

    // Tampered local identity fails before login credentials are sent.
    tamperIdentity = true;
    const client4 = new LingerClient(config, store);
    await assert.rejects(() => client4.verifyLocalIdentity(), /proof mismatch/);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
