import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDecisionCard, validateManualDecision } from "../src/approval-policy.js";
import type { ApprovalPolicyConfig, DecisionKind, DecisionRequestedMessageCard } from "../src/types.js";

function makePolicy(overrides: Partial<ApprovalPolicyConfig> = {}): ApprovalPolicyConfig {
  return {
    mode: "tiered",
    allowedTools: ["read_file", "list_dir"],
    allowedCommandPrefixes: ["git status", "npm test", "ls"],
    denyPatterns: [],
    allowGuiAutoApprove: false,
    allowHumanConfirmedRelay: true,
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

test("auto-approves safe command prefix (raw and JSON input)", () => {
  for (const input of ["git status -s", JSON.stringify({ command: "npm test" })]) {
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
    assert.equal(res.action, "auto_approve");
  }
});

test("blocks command prefix boundary bypass and shell chaining", () => {
  for (const input of [
    "git status_evil",
    "git status && rm -rf /",
    "ls; cat /etc/passwd",
    "ls | grep secret",
    "echo $(whoami)",
    "ls `id`",
    "ls > /tmp/out",
    "ls\nrm -rf /",
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

test("blocks sensitive paths even on allowlisted read tool", () => {
  for (const sensitivePath of ["/Users/me/.ssh/id_rsa", "/app/.env", "/app/.teamhub/token"]) {
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
});

test("escalates code runtime_permission with patch or script", () => {
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

  const withScript = makeCard("runtime_permission", {
    runtime_permission: {
      kind: "code",
      title: "Run script",
      rationale: "Execute",
      tool: "run_command",
      input: "ls",
      script: { path: "run.sh", body: "echo hi" },
    },
  });
  assert.equal(evaluateDecisionCard(withScript, makePolicy()).action, "relay_to_codex");
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

test("validateManualDecision blocks UI-only approvals and unconfirmed high-risk approvals", () => {
  const policy = makePolicy();
  const uiCard = makeCard("computer_permission");
  assert.equal(validateManualDecision(uiCard, "approve", true, policy).allowed, false);
  assert.equal(validateManualDecision(uiCard, "deny", false, policy).allowed, true);

  const highRisk = makeCard("connector_write");
  assert.equal(validateManualDecision(highRisk, "approve", false, policy).allowed, false);
  assert.equal(validateManualDecision(highRisk, "approve", true, policy).allowed, true);
  assert.equal(validateManualDecision(highRisk, "approve", true, makePolicy({ allowHumanConfirmedRelay: false })).allowed, false);

  assert.equal(validateManualDecision(undefined, "approve", false, policy).allowed, false);
  assert.equal(validateManualDecision(undefined, "deny", false, policy).allowed, true);
});
