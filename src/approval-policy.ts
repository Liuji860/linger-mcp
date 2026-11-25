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

/** Linger-UI-only kinds that forbid comment even on deny (decisions.go:450, 459). */
const DENY_WITHOUT_COMMENT_KINDS: ReadonlySet<DecisionKind> = new Set([
  "connection_auth",
  "provider_key",
  "browser_connection",
  "computer_permission",
  "search_key",
]);

/** High-impact mutations that must never be auto-approved without human sign-off. */
export const HIGH_RISK_HUMAN_ONLY_KINDS: ReadonlySet<DecisionKind> = new Set([
  "connector_write",
  "agent_change",
  "room_creation",
]);

/** Shell metacharacters, quotes, globs, and control/Unicode separators disqualified from auto-approval. */
const SHELL_METACHAR_RE = /[;&|`$><\\()\[\]{}*?~!#\r\n'"\u0000-\u001f\u007f\u0085\u2028\u2029]/;
const UNICODE_NON_ASCII_SPACE_RE = /[^\S ]/;

/** Built-in high-risk tokens, flags, traversal, and sensitive credential paths blocked from auto-approval. */
const BUILTIN_DENY_RE: RegExp[] = [
  /\b(?:rm|rmdir|mv|cp|ln|sudo|su|doas|chmod|chown|chgrp|curl|wget|nc|ncat|ssh|scp|sftp|rsync|eval|exec|dd|mkfs|fdisk|diskutil|launchctl|killall|pkill|shutdown|reboot|security|pbcopy|osascript|tee|xargs|find)\b/i,
  /\b(?:python[\d.]*|node|bash|sh|zsh|dash|ksh|perl|ruby)\b.*(?:\s-[a-zA-Z]*[cepm]|--eval\b|--print\b)/i,
  /(?:^|[\s/"'=:,(\[])(\.ssh|\.env(?:\.|$|\b)|\.teamhub|linger-mcp|session\.json|\.aws|\.kube|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.docker|\.git-credentials|keychains?|id_rsa|id_ed25519|\/etc\/shadow|\/etc\/passwd)/i,
  /(?:^|[\\/\s"'])\.\.(?:[\\/\s"']|$)/,
  /(?:^|\s)--?(?:force|rf|fr|exec|eval|require|import|prefix|script-shell|output|ext-diff|no-index|project|outDir|plugin|git-dir|work-tree|exec-path|textconv|config)\b/i,
  /(?:^|\s)-(?:C|c|p)\b/,
  /(?:^|\s)--(?:\s|$)/,
];

const BUILTIN_SAFE_COMMAND_PREFIXES = new Set([
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
]);

function normalizeAsciiSpaces(text: string): string | null {
  if (UNICODE_NON_ASCII_SPACE_RE.test(text)) {
    return null;
  }
  return text.trim().replace(/ +/g, " ");
}

function collectStrings(value: unknown, out: string[], depth: number = 0): void {
  if (depth > 8 || out.length > 200) {
    return;
  }
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out, depth + 1);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectStrings(v, out, depth + 1);
    }
  }
}

const COMMAND_KEYS = new Set(["command", "cmd", "CommandLine", "command_line"]);

/**
 * Extracts a single shell command from runtime_permission.input.
 * Fails closed (returns null) if a JSON object contains multiple command keys
 * or uninspected execution keys (args, argv, env, script, cwd, etc.).
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
    const entries = Object.entries(parsed);
    if (entries.length !== 1) {
      return null;
    }
    const entry = entries[0];
    if (!entry || !COMMAND_KEYS.has(entry[0]) || typeof entry[1] !== "string") {
      return null;
    }
    const value = entry[1].trim();
    return value.length > 0 ? value : null;
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

function isSafeCommandArgs(matchedPrefix: string, normalizedCommand: string): boolean {
  const rest = normalizedCommand.slice(matchedPrefix.length).trim();
  if (!rest) {
    return true;
  }
  const tokens = rest.split(" ");
  if (tokens.some((tok) => tok.startsWith("/"))) {
    return false;
  }
  if (BUILTIN_SAFE_COMMAND_PREFIXES.has(matchedPrefix)) {
    if (matchedPrefix === "pwd") {
      return false;
    }
    if (matchedPrefix === "tsc") {
      return rest === "--noEmit";
    }
    if (matchedPrefix.startsWith("npm ")) {
      return false;
    }
  }
  return true;
}

function matchesCommandPrefix(command: string, prefixes: string[]): string | null {
  const normalizedCommand = normalizeAsciiSpaces(command);
  if (!normalizedCommand) {
    return null;
  }
  for (const rawPrefix of prefixes) {
    const prefix = normalizeAsciiSpaces(rawPrefix);
    if (!prefix) {
      continue;
    }
    if (
      (normalizedCommand === prefix || normalizedCommand.startsWith(prefix + " ")) &&
      isSafeCommandArgs(prefix, normalizedCommand)
    ) {
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

function buildInspectableTexts(card: DecisionRequestedMessageCard): string[] {
  const perm = card.runtime_permission;
  if (!perm) {
    return [];
  }
  const texts = [perm.title, perm.tool, perm.input, perm.patch ?? "", perm.script?.body ?? ""];
  if (perm.input.trim().startsWith("{")) {
    try {
      collectStrings(JSON.parse(perm.input), texts);
    } catch {
      // Raw text is already included.
    }
  }
  return texts;
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

    const inspectableTexts = buildInspectableTexts(card);
    const matchedDeny = matchesAnyDenyPattern(inspectableTexts, policy.denyPatterns);
    if (matchedDeny) {
      return {
        tier: "codex",
        action: "relay_to_codex",
        reason: `Blocked from auto-approval by deny rule (${matchedDeny.source}); escalated for review`,
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

function validateQuestionAnswers(
  card: DecisionRequestedMessageCard,
  answers: Record<string, string | string[]> | undefined
): string | null {
  const questions = card.question?.questions;
  if (!questions || !answers) {
    return "Question cards require answers matching all question IDs.";
  }
  const answerKeys = Object.keys(answers);
  if (answerKeys.length !== questions.length) {
    return `Expected answers for ${questions.length} question(s), received ${answerKeys.length}.`;
  }
  for (const q of questions) {
    const val = answers[q.id];
    if (q.input === "radio") {
      if (typeof val !== "string" || val.trim().length === 0) {
        return `Question "${q.id}" (radio) requires a non-empty string answer.`;
      }
    } else if (q.input === "checkbox") {
      if (!Array.isArray(val) || val.length === 0 || !val.every((v) => typeof v === "string" && v.trim().length > 0)) {
        return `Question "${q.id}" (checkbox) requires a non-empty string array answer.`;
      }
    }
  }
  return null;
}

/**
 * Guards manual linger_decide_card calls so Codex cannot bypass Linger UI-only,
 * manual-mode, or unconfirmed high-risk boundaries.
 */
export function validateManualDecision(
  card: DecisionRequestedMessageCard | undefined,
  decision: DecisionAnswerAction,
  humanConfirmed: boolean,
  policy: ApprovalPolicyConfig,
  options?: { comment?: string; answers?: Record<string, string | string[]> },
  nowMs: number = Date.now()
): { allowed: true } | { allowed: false; reason: string } {
  if (!card) {
    return {
      allowed: false,
      reason:
        "Cannot decide an uncached card without inspecting it first (pass room_id + message_id so policy can verify card kind and version).",
    };
  }

  const canCancelAuthorizing =
    card.kind === "connection_auth" && card.status === "authorizing" && decision === "deny";
  if (card.status !== "pending" && !canCancelAuthorizing) {
    return {
      allowed: false,
      reason: `Card "${card.decision_id}" is not pending (current status: ${card.status}).`,
    };
  }

  if (isExpired(card, nowMs)) {
    return {
      allowed: false,
      reason: `Card "${card.decision_id}" has expired.`,
    };
  }

  if (policy.mode === "manual" && decision !== "deny") {
    return {
      allowed: false,
      reason: `Manual approval mode does not permit "${decision}" via MCP; decide directly in Linger.`,
    };
  }

  const hasComment = Boolean(options?.comment && options.comment.trim().length > 0);
  const hasAnswers = Boolean(options?.answers && Object.keys(options.answers).length > 0);

  if (LINGER_UI_ONLY_KINDS.has(card.kind)) {
    if (decision !== "deny") {
      return {
        allowed: false,
        reason: `Card kind "${card.kind}" cannot be approved via MCP API; complete it in Linger/OS or only submit decision="deny".`,
      };
    }
    if (hasAnswers) {
      return { allowed: false, reason: `Card kind "${card.kind}" does not accept answers.` };
    }
    if (hasComment && DENY_WITHOUT_COMMENT_KINDS.has(card.kind)) {
      return {
        allowed: false,
        reason: `TeamHub forbids comment on deny for card kind "${card.kind}".`,
      };
    }
    return { allowed: true };
  }

  if (HIGH_RISK_HUMAN_ONLY_KINDS.has(card.kind)) {
    if (decision !== "approve" && decision !== "deny") {
      return { allowed: false, reason: `Card kind "${card.kind}" only accepts "approve" or "deny".` };
    }
    if (hasAnswers) {
      return { allowed: false, reason: `Card kind "${card.kind}" does not accept answers.` };
    }
    if (decision === "approve") {
      const relayPermitted = policy.mode === "relay" || policy.allowHumanConfirmedRelay;
      if (!relayPermitted || !humanConfirmed) {
        return {
          allowed: false,
          reason: `High-risk card kind "${card.kind}" requires explicit human approval in Linger (or human_confirmed=true in relay mode).`,
        };
      }
      if (hasComment) {
        return { allowed: false, reason: "TeamHub forbids comment when decision is approve." };
      }
    }
    if (decision === "deny" && card.kind === "room_creation" && !hasComment) {
      return { allowed: false, reason: 'Denying a "room_creation" card requires a non-empty comment.' };
    }
    return { allowed: true };
  }

  if (card.kind === "question") {
    if (decision !== "submit") {
      return { allowed: false, reason: 'Question cards only accept decision="submit" with answers.' };
    }
    const err = validateQuestionAnswers(card, options?.answers);
    if (err) {
      return { allowed: false, reason: err };
    }
    return { allowed: true };
  }

  if (card.kind === "runtime_permission") {
    if (decision !== "approve" && decision !== "deny") {
      return { allowed: false, reason: 'runtime_permission cards only accept "approve" or "deny".' };
    }
    if (hasAnswers) {
      return { allowed: false, reason: "runtime_permission cards do not accept answers." };
    }
    if (decision === "approve" && hasComment) {
      return { allowed: false, reason: "TeamHub forbids comment when decision is approve." };
    }
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Unknown card kind "${String(card.kind)}" cannot be decided via MCP.`,
  };
}
