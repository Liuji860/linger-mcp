import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDecisionCard, validateManualDecision } from "../src/approval-policy.js";
import type { ApprovalPolicyConfig, DecisionKind, DecisionRequestedMessageCard } from "../src/types.js";

function makePolicy(overrides: Partial<ApprovalPolicyConfig> = {}): ApprovalPolicyConfig {
  return {
    mode: "tiered",
    allowedTools: ["read_file", "list_dir"],
    allowedCommandPrefixes: ["git status", "npm test", "git diff", "tsc", "ls", "pwd"],
    denyPatterns: [],
    allowGuiAutoApprove: false,
    allowHumanConfirmedRelay: false,
    ...overrides,
  };
}

function makeCard(
  kind: DecisionKind,
  extra: Partial<DecisionRequestedMessageCard> = {}
): DecisionRequestedMessageCard {
  return {
    card_type: "personal_notice",
    intent: "decision_requested",
    version: 1,
    decision_owner: { id: "user_1", kind: "human", display_name: "Owner" },
    requester: { id: "agent_1", kind: "agent", display_name: "opu" },
    decision_id: "dec_1",
    kind,
    title: "Test decision",
    status: "pending",
    ...extra,
  };
}

test("auto-approves allowlisted read-only tool", () => {
  const card = makeCard("runtime_permission", {
    runtime_permission: {
      kind: "code",
      title: "Read src/index.ts",
      rationale: "Inspect entry point",
      tool: "read_file",
      input: JSON.stringify({ Path: "src/index.ts" }),
    },
  });
  const res = evaluateDecisionCard(card, makePolicy());
  assert.equal(res.action, "auto_approve");
  assert.equal(res.tier, "auto");
});

test("auto-approves safe command prefix (raw and single-key JSON input)", () => {
  for (const input of ["git status -s", "tsc --noEmit", JSON.stringify({ command: "npm test" })]) {
    const card = makeCard("runtime_permission", {
      runtime_permission: {
        kind: "code",
        title: "Run check",
        rationale: "Check workspace",
        tool: "run_command",
        input,
      },
    });
    const res = evaluateDecisionCard(card, makePolicy());
    assert.equal(res.action, "auto_approve", `Expected auto_approve for ${input}`);
  }
});

test("blocks command prefix bypass, dangerous flags, JSON sibling keys, and Unicode spaces", () => {
  for (const input of [
    "git status_evil",
    "git status && rm -rf /",
    "ls; cat /etc/passwd",
    "ls | grep secret",
    "echo $(whoami)",
    "ls `id`",
    "ls > /tmp/out",
    "ls\nrm -rf /",
    "git diff --no-index /etc/passwd /dev/null",
    "npm test --prefix /tmp/evil",
    "npm test -- --require /tmp/evil.js",
    "tsc -p /tmp/tsconfig.json",
    "ls /Users/someone",
    "ls ../secrets",
    "ls\u00a0/tmp",
    JSON.stringify({ command: "ls", args: ["-la", "/Users"] }),
    JSON.stringify({ command: "ls", env: { LD_PRELOAD: "/tmp/x.so" } }),
  ]) {
    const card = makeCard("runtime_permission", {
      runtime_permission: {
        kind: "code",
        title: "Suspicious shell",
        rationale: "Check",
        tool: "run_command",
        input,
      },
    });
    const res = evaluateDecisionCard(card, makePolicy());
    assert.equal(res.action, "relay_to_codex", `Expected relay_to_codex for input: ${input}`);
  }
});

test("blocks sensitive paths including linger-mcp session.json and JSON unicode escapes", () => {
  for (const sensitivePath of [
    "/Users/me/.ssh/id_rsa",
    "/app/.env",
    "/app/.teamhub/token",
    "/Users/me/.config/linger-mcp/session.json",
    "/Users/me/.aws/credentials",
  ]) {
    const card = makeCard("runtime_permission", {
      runtime_permission: {
        kind: "code",
        title: "Read file",
        rationale: "Inspect",
        tool: "read_file",
        input: JSON.stringify({ Path: sensitivePath }),
      },
    });
    const res = evaluateDecisionCard(card, makePolicy());
    assert.equal(res.action, "relay_to_codex", `Expected sensitive path block for ${sensitivePath}`);
  }

  // Raw JSON with unicode escape for ".env"
  const escapedCard = makeCard("runtime_permission", {
    runtime_permission: {
      kind: "code",
      title: "Read file",
      rationale: "Inspect",
      tool: "read_file",
      input: '{"Path":"/app/\\u002eenv"}',
    },
  });
  assert.equal(evaluateDecisionCard(escapedCard, makePolicy()).action, "relay_to_codex");
});

test("escalates code and GUI runtime_permission with patch or script", () => {
  const withPatch = makeCard("runtime_permission", {
    runtime_permission: {
      kind: "code",
      title: "Edit file",
      rationale: "Apply fix",
      tool: "read_file",
      input: "{}",
      patch: "--- a/x\n+++ b/x",
    },
  });
  assert.equal(evaluateDecisionCard(withPatch, makePolicy()).action, "relay_to_codex");

  const guiWithPatch = makeCard("runtime_permission", {
    runtime_permission: {
      kind: "gui",
      title: "GUI with patch",
      rationale: "Check",
      tool: "read_file",
      input: "{}",
      patch: "diff",
    },
  });
  assert.equal(
    evaluateDecisionCard(guiWithPatch, makePolicy({ allowGuiAutoApprove: true })).action,
    "relay_to_codex"
  );
});

test("escalates GUI permissions and questions to Codex in tiered/relay, human in manual", () => {
  const guiCard = makeCard("runtime_permission", {
    runtime_permission: {
      kind: "gui",
      title: "Click submit",
      rationale: "Submit form",
      tool: "browser_click",
      input: "{}",
    },
  });
  assert.equal(evaluateDecisionCard(guiCard, makePolicy({ mode: "tiered" })).action, "relay_to_codex");
  assert.equal(evaluateDecisionCard(guiCard, makePolicy({ mode: "manual" })).action, "require_human");

  const questionCard = makeCard("question", {
    question: {
      questions: [{ id: "q1", prompt: "Pick env", input: "radio", options: [{ id: "a", label: "A" }] }],
    },
  });
  assert.equal(evaluateDecisionCard(questionCard, makePolicy({ mode: "tiered" })).action, "relay_to_codex");
  assert.equal(evaluateDecisionCard(questionCard, makePolicy({ mode: "manual" })).action, "require_human");
});

test("strictly keeps high-risk and Linger-UI-only cards human-only", () => {
  const humanOnlyKinds: DecisionKind[] = [
    "connector_write",
    "agent_change",
    "room_creation",
    "connection_auth",
    "provider_key",
    "browser_connection",
    "computer_permission",
    "search_key",
    "profile_setup_apps",
    "profile_setup_sources",
  ];
  for (const kind of humanOnlyKinds) {
    const res = evaluateDecisionCard(makeCard(kind), makePolicy({ mode: "tiered" }));
    assert.equal(res.action, "require_human", `Expected require_human for ${kind}`);
    assert.equal(res.tier, "human");
  }
});

test("fails closed for expired, non-pending, or unknown card kinds", () => {
  const expired = makeCard("runtime_permission", {
    expires_at: "2020-01-01T00:00:00Z",
    runtime_permission: {
      kind: "code",
      title: "Read",
      rationale: "Read",
      tool: "read_file",
      input: "src/index.ts",
    },
  });
  assert.equal(evaluateDecisionCard(expired, makePolicy()).action, "require_human");

  const alreadyApproved = makeCard("runtime_permission", { status: "approved" });
  assert.equal(evaluateDecisionCard(alreadyApproved, makePolicy()).action, "require_human");

  const unknownKind = makeCard("future_unknown_kind" as DecisionKind);
  assert.equal(evaluateDecisionCard(unknownKind, makePolicy()).action, "require_human");
});

test("validateManualDecision enforces strict card, mode, and kind/action rules", () => {
  const tiered = makePolicy({ mode: "tiered", allowHumanConfirmedRelay: false });
  const relay = makePolicy({ mode: "relay", allowHumanConfirmedRelay: true });
  const manual = makePolicy({ mode: "manual", allowHumanConfirmedRelay: false });

  // Uncached card is ALWAYS blocked (even with humanConfirmed=true or deny).
  assert.equal(validateManualDecision(undefined, "approve", true, relay).allowed, false);
  assert.equal(validateManualDecision(undefined, "deny", true, relay).allowed, false);

  // Manual mode blocks approve/submit.
  const rtCard = makeCard("runtime_permission");
  assert.equal(validateManualDecision(rtCard, "approve", false, manual).allowed, false);
  assert.equal(validateManualDecision(rtCard, "deny", false, manual).allowed, true);

  // UI-only cards forbid approve and forbid comment on deny for computer_permission/connection_auth.
  const uiCard = makeCard("computer_permission");
  assert.equal(validateManualDecision(uiCard, "approve", true, relay).allowed, false);
  assert.equal(validateManualDecision(uiCard, "deny", false, tiered, { comment: "no" }).allowed, false);
  assert.equal(validateManualDecision(uiCard, "deny", false, tiered).allowed, true);

  // connection_auth authorizing can be denied.
  const authCard = makeCard("connection_auth", { status: "authorizing" });
  assert.equal(validateManualDecision(authCard, "deny", false, tiered).allowed, true);
  assert.equal(validateManualDecision(authCard, "approve", true, relay).allowed, false);

  // High-risk cards: blocked in tiered by default, permitted in relay only with humanConfirmed=true.
  const highRisk = makeCard("connector_write");
  assert.equal(validateManualDecision(highRisk, "approve", true, tiered).allowed, false);
  assert.equal(validateManualDecision(highRisk, "approve", false, relay).allowed, false);
  assert.equal(validateManualDecision(highRisk, "approve", true, relay).allowed, true);
  assert.equal(validateManualDecision(highRisk, "submit", false, relay).allowed, false);

  // room_creation requires comment on deny.
  const roomCard = makeCard("room_creation");
  assert.equal(validateManualDecision(roomCard, "deny", false, tiered).allowed, false);
  assert.equal(validateManualDecision(roomCard, "deny", false, tiered, { comment: "not now" }).allowed, true);

  // question validation checks answers shape.
  const qCard = makeCard("question", {
    question: {
      questions: [
        { id: "env", prompt: "Env", input: "radio", options: [{ id: "prod", label: "Prod" }] },
      ],
    },
  });
  assert.equal(validateManualDecision(qCard, "submit", false, tiered).allowed, false);
  assert.equal(
    validateManualDecision(qCard, "submit", false, tiered, { answers: { env: "prod" } }).allowed,
    true
  );
  assert.equal(validateManualDecision(rtCard, "submit", false, tiered).allowed, false);
});
