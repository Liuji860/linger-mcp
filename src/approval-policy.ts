import type {
  ApprovalEvaluation,
  ApprovalPolicyConfig,
  DecisionAnswerAction,
  DecisionKind,
  DecisionRequestedMessageCard,
} from "./types.js";

/**
 * Cards whose positive resolution happens only in Linger UI / OS settings.
 * Per TeamHub typedcard/decisions.go, provider_key, browser_connection,
 * computer_permission, and search_key reject approval via POST /v0/decisions/{id}.
 */
export const LINGER_UI_ONLY_KINDS: ReadonlySet<DecisionKind> = new Set([
  "connection_auth",
  "provider_key",
  "browser_connection",
  "computer_permission",
  "search_key",
  "profile_setup_apps",
  "profile_setup_sources",
]);

/** High-impact mutations that must never be auto-approved without human sign-off. */
export const HIGH_RISK_HUMAN_ONLY_KINDS: ReadonlySet<DecisionKind> = new Set([
  "connector_write",
  "agent_change",
  "room_creation",
]);

/** Shell metacharacters/operators that disqualify a command from prefix auto-approval. */
const SHELL_METACHAR_RE = /[;&|`$><\r\n]/;

/** Built-in high-risk tokens and sensitive path fragments blocked from auto-approval. */
const BUILTIN_DENY_RE: RegExp[] = [
  /\b(?:rm|rmdir|mv|sudo|su|doas|chmod|chown|chgrp|curl|wget|nc|ncat|ssh|scp|sftp|rsync|eval|exec|dd|mkfs|fdisk|diskutil|launchctl|killall|pkill|shutdown|reboot|security|pbcopy|osascript)\b/i,
  /\b(?:python\d*|node|bash|sh|zsh|perl|ruby)\s+-[ce]\b/i,
  /(?:^|[\s/"'])(\.ssh|\.env(?:\.|$|\b)|\.teamhub|keychains?|id_rsa|id_ed25519)/i,
  /\s--force\b|\s-rf\b|\s-fr\b/i,
];

function normalizeSpaces(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Extracts the shell command string from a runtime_permission input field
 * (either raw string or JSON containing command/cmd/CommandLine).
 */
export function extractCommandFromRuntimeInput(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.startsWith("{")) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    for (const key of ["command", "cmd", "CommandLine", "command_line"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

function matchesAnyDenyPattern(texts: string[], extraPatterns: RegExp[]): RegExp | null {
  for (const pattern of [...BUILTIN_DENY_RE, ...extraPatterns]) {
    for (const text of texts) {
      if (text && pattern.test(text)) {
        return pattern;
      }
    }
  }
  return null;
}

function matchesCommandPrefix(command: string, prefixes: string[]): string | null {
  const normalizedCommand = normalizeSpaces(command);
  for (const rawPrefix of prefixes) {
    const prefix = normalizeSpaces(rawPrefix);
    if (!prefix) {
      continue;
    }
    if (normalizedCommand === prefix || normalizedCommand.startsWith(prefix + " ")) {
      return prefix;
    }
  }
  return null;
}

function isExpired(card: DecisionRequestedMessageCard, nowMs: number): boolean {
  if (!card.expires_at) {
    return false;
  }
  const expiresMs = Date.parse(card.expires_at);
  return Number.isFinite(expiresMs) && expiresMs <= nowMs;
}

/**
 * Evaluates a Linger decision card against opu's tiered approval policy.
 * Always fails closed to require_human for unknown or sensitive card types.
 */
export function evaluateDecisionCard(
  card: DecisionRequestedMessageCard,
  policy: ApprovalPolicyConfig,
  nowMs: number = Date.now()
): ApprovalEvaluation {
  if (card.status !== "pending") {
    return {
      tier: "human",
      action: "require_human",
      reason: `Card is already in terminal/non-pending status "${card.status}"`,
    };
  }
  if (isExpired(card, nowMs)) {
    return {
      tier: "human",
      action: "require_human",
      reason: "Card has already expired",
    };
  }

  if (LINGER_UI_ONLY_KINDS.has(card.kind)) {
    return {
      tier: "human",
      action: "require_human",
      reason: `Card kind "${card.kind}" must be completed directly by the human in Linger/OS`,
    };
  }

  if (HIGH_RISK_HUMAN_ONLY_KINDS.has(card.kind)) {
    return {
      tier: "human",
      action: "require_human",
      reason: `High-risk card kind "${card.kind}" requires human approval and cannot be auto-approved`,
    };
  }

  if (card.kind === "question") {
    if (policy.mode === "manual") {
      return {
        tier: "human",
        action: "require_human",
        reason: "Manual approval mode forwards questions to human instead of Codex",
      };
    }
    return {
      tier: "codex",
      action: "relay_to_codex",
      reason: "Question card delegated to Codex to submit structured answers",
    };
  }

  if (card.kind === "runtime_permission") {
    const perm = card.runtime_permission;
    if (!perm) {
      return {
        tier: "human",
        action: "require_human",
        reason: "Missing runtime_permission payload; failing closed",
      };
    }

    if (policy.mode === "manual") {
      return {
        tier: "human",
        action: "require_human",
        reason: "Manual approval mode requires human decision in Linger",
      };
    }

    if (policy.mode === "relay") {
      return {
        tier: "codex",
        action: "relay_to_codex",
        reason: `Relay mode delegates runtime_permission (${perm.kind}) to Codex confirmation`,
      };
    }

    const inspectableTexts = [perm.title, perm.tool, perm.input, perm.patch ?? "", perm.script?.body ?? ""];
    const matchedDeny = matchesAnyDenyPattern(inspectableTexts, policy.denyPatterns);
    if (matchedDeny) {
      return {
        tier: "codex",
        action: "relay_to_codex",
        reason: `Blocked from auto-approval by deny rule (${matchedDeny.source}); escalated for review`,
      };
    }

    if (perm.kind === "gui") {
      if (policy.allowGuiAutoApprove && policy.allowedTools.includes(perm.tool)) {
        return {
          tier: "auto",
          action: "auto_approve",
          reason: `GUI tool "${perm.tool}" matched explicit allowlist`,
          matchedRule: `gui_tool:${perm.tool}`,
        };
      }
      return {
        tier: "codex",
        action: "relay_to_codex",
        reason: "GUI/browser runtime_permission requires Codex or human confirmation",
      };
    }

    // Never auto-approve file diffs or arbitrary script bodies without Codex review.
    if (perm.patch || perm.script) {
      return {
        tier: "codex",
        action: "relay_to_codex",
        reason: "File patch or script execution escalated to Codex for inspection",
      };
    }

    if (policy.allowedTools.includes(perm.tool)) {
      return {
        tier: "auto",
        action: "auto_approve",
        reason: `Read-only/allowlisted tool "${perm.tool}" auto-approved`,
        matchedRule: `tool:${perm.tool}`,
      };
    }

    const command = extractCommandFromRuntimeInput(perm.input);
    if (command && !SHELL_METACHAR_RE.test(command)) {
      const matchedPrefix = matchesCommandPrefix(command, policy.allowedCommandPrefixes);
      if (matchedPrefix) {
        return {
          tier: "auto",
          action: "auto_approve",
          reason: `Command matched safe prefix "${matchedPrefix}" without shell chaining`,
          matchedRule: `cmd_prefix:${matchedPrefix}`,
        };
      }
    }

    return {
      tier: "codex",
      action: "relay_to_codex",
      reason: `runtime_permission (${perm.tool}) did not match auto-approval allowlist`,
    };
  }

  return {
    tier: "human",
    action: "require_human",
    reason: `Unknown card kind "${String(card.kind)}" requires human review`,
  };
}

/**
 * Guards manual linger_decide_card calls so Codex cannot bypass Linger UI-only
 * or unconfirmed high-risk boundaries.
 */
export function validateManualDecision(
  card: DecisionRequestedMessageCard | undefined,
  decision: DecisionAnswerAction,
  humanConfirmed: boolean,
  policy: ApprovalPolicyConfig
): { allowed: true } | { allowed: false; reason: string } {
  if (!card) {
    if (decision === "approve" && !humanConfirmed) {
      return {
        allowed: false,
        reason:
          "Cannot approve an uncached decision card without inspecting its kind first (pass room_id + message_id, or set human_confirmed=true after human review).",
      };
    }
    return { allowed: true };
  }

  if (card.status !== "pending") {
    return {
      allowed: false,
      reason: `Card "${card.decision_id}" is not pending (current status: ${card.status}).`,
    };
  }

  if (LINGER_UI_ONLY_KINDS.has(card.kind) && decision !== "deny") {
    return {
      allowed: false,
      reason: `Card kind "${card.kind}" cannot be approved via MCP API; complete it in Linger/OS or only submit decision="deny".`,
    };
  }

  if (HIGH_RISK_HUMAN_ONLY_KINDS.has(card.kind) && decision === "approve") {
    const relayPermitted = policy.mode === "relay" || policy.allowHumanConfirmedRelay;
    if (!relayPermitted || !humanConfirmed) {
      return {
        allowed: false,
        reason: `High-risk card kind "${card.kind}" requires explicit human approval in Linger (or human_confirmed=true in relay mode).`,
      };
    }
  }

  if (card.kind === "question" && decision !== "submit") {
    return {
      allowed: false,
      reason: `Question cards only accept decision="submit" with answers.`,
    };
  }

  return { allowed: true };
}
