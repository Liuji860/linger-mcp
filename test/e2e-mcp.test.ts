import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface StoredMessage {
  id: string;
  tenant_id: string;
  room_id: string;
  author: { id: string; tenant_id: string; kind: "human" | "agent"; display_name: string };
  message_kind: "conversation" | "agent_runtime" | "room_notice";
  raw_message: string;
  segments: Array<Record<string, unknown>>;
  attachments: unknown[];
  card?: Record<string, unknown>;
  created_at: string;
}

class MockTeamHubServer {
  private server;
  baseUrl = "";
  private seq = 0;
  private cookieToken = "tok_1";
  expireNextEventPoll = false;
  readonly rooms = new Map<string, Record<string, unknown>>();
  readonly messages = new Map<string, StoredMessage>();
  readonly eventsByRoom = new Map<string, Array<Record<string, unknown>>>();
  readonly decisions = new Map<string, { messageId: string; roomId: string; card: Record<string, unknown> }>();
  readonly canceledRuns: string[] = [];
  readonly idempotencySeen = new Set<string>();

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolveListen) => this.server.listen(0, "127.0.0.1", resolveListen));
    const addr = this.server.address() as { port: number };
    this.baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
  }

  private pushEvent(roomId: string, eventType: string, payload: Record<string, unknown>): number {
    const list = this.eventsByRoom.get(roomId) ?? [];
    const roomSeq = list.length + 1;
    list.push({
      event_id: `evt_${++this.seq}`,
      tenant_id: "tenant_1",
      room_id: roomId,
      room_seq: roomSeq,
      occurred_at: new Date().toISOString(),
      event_type: eventType,
      payload,
    });
    this.eventsByRoom.set(roomId, list);
    return roomSeq;
  }

  private appendAgentMessage(roomId: string, text: string, card?: Record<string, unknown>): StoredMessage {
    const id = `msg_${++this.seq}`;
    const msg: StoredMessage = {
      id,
      tenant_id: "tenant_1",
      room_id: roomId,
      author: { id: "agent_opu", tenant_id: "tenant_1", kind: "agent", display_name: "opu" },
      message_kind: "conversation",
      raw_message: text,
      segments: [{ type: "text", content: text }],
      attachments: [],
      card,
      created_at: new Date().toISOString(),
    };
    this.messages.set(id, msg);
    if (card) {
      this.decisions.set(card.decision_id as string, { messageId: id, roomId, card });
    }
    this.pushEvent(roomId, "message.created", { kind: "message.created", message: msg });
    return msg;
  }

  private emitRunStatus(roomId: string, runId: string, status: "active" | "completed" | "aborted", replied: boolean, stopReason?: string) {
    this.pushEvent(roomId, "agent_run.status_changed", {
      kind: "agent_run.status_changed",
      run: {
        run_id: runId,
        room_id: roomId,
        replied,
        agent: { id: "agent_opu", kind: "agent", display_name: "opu" },
        status,
        event_ordinal: ++this.seq,
        ...(stopReason ? { stop_reason: stopReason } : {}),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    });
  }

  private triggerScenario(roomId: string, prompt: string) {
    const runId = `run_${++this.seq}`;
    this.emitRunStatus(roomId, runId, "active", false);

    if (prompt.includes("SCENARIO_MULTI_MSG")) {
      // Simulate TeamHub setting replied=true early on an active run before final completion.
      this.appendAgentMessage(roomId, "收到，正在核查资料...");
      this.emitRunStatus(roomId, runId, "active", true);
      setTimeout(() => {
        this.emitRunStatus(roomId, runId, "active", false);
        this.appendAgentMessage(roomId, "核查完成，最终结论：可以上线。");
        this.emitRunStatus(roomId, runId, "completed", true);
      }, 150);
      return;
    }

    if (prompt.includes("SCENARIO_ASYNC_LONG")) {
      setTimeout(() => {
        this.appendAgentMessage(roomId, "长耗时分析已完成。");
        this.emitRunStatus(roomId, runId, "completed", true);
      }, 650);
      return;
    }

    if (prompt.includes("SCENARIO_AUTO_ALLOW")) {
      this.appendAgentMessage(roomId, "需要检查 git 状态", {
        card_type: "personal_notice",
        intent: "decision_requested",
        version: 1,
        decision_owner: { id: "human_1", kind: "human", display_name: "刘博" },
        requester: { id: "agent_opu", kind: "agent", display_name: "opu" },
        decision_id: "dec_auto_git",
        kind: "runtime_permission",
        title: "Run git status",
        status: "pending",
        runtime_permission: {
          kind: "code",
          title: "Run git status",
          rationale: "Check clean working tree",
          tool: "run_command",
          input: "git status",
        },
      });
      return;
    }

    if (prompt.includes("SCENARIO_CHAINED_DANGER")) {
      this.appendAgentMessage(roomId, "需要执行危险命令", {
        card_type: "personal_notice",
        intent: "decision_requested",
        version: 1,
        decision_owner: { id: "human_1", kind: "human", display_name: "刘博" },
        requester: { id: "agent_opu", kind: "agent", display_name: "opu" },
        decision_id: "dec_danger",
        kind: "runtime_permission",
        title: "Run chained command",
        status: "pending",
        runtime_permission: {
          kind: "code",
          title: "Run chained command",
          rationale: "Cleanup",
          tool: "run_command",
          input: "git status && rm -rf /",
        },
      });
      return;
    }

    if (prompt.includes("SCENARIO_QUESTION")) {
      this.appendAgentMessage(roomId, "请选择发布方式", {
        card_type: "personal_notice",
        intent: "decision_requested",
        version: 1,
        decision_owner: { id: "human_1", kind: "human", display_name: "刘博" },
        requester: { id: "agent_opu", kind: "agent", display_name: "opu" },
        decision_id: "dec_question_1",
        kind: "question",
        title: "选择部署环境",
        status: "pending",
        question: {
          questions: [
            {
              id: "env",
              prompt: "目标环境",
              input: "radio",
              options: [
                { id: "staging", label: "Staging" },
                { id: "prod", label: "Production" },
              ],
            },
          ],
        },
      });
      return;
    }

    if (prompt.includes("SCENARIO_HIGH_RISK")) {
      this.appendAgentMessage(roomId, "请求对外发邮件与系统权限", {
        card_type: "personal_notice",
        intent: "decision_requested",
        version: 1,
        decision_owner: { id: "human_1", kind: "human", display_name: "刘博" },
        requester: { id: "agent_opu", kind: "agent", display_name: "opu" },
        decision_id: "dec_connector_1",
        kind: "connector_write",
        title: "Send Gmail",
        status: "pending",
        connector_write: {
          kind: "message",
          app: "gmail",
          title: "Send Gmail",
          account: "user@example.com",
          tool: "GMAIL_SEND_EMAIL",
          input: "{}",
        },
      });
      this.appendAgentMessage(roomId, "请求屏幕录制权限", {
        card_type: "personal_notice",
        intent: "decision_requested",
        version: 1,
        decision_owner: { id: "human_1", kind: "human", display_name: "刘博" },
        requester: { id: "agent_opu", kind: "agent", display_name: "opu" },
        decision_id: "dec_comp_perm_1",
        kind: "computer_permission",
        title: "Screen Recording",
        status: "pending",
        computer_permission: {
          computer_id: "comp_1",
          subject: "Linger",
          permissions: ["screen_recording"],
        },
      });
      return;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const parsedUrl = new URL(req.url ?? "/", this.baseUrl);
    const path = parsedUrl.pathname;

    if (req.method === "POST" && path === "/v0/auth/login") {
      this.cookieToken = `tok_${++this.seq}`;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `teamhub_session=${this.cookieToken}; Path=/; HttpOnly; SameSite=Lax`,
      });
      res.end(
        JSON.stringify({
          id: "sess_1",
          account_id: "acct_1",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 86400_000).toISOString(),
          identity: {
            account: { id: "acct_1", email: "liubo@example.com", created_at: new Date().toISOString() },
            actors: [{ id: "human_1", tenant_id: "tenant_1", kind: "human", display_name: "刘博", created_at: new Date().toISOString() }],
          },
        })
      );
      return;
    }

    if (!(req.headers.cookie ?? "").includes(`teamhub_session=${this.cookieToken}`)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "expired", request_id: "r1" } }));
      return;
    }

    if (req.method === "GET" && path === "/v0/tenants/tenant_1/agents") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items: [
            {
              actor: { id: "agent_opu", tenant_id: "tenant_1", kind: "agent", display_name: "opu", created_at: new Date().toISOString() },
              agent_management_id: "mgmt_opu",
              agent_type: "general",
              description: "Deep research analyst",
              configuration_revision: 1,
              instructions: "Analyze deeply",
              runtime: { model: "claude-opus-5.5" },
              visibility_scope: "workspace",
              created_by: { id: "human_1", tenant_id: "tenant_1", kind: "human", display_name: "刘博" },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          page: { has_more: false },
        })
      );
      return;
    }

    if (req.method === "GET" && path === "/v0/tenants/tenant_1/agent-availability") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items: [{ actor_id: "agent_opu", availability: { status: "online", label: "Online", active_task_count: 0 } }],
          page: { has_more: false },
        })
      );
      return;
    }

    if (req.method === "GET" && path === "/v0/tenants/tenant_1/rooms") {
      const items = [...this.rooms.values()].map((room) => ({
        ...room,
        latest_room_seq: Math.max(1, (this.eventsByRoom.get(room.id as string) ?? []).length),
        read_through_room_seq: 0,
        unread_message_count: 0,
        unread_mention_count: 0,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items, page: { has_more: false } }));
      return;
    }

    if (req.method === "POST" && path === "/v0/tenants/tenant_1/rooms") {
      const body = JSON.parse(rawBody) as { name: string; description?: string };
      const room = {
        id: `room_${++this.seq}`,
        tenant_id: "tenant_1",
        kind: "room",
        name: body.name,
        description: body.description ?? "",
        created_by: { id: "human_1", tenant_id: "tenant_1", kind: "human", display_name: "刘博" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.rooms.set(room.id, room);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(room));
      return;
    }

    const msgMatch = /^\/v0\/rooms\/([^/]+)\/messages$/.exec(path);
    if (msgMatch) {
      const roomId = decodeURIComponent(msgMatch[1] as string);
      if (req.method === "GET") {
        const roomMsgs = [...this.messages.values()].filter((m) => m.room_id === roomId);
        const events = this.eventsByRoom.get(roomId) ?? [];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            items: roomMsgs,
            page: { has_more: false },
            snapshot_room_seq: events.length,
          })
        );
        return;
      }
      if (req.method === "POST") {
        const idemKey = req.headers["idempotency-key"];
        if (typeof idemKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idemKey)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { code: "INVALID_IDEMPOTENCY_KEY", message: "bad key", request_id: "r" } }));
          return;
        }
        assert.equal(this.idempotencySeen.has(idemKey), false);
        this.idempotencySeen.add(idemKey);
        const body = JSON.parse(rawBody) as {
          raw_message: string;
          segments: Array<{ type: string; content: string; target?: string; target_type?: string }>;
        };
        assert.equal(body.segments.map((s) => s.content).join(""), body.raw_message);
        const msgId = `msg_${++this.seq}`;
        const msg: StoredMessage = {
          id: msgId,
          tenant_id: "tenant_1",
          room_id: roomId,
          author: { id: "human_1", tenant_id: "tenant_1", kind: "human", display_name: "刘博" },
          message_kind: "conversation",
          raw_message: body.raw_message,
          segments: body.segments,
          attachments: [],
          created_at: new Date().toISOString(),
        };
        this.messages.set(msgId, msg);
        this.pushEvent(roomId, "message.created", { kind: "message.created", message: msg });
        if (body.segments.some((s) => s.type === "reference" && s.target === "agent_opu" && s.target_type === "agent")) {
          this.triggerScenario(roomId, body.raw_message);
        }
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(msg));
        return;
      }
    }

    const singleMsgMatch = /^\/v0\/rooms\/([^/]+)\/messages\/([^/]+)$/.exec(path);
    if (singleMsgMatch && req.method === "GET") {
      const roomId = decodeURIComponent(singleMsgMatch[1] as string);
      const messageId = decodeURIComponent(singleMsgMatch[2] as string);
      const msg = this.messages.get(messageId);
      if (!msg || msg.room_id !== roomId) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "MESSAGE_NOT_FOUND", message: "not found", request_id: "r" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(msg));
      return;
    }

    const eventsMatch = /^\/v0\/rooms\/([^/]+)\/events$/.exec(path);
    if (eventsMatch && req.method === "GET") {
      if (this.expireNextEventPoll) {
        this.expireNextEventPoll = false;
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "session expired", request_id: "r_exp" } }));
        return;
      }
      const roomId = decodeURIComponent(eventsMatch[1] as string);
      const after = Number.parseInt(parsedUrl.searchParams.get("after") ?? "0", 10);
      const all = this.eventsByRoom.get(roomId) ?? [];
      const items = all.filter((e) => (e.room_seq as number) > after);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items,
          latest_room_seq: all.length,
          has_more: false,
        })
      );
      return;
    }

    const decideMatch = /^\/v0\/decisions\/([^/]+)$/.exec(path);
    if (decideMatch && req.method === "POST") {
      const decisionId = decodeURIComponent(decideMatch[1] as string);
      const entry = this.decisions.get(decisionId);
      if (!entry) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "CARD_SOURCE_NOT_FOUND", message: "not found", request_id: "r" } }));
        return;
      }
      const reqBody = JSON.parse(rawBody) as { expected_version: number; decision: string; comment?: string; answers?: Record<string, unknown> };
      const card = entry.card;
      if (reqBody.decision === "approve" && reqBody.comment) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "INVALID_CARD", message: "comment forbidden on approve", request_id: "r" } }));
        return;
      }
      if (card.kind === "computer_permission" && reqBody.decision !== "deny") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "INVALID_CARD", message: "cannot approve computer_permission via API", request_id: "r" } }));
        return;
      }
      if (card.status !== "pending" || reqBody.expected_version !== card.version) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "CARD_CONFLICT", message: "version mismatch or not pending", request_id: "r" } }));
        return;
      }

      card.version = (card.version as number) + 1;
      card.status = reqBody.decision === "approve" ? "approved" : reqBody.decision === "submit" ? "answered" : "denied";
      const msg = this.messages.get(entry.messageId)!;
      msg.card = { ...card };
      this.pushEvent(entry.roomId, "card.changed", { kind: "card.changed", message_id: entry.messageId, version: card.version });

      if (decisionId === "dec_auto_git" && reqBody.decision === "approve") {
        setTimeout(() => {
          this.appendAgentMessage(entry.roomId, "git status 干净，工作区无未提交改动。");
          this.emitRunStatus(entry.roomId, `run_after_${decisionId}`, "completed", true);
        }, 40);
      } else if (decisionId === "dec_danger" && reqBody.decision === "deny") {
        setTimeout(() => {
          this.appendAgentMessage(entry.roomId, "已取消危险命令执行。");
          this.emitRunStatus(entry.roomId, `run_after_${decisionId}`, "completed", true);
        }, 40);
      } else if (decisionId === "dec_question_1" && reqBody.decision === "submit") {
        setTimeout(() => {
          this.appendAgentMessage(entry.roomId, `收到环境选择：${JSON.stringify(reqBody.answers)}`);
          this.emitRunStatus(entry.roomId, `run_after_${decisionId}`, "completed", true);
        }, 40);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(msg));
      return;
    }

    const cancelMatch = /^\/v0\/rooms\/([^/]+)\/runs\/([^/]+)\/cancel$/.exec(path);
    if (cancelMatch && req.method === "POST") {
      // Strictly enforce OpenAPI RoomRunCancelRequest: required request_id, additionalProperties: false.
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      const keys = Object.keys(body);
      if (
        keys.length !== 1 ||
        keys[0] !== "request_id" ||
        typeof body.request_id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(body.request_id)
      ) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "INVALID_REQUEST", message: "invalid RoomRunCancelRequest", request_id: "r" } }));
        return;
      }
      const runId = decodeURIComponent(cancelMatch[2] as string);
      this.canceledRuns.push(runId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ run_id: runId, status: "active", agent_actor_id: "agent_opu", message_ids: [] }));
      return;
    }

    res.writeHead(404);
    res.end();
  }
}

function parseToolJson(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }) {
  const first = result.content[0]?.text ?? "";
  return JSON.parse(first) as Record<string, unknown>;
}

test("Stdio MCP Server E2E flows with opu tiered approval policy", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "linger-e2e-"));
  const sessionFile = join(tempDir, "session.json");
  const mock = new MockTeamHubServer();
  await mock.start();

  const serverEntry = resolve(process.cwd(), "dist/src/index.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      PATH: process.env.PATH ?? "",
      LINGER_URL: mock.baseUrl,
      LINGER_EMAIL: "liubo@example.com",
      LINGER_PASSWORD: "demo-password",
      LINGER_SESSION_FILE: sessionFile,
      LINGER_POLL_INTERVAL_MS: "100",
      LINGER_DEFAULT_WAIT_SECONDS: "2",
      LINGER_APPROVAL_MODE: "tiered",
    },
  });
  const client = new Client({ name: "e2e-test-client", version: "0.1.0" });

  try {
    await client.connect(transport);

    // 1. Discover agents
    const listed = parseToolJson(
      (await client.callTool({ name: "linger_list_agents", arguments: {} })) as never
    );
    const agents = listed.agents as Array<Record<string, unknown>>;
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.display_name, "opu");

    // 2. Multi-message response ignores early active replied=true flip and waits for completed status
    const multi = parseToolJson(
      (await client.callTool({
        name: "linger_ask_agent",
        arguments: { agent: "opu", prompt: "SCENARIO_MULTI_MSG", wait_seconds: 5 },
      })) as never
    );
    assert.equal(multi.status, "completed");
    assert.match(multi.reply_text as string, /正在核查资料/);
    assert.match(multi.reply_text as string, /可以上线/);

    // 3. Long-running async job returns running job_id, then concurrent linger_get_reply + 401 recovery completes cleanly
    mock.expireNextEventPoll = true;
    const asyncStart = parseToolJson(
      (await client.callTool({
        name: "linger_ask_agent",
        arguments: { agent: "opu", prompt: "SCENARIO_ASYNC_LONG", wait_seconds: 0 },
      })) as never
    );
    assert.equal(asyncStart.status, "running");
    assert.ok(typeof asyncStart.job_id === "string");

    // Same-agent concurrent call in the same Bridge Room is rejected cleanly rather than cross-talking.
    const sameAgentBlocked = (await client.callTool({
      name: "linger_ask_agent",
      arguments: { agent: "opu", prompt: "SCENARIO_MULTI_MSG", wait_seconds: 1 },
    })) as { isError?: boolean; content: Array<{ text?: string }> };
    assert.equal(sameAgentBlocked.isError, true);
    assert.match(sameAgentBlocked.content[0]?.text ?? "", /already has an active job/);

    const [asyncDoneA, asyncDoneB] = await Promise.all([
      client.callTool({ name: "linger_get_reply", arguments: { job_id: asyncStart.job_id, wait_seconds: 5 } }),
      client.callTool({ name: "linger_get_reply", arguments: { job_id: asyncStart.job_id, wait_seconds: 5 } }),
    ]);
    assert.equal(parseToolJson(asyncDoneA as never).status, "completed");
    assert.equal(parseToolJson(asyncDoneB as never).status, "completed");
    assert.match(parseToolJson(asyncDoneA as never).reply_text as string, /长耗时分析已完成/);

    // 4. Allowlisted runtime_permission(code) auto-approved with audit record
    const autoApproved = parseToolJson(
      (await client.callTool({
        name: "linger_ask_agent",
        arguments: { agent: "opu", prompt: "SCENARIO_AUTO_ALLOW", wait_seconds: 5 },
      })) as never
    );
    assert.equal(autoApproved.status, "completed");
    assert.match(autoApproved.reply_text as string, /git status 干净/);
    const audits = autoApproved.auto_approvals as Array<Record<string, unknown>>;
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.outcome, "approved");
    assert.equal(audits[0]?.matched_rule, "cmd_prefix:git status");

    // 5. Chained dangerous shell command is NOT auto-approved -> pending_approval -> Codex denies
    const chained = parseToolJson(
      (await client.callTool({
        name: "linger_ask_agent",
        arguments: { agent: "opu", prompt: "SCENARIO_CHAINED_DANGER", wait_seconds: 3 },
      })) as never
    );
    assert.equal(chained.status, "pending_approval");
    const dangerCards = chained.pending_cards as Array<Record<string, unknown>>;
    assert.equal(dangerCards.length, 1);
    assert.equal(dangerCards[0]?.decision_id, "dec_danger");
    assert.equal(dangerCards[0]?.codex_can_decide, true);

    const denyRes = parseToolJson(
      (await client.callTool({
        name: "linger_decide_card",
        arguments: { decision_id: "dec_danger", decision: "deny", comment: "Contains chained rm -rf" },
      })) as never
    );
    assert.equal(denyRes.ok, true);

    const afterDeny = parseToolJson(
      (await client.callTool({
        name: "linger_get_reply",
        arguments: { job_id: chained.job_id, wait_seconds: 3 },
      })) as never
    );
    assert.equal(afterDeny.status, "completed");
    assert.match(afterDeny.reply_text as string, /已取消危险命令执行/);

    // 6. Question card delegated to Codex -> submit answers -> completes
    const qStart = parseToolJson(
      (await client.callTool({
        name: "linger_ask_agent",
        arguments: { agent: "opu", prompt: "SCENARIO_QUESTION", wait_seconds: 3 },
      })) as never
    );
    assert.equal(qStart.status, "pending_approval");
    const submitQ = parseToolJson(
      (await client.callTool({
        name: "linger_decide_card",
        arguments: {
          decision_id: "dec_question_1",
          decision: "submit",
          answers: { env: "staging" },
        },
      })) as never
    );
    assert.equal(submitQ.ok, true);

    const qDone = parseToolJson(
      (await client.callTool({
        name: "linger_get_reply",
        arguments: { job_id: qStart.job_id, wait_seconds: 3 },
      })) as never
    );
    assert.equal(qDone.status, "completed");
    assert.match(qDone.reply_text as string, /staging/);

    // 7. High-risk connector_write & computer_permission stay human-only; stale version triggers conflict_or_expired
    const highRisk = parseToolJson(
      (await client.callTool({
        name: "linger_ask_agent",
        arguments: { agent: "opu", prompt: "SCENARIO_HIGH_RISK", wait_seconds: 2 },
      })) as never
    );
    assert.equal(highRisk.status, "pending_approval");
    const hrCards = highRisk.pending_cards as Array<Record<string, unknown>>;
    assert.equal(hrCards.length, 2);
    assert.ok(hrCards.every((c) => c.tier === "human" && c.codex_can_decide === false));

    const blockedConnector = parseToolJson(
      (await client.callTool({
        name: "linger_decide_card",
        arguments: { decision_id: "dec_connector_1", decision: "approve" },
      })) as never
    );
    assert.equal(blockedConnector.ok, false);
    assert.equal(blockedConnector.status, "blocked_by_policy");

    const blockedCompPerm = parseToolJson(
      (await client.callTool({
        name: "linger_decide_card",
        arguments: { decision_id: "dec_comp_perm_1", decision: "approve", human_confirmed: true },
      })) as never
    );
    assert.equal(blockedCompPerm.ok, false);
    assert.equal(blockedCompPerm.status, "blocked_by_policy");

    const uncachedBlocked = parseToolJson(
      (await client.callTool({
        name: "linger_decide_card",
        arguments: { decision_id: "dec_unknown_uncached", decision: "approve", human_confirmed: true },
      })) as never
    );
    assert.equal(uncachedBlocked.ok, false);
    assert.equal(uncachedBlocked.status, "blocked_by_policy");

    const staleConflict = parseToolJson(
      (await client.callTool({
        name: "linger_decide_card",
        arguments: { decision_id: "dec_connector_1", decision: "deny", expected_version: 99 },
      })) as never
    );
    assert.equal(staleConflict.ok, false);
    assert.equal(staleConflict.status, "conflict_or_expired");

    // 8. Cancel job (validates OpenAPI RoomRunCancelRequest) & list/read rooms
    const cancelRes = parseToolJson(
      (await client.callTool({
        name: "linger_cancel_job",
        arguments: { job_id: highRisk.job_id },
      })) as never
    );
    assert.equal(cancelRes.canceled, true);

    const roomsRes = parseToolJson(
      (await client.callTool({ name: "linger_list_rooms", arguments: {} })) as never
    );
    assert.equal((roomsRes.rooms as Array<unknown>).length, 1);

    const readRoomRes = parseToolJson(
      (await client.callTool({ name: "linger_read_room", arguments: { room_id: highRisk.room_id, limit: 5 } })) as never
    );
    assert.ok(Array.isArray(readRoomRes.items));
  } finally {
    await client.close().catch(() => undefined);
    await mock.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
