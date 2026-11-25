import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LingerApiError, LingerClient } from "../src/client.js";
import { parseConfig } from "../src/config.js";
import { SessionStore } from "../src/session-store.js";

test("LingerClient login, 0600 session cache, 401 re-login, 429 handling, and local identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linger-client-test-"));
  const sessionFile = join(dir, "session.json");
  const localKey = randomBytes(32);

  let loginCalls = 0;
  let activeCookie = "cookie_v1";
  let force401Once = true;
  let return429OnRooms = false;
  let tamperIdentity = false;
  let capturedOriginHeader: string | undefined;

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
        proof = "invalid-proof";
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

    if (req.method === "GET" && url.startsWith("/v0/tenants/tenant_1/agents")) {
      if (force401Once) {
        force401Once = false;
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "revoked", request_id: "req_2" } }));
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

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const config = parseConfig({
      LINGER_URL: baseUrl,
      LINGER_EMAIL: "user@example.com",
      LINGER_PASSWORD: "secret",
      LINGER_SESSION_FILE: sessionFile,
      LINGER_LOCAL_IDENTITY_KEY: localKey.toString("base64"),
    });

    const client1 = new LingerClient(config, new SessionStore(sessionFile));
    // First call logs in (loginCalls=1), hits forced 401 once, transparently re-logins (loginCalls=2), and succeeds.
    const agents = await client1.listAgents();
    assert.deepEqual(agents, []);
    assert.equal(loginCalls, 2);
    assert.equal(capturedOriginHeader, undefined);

    const fileStats = await stat(sessionFile);
    assert.equal(fileStats.mode & 0o777, 0o600);

    // Second client loads cached session without another login call.
    const client2 = new LingerClient(config, new SessionStore(sessionFile));
    await client2.listRooms();
    assert.equal(loginCalls, 2);

    // 429 error propagates Retry-After cleanly.
    return429OnRooms = true;
    await assert.rejects(
      () => client2.listRooms(),
      (err: unknown) =>
        err instanceof LingerApiError && err.status === 429 && err.retryAfterSeconds === 12
    );

    // decideDecision rejects approve + comment locally before sending HTTP.
    await assert.rejects(
      () => client2.decideDecision("dec_1", { expected_version: 1, decision: "approve", comment: "not allowed" }),
      /does not allow comment/
    );

    // Tampered local identity fails before login credentials are sent.
    tamperIdentity = true;
    await assert.rejects(() => client2.verifyLocalIdentity(), /proof mismatch/);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
