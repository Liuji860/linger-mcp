import { randomUUID } from "node:crypto";
import { evaluateDecisionCard, validateManualDecision } from "./approval-policy.js";
import { LingerApiError, LingerClient } from "./client.js";
import type {
  ApprovalEvaluation,
  DecisionAnswerAction,
  DecisionRequestedMessageCard,
  JobRecord,
  LingerMcpConfig,
  Message,
  MessageAttachment,
  MessageSegment,
  PendingCardInfo,
  RoomEventEnvelope,
  RoomMode,
  RoomRunStatus,
  TenantAgent,
  TenantAgentAvailabilitySnapshot,
} from "./types.js";

const MAX_TERMINAL_JOBS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeCardDetails(card: DecisionRequestedMessageCard): Record<string, unknown> {
  switch (card.kind) {
    case "runtime_permission":
      return { runtime_permission: card.runtime_permission ?? null };
    case "question":
      return { question: card.question ?? null };
    case "connector_write":
      return { connector_write: card.connector_write ?? null };
    case "agent_change":
      return { agent_change: card.agent_change ?? null };
    case "connection_auth":
      return { connection_auth: card.connection_auth ?? null };
    case "provider_key":
      return { provider_key: card.provider_key ?? null };
    case "browser_connection":
      return { browser_connection: card.browser_connection ?? null };
    case "computer_permission":
      return { computer_permission: card.computer_permission ?? null };
    case "search_key":
      return { search_key: card.search_key ?? null };
    case "room_creation":
      return { room_creation: card.room_creation ?? null };
    case "profile_setup_apps":
    case "profile_setup_sources":
      return { profile_setup: card.profile_setup ?? null };
    default:
      return {};
  }
}

export interface AgentDirectoryEntry {
  actor_id: string;
  display_name: string;
  agent_type: "general" | "anotherme";
  description: string;
  model: string;
  visibility_scope: "sponsor" | "workspace";
  availability: TenantAgentAvailabilitySnapshot["availability"] | null;
}

export interface JobResultSnapshot {
  job_id: string;
  status: JobRecord["status"];
  room_id: string;
  agent_actor_id: string;
  agent_name: string;
  run_id?: string;
  run_status?: RoomRunStatus["status"];
  replied: boolean;
  stop_reason?: string;
  reply_text: string;
  replies: Array<{
    message_id: string;
    created_at: string;
    text: string;
    attachments: MessageAttachment[];
  }>;
  pending_cards: PendingCardInfo[];
  auto_approvals: JobRecord["autoApprovals"];
}

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly jobLocks = new Map<string, Promise<unknown>>();
  private inFlightStarts = 0;

  constructor(
    private readonly client: LingerClient,
    private readonly config: LingerMcpConfig
  ) {}

  private withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.jobLocks.get(jobId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.then(
      () => undefined,
      () => undefined
    );
    this.jobLocks.set(jobId, tail);
    void tail.then(() => {
      if (this.jobLocks.get(jobId) === tail) {
        this.jobLocks.delete(jobId);
      }
    });
    return next;
  }

  private pruneTerminalJobs(): void {
    const terminalIds: string[] = [];
    for (const [id, job] of this.jobs.entries()) {
      if (job.status === "completed" || job.status === "aborted") {
        terminalIds.push(id);
      }
    }
    const excess = terminalIds.length - MAX_TERMINAL_JOBS;
    for (let i = 0; i < excess; i++) {
      const id = terminalIds[i];
      if (id) {
        this.jobs.delete(id);
      }
    }
  }

  async listAgentsWithAvailability(): Promise<AgentDirectoryEntry[]> {
    const [agents, availabilityList] = await Promise.all([
      this.client.listAgents(),
      this.client.listAgentAvailability(),
    ]);
    const availabilityMap = new Map(availabilityList.map((item) => [item.actor_id, item.availability]));
    return agents.map((agent) => ({
      actor_id: agent.actor.id,
      display_name: agent.actor.display_name,
      agent_type: agent.agent_type,
      description: agent.description,
      model: agent.runtime.model,
      visibility_scope: agent.visibility_scope,
      availability: availabilityMap.get(agent.actor.id) ?? null,
    }));
  }

  private async resolveAgent(
    agentRef: string
  ): Promise<{ agent: TenantAgent; availability: TenantAgentAvailabilitySnapshot["availability"] | null }> {
    const [agents, availabilityList] = await Promise.all([
      this.client.listAgents(),
      this.client.listAgentAvailability(),
    ]);
    const trimmed = agentRef.trim();
    const byId = agents.find((a) => a.actor.id === trimmed);
    const matches =
      byId !== undefined
        ? [byId]
        : agents.filter((a) => a.actor.display_name.toLowerCase() === trimmed.toLowerCase());

    if (matches.length === 0) {
      const availableNames = agents.map((a) => `${a.actor.display_name} (${a.actor.id})`).join(", ");
      throw new Error(`Agent "${agentRef}" not found. Available agents: ${availableNames || "none"}`);
    }
    if (matches.length > 1) {
      const ids = matches.map((a) => a.actor.id).join(", ");
      throw new Error(`Agent name "${agentRef}" is ambiguous (${ids}); pass the exact actor_id instead.`);
    }
    const agent = matches[0] as TenantAgent;
    const availability = availabilityList.find((item) => item.actor_id === agent.actor.id)?.availability ?? null;
    return { agent, availability };
  }

  private countActiveJobs(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "running" || job.status === "pending_approval") {
        count++;
      }
    }
    return count;
  }

  private hasActiveJobForAgentInRoom(roomId: string, agentActorId: string): boolean {
    for (const job of this.jobs.values()) {
      if (
        job.roomId === roomId &&
        job.agentActorId === agentActorId &&
        (job.status === "running" || job.status === "pending_approval")
      ) {
        return true;
      }
    }
    return false;
  }

  async askAgent(input: {
    agent: string;
    prompt: string;
    roomId?: string;
    roomMode?: RoomMode;
    waitSeconds?: number;
  }): Promise<JobResultSnapshot> {
    if (!input.prompt.trim()) {
      throw new Error("prompt must not be blank");
    }
    if (this.countActiveJobs() + this.inFlightStarts >= this.config.maxConcurrency) {
      throw new Error(
        `Concurrent job limit (${this.config.maxConcurrency}) reached. Finish or cancel existing jobs before starting another.`
      );
    }

    this.inFlightStarts++;
    let job: JobRecord;
    try {
      const { agent, availability } = await this.resolveAgent(input.agent);
      if (availability?.status === "offline") {
        throw new Error(
          `Agent "${agent.actor.display_name}" is currently offline (${availability.label}). Check that its Local Computer is running in Linger.`
        );
      }

      const effectiveMode = input.roomMode ?? this.config.roomMode;
      const room = input.roomId
        ? await this.client.getRoom(input.roomId)
        : effectiveMode === "direct"
          ? await this.client.openDirectRoom(agent.actor.id)
          : await this.client.ensureBridgeRoom(this.config.bridgeRoomName);

      if (room.kind === "direct" && room.direct_peer?.id !== agent.actor.id) {
        throw new Error(
          `Room "${room.id}" is a direct room for peer "${room.direct_peer?.display_name ?? room.direct_peer?.id}", not "${agent.actor.display_name}".`
        );
      }

      if (this.hasActiveJobForAgentInRoom(room.id, agent.actor.id)) {
        throw new Error(
          `Agent "${agent.actor.display_name}" already has an active job in room "${room.id}". Wait for it to finish, cancel it, or specify a different room_id.`
        );
      }

      const baselinePage = await this.client.listMessages(room.id, 1);
      const baselineSeq = baselinePage.snapshot_room_seq;

      const segments: MessageSegment[] =
        room.kind === "direct"
          ? [{ type: "text", content: input.prompt }]
          : [
              {
                type: "reference",
                content: `@${agent.actor.display_name}`,
                target: agent.actor.id,
                target_type: "agent",
              },
              { type: "text", content: ` ${input.prompt}` },
            ];

      const sent = await this.client.sendMessage(room.id, segments);
      const nowIso = new Date().toISOString();
      job = {
        id: `job_${randomUUID()}`,
        roomId: room.id,
        agentActorId: agent.actor.id,
        agentName: agent.actor.display_name,
        prompt: input.prompt,
        triggerMessageId: sent.id,
        seenTrigger: false,
        cursorSeq: baselineSeq,
        replied: false,
        status: "running",
        replies: [],
        replyMessageIds: new Set(),
        cardsByMessageId: new Map(),
        processedCardVersions: new Map(),
        autoApprovals: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.jobs.set(job.id, job);
      this.pruneTerminalJobs();
    } finally {
      this.inFlightStarts--;
    }

    const waitSeconds = input.waitSeconds ?? this.config.defaultWaitSeconds;
    if (waitSeconds <= 0) {
      return this.toSnapshot(job);
    }
    return this.waitForJob(job.id, waitSeconds);
  }

  async waitForJob(jobId: string, waitSeconds?: number): Promise<JobResultSnapshot> {
    return this.withJobLock(jobId, async () => {
      const job = this.jobs.get(jobId);
      if (!job) {
        throw new Error(`Unknown job_id "${jobId}"`);
      }

      if (job.status === "completed" || job.status === "aborted") {
        return this.toSnapshot(job);
      }

      const waitMs = Math.max(0, (waitSeconds ?? this.config.defaultWaitSeconds) * 1000);
      const deadline = Date.now() + waitMs;

      do {
        await this.drainRoomEvents(job);
        await this.evaluateAndHandleCards(job);

        if (job.runStatus === "aborted") {
          job.status = "aborted";
          job.updatedAt = new Date().toISOString();
          this.pruneTerminalJobs();
          return this.toSnapshot(job);
        }

        const pendingCards = this.collectPendingCards(job);
        if (pendingCards.length > 0) {
          job.status = "pending_approval";
          job.updatedAt = new Date().toISOString();
          return this.toSnapshot(job);
        }

        if (job.runStatus === "completed") {
          job.status = "completed";
          job.updatedAt = new Date().toISOString();
          this.pruneTerminalJobs();
          return this.toSnapshot(job);
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          break;
        }
        await sleep(Math.min(this.config.pollIntervalMs, remainingMs));
      } while (Date.now() < deadline);

      job.status = "running";
      job.updatedAt = new Date().toISOString();
      return this.toSnapshot(job);
    });
  }

  private async drainRoomEvents(job: JobRecord): Promise<void> {
    for (let pageCount = 0; pageCount < 500; pageCount++) {
      const page = await this.client.listRoomEvents(job.roomId, job.cursorSeq, 200);
      if (page.items.length === 0) {
        break;
      }
      const prevCursor = job.cursorSeq;
      for (const event of page.items) {
        if (event.room_seq <= job.cursorSeq) {
          continue;
        }
        await this.applyRoomEvent(job, event);
        job.cursorSeq = event.room_seq;
      }
      if (!page.has_more || job.cursorSeq <= prevCursor) {
        break;
      }
    }
  }

  private async applyRoomEvent(job: JobRecord, event: RoomEventEnvelope): Promise<void> {
    const payload = event.payload;
    if (payload.kind === "message.created" && "message" in payload) {
      const msg = payload.message as Message;
      if (msg.id === job.triggerMessageId) {
        job.seenTrigger = true;
        return;
      }
      if (!job.seenTrigger) {
        return;
      }
      if (msg.card && msg.card.intent === "decision_requested") {
        if (msg.card.requester.id === job.agentActorId) {
          job.cardsByMessageId.set(msg.id, msg.card);
        }
        return;
      }
      if (
        msg.author.id === job.agentActorId &&
        msg.message_kind === "conversation" &&
        !job.replyMessageIds.has(msg.id)
      ) {
        job.replyMessageIds.add(msg.id);
        job.replies.push(msg);
      }
      return;
    }

    if (payload.kind === "card.changed" && "message_id" in payload) {
      const messageId = payload.message_id as string;
      if (!job.cardsByMessageId.has(messageId)) {
        return;
      }
      try {
        const updatedMessage = await this.client.getMessage(job.roomId, messageId);
        if (updatedMessage.card) {
          this.setCardIfNewer(job, updatedMessage.id, updatedMessage.card);
        }
      } catch (err) {
        if (err instanceof LingerApiError && err.status === 404) {
          return;
        }
        throw err;
      }
      return;
    }

    if (payload.kind === "agent_run.status_changed" && "run" in payload) {
      if (!job.seenTrigger) {
        return;
      }
      const run = payload.run as RoomRunStatus;
      if (run.agent.id !== job.agentActorId) {
        return;
      }
      job.runId = run.run_id;
      job.runStatus = run.status;
      job.replied = run.replied;
      job.stopReason = run.stop_reason;
    }
  }

  private setCardIfNewer(job: JobRecord, messageId: string, nextCard: DecisionRequestedMessageCard): void {
    const existing = job.cardsByMessageId.get(messageId);
    if (!existing || nextCard.version >= existing.version) {
      job.cardsByMessageId.set(messageId, nextCard);
    }
  }

  private async evaluateAndHandleCards(job: JobRecord): Promise<void> {
    for (const [messageId, card] of job.cardsByMessageId.entries()) {
      if (card.requester.id !== job.agentActorId || card.status !== "pending") {
        continue;
      }
      const versionKey = `${card.decision_id}:${card.version}`;
      if (job.processedCardVersions.has(versionKey)) {
        continue;
      }
      const evaluation: ApprovalEvaluation = evaluateDecisionCard(card, this.config.approvalPolicy);
      if (evaluation.action !== "auto_approve") {
        continue;
      }

      try {
        const updated = await this.client.decideDecision(card.decision_id, {
          expected_version: card.version,
          decision: "approve",
        });
        job.processedCardVersions.set(versionKey, "auto_approve");
        if (updated.card) {
          this.setCardIfNewer(job, messageId, updated.card);
        }
        // Reset runStatus so we wait for the post-approval Agent Run to finish.
        if (job.runStatus === "completed") {
          job.runStatus = undefined;
        }
        job.autoApprovals.push({
          decision_id: card.decision_id,
          version: card.version,
          kind: card.kind,
          title: card.title,
          matched_rule: evaluation.matchedRule ?? "policy",
          outcome: "approved",
        });
      } catch (err) {
        if (err instanceof LingerApiError && err.status === 409) {
          job.processedCardVersions.set(versionKey, "conflict");
          const latest = await this.client.getMessage(job.roomId, messageId).catch(() => null);
          if (latest?.card) {
            this.setCardIfNewer(job, messageId, latest.card);
          }
          job.autoApprovals.push({
            decision_id: card.decision_id,
            version: card.version,
            kind: card.kind,
            title: card.title,
            matched_rule: evaluation.matchedRule ?? "policy",
            outcome: "conflict_or_expired",
            error: err.message,
          });
        } else {
          // Do not lock processedCardVersions on transient errors so the next poll can retry.
          job.autoApprovals.push({
            decision_id: card.decision_id,
            version: card.version,
            kind: card.kind,
            title: card.title,
            matched_rule: evaluation.matchedRule ?? "policy",
            outcome: "error",
            error: (err as Error).message,
          });
        }
      }
    }
  }

  private collectPendingCards(job: JobRecord): PendingCardInfo[] {
    const pending: PendingCardInfo[] = [];
    for (const [messageId, card] of job.cardsByMessageId.entries()) {
      if (card.requester.id !== job.agentActorId || card.status !== "pending") {
        continue;
      }
      const evaluation = evaluateDecisionCard(card, this.config.approvalPolicy);
      pending.push({
        message_id: messageId,
        room_id: job.roomId,
        decision_id: card.decision_id,
        version: card.version,
        kind: card.kind,
        title: card.title,
        status: card.status,
        expires_at: card.expires_at,
        tier: evaluation.tier,
        action: evaluation.action,
        policy_reason: evaluation.reason,
        codex_can_decide: evaluation.action === "relay_to_codex",
        details: summarizeCardDetails(card),
      });
    }
    return pending;
  }

  private findCardByDecisionId(decisionId: string): {
    card: DecisionRequestedMessageCard;
    job: JobRecord;
    messageId: string;
  } | null {
    for (const job of this.jobs.values()) {
      for (const [messageId, card] of job.cardsByMessageId.entries()) {
        if (card.decision_id === decisionId) {
          return { card, job, messageId };
        }
      }
    }
    return null;
  }

  async decideCard(input: {
    decisionId: string;
    expectedVersion?: number;
    decision: DecisionAnswerAction;
    comment?: string;
    answers?: Record<string, string | string[]>;
    humanConfirmed?: boolean;
    roomId?: string;
    messageId?: string;
  }): Promise<{
    ok: boolean;
    status: string;
    decision_id: string;
    card?: DecisionRequestedMessageCard;
    reason?: string;
  }> {
    const cached = this.findCardByDecisionId(input.decisionId);
    const submit = async () => {
      let card = cached?.card;
      if (!card && input.roomId && input.messageId) {
        const message = await this.client.getMessage(input.roomId, input.messageId);
        if (message.card && message.card.decision_id === input.decisionId) {
          card = message.card;
        }
      }

      const validation = validateManualDecision(
        card,
        input.decision,
        input.humanConfirmed ?? false,
        this.config.approvalPolicy,
        { comment: input.comment, answers: input.answers }
      );
      if (!validation.allowed) {
        return {
          ok: false,
          status: "blocked_by_policy",
          decision_id: input.decisionId,
          card,
          reason: validation.reason,
        };
      }

      const expectedVersion = input.expectedVersion ?? card?.version;
      if (!expectedVersion || expectedVersion < 1) {
        throw new Error("expected_version is required when the card is not cached locally");
      }

      try {
        const updated = await this.client.decideDecision(input.decisionId, {
          expected_version: expectedVersion,
          decision: input.decision,
          comment: input.comment,
          answers: input.answers,
        });

        if (cached && updated.card) {
          this.setCardIfNewer(cached.job, cached.messageId, updated.card);
          if (cached.job.runStatus === "completed") {
            cached.job.runStatus = undefined;
          }
          if (this.collectPendingCards(cached.job).length === 0 && cached.job.status === "pending_approval") {
            cached.job.status = "running";
          }
        }

        return {
          ok: true,
          status: updated.card?.status ?? "submitted",
          decision_id: input.decisionId,
          card: updated.card,
        };
      } catch (err) {
        if (err instanceof LingerApiError && err.status === 409) {
          if (cached) {
            const latest = await this.client.getMessage(cached.job.roomId, cached.messageId).catch(() => null);
            if (latest?.card) {
              this.setCardIfNewer(cached.job, cached.messageId, latest.card);
            }
          }
          return {
            ok: false,
            status: "conflict_or_expired",
            decision_id: input.decisionId,
            reason: err.message,
          };
        }
        throw err;
      }
    };

    return cached ? this.withJobLock(cached.job.id, submit) : submit();
  }

  async cancelJob(jobId: string): Promise<Record<string, unknown>> {
    return this.withJobLock(jobId, async () => {
      const job = this.jobs.get(jobId);
      if (!job) {
        throw new Error(`Unknown job_id "${jobId}"`);
      }
      if (job.status === "completed" || job.status === "aborted") {
        return {
          job_id: job.id,
          canceled: false,
          reason: `Job is already in terminal status "${job.status}"`,
        };
      }
      await this.drainRoomEvents(job);
      let runId = job.runId;
      if (!runId) {
        const statuses = await this.client.listRunStatuses(job.roomId);
        runId = statuses.items.find((run) => run.agent.id === job.agentActorId && run.status === "active")?.run_id;
      }
      if (!runId) {
        return {
          job_id: job.id,
          canceled: false,
          reason: "No active run_id found for this job yet",
        };
      }
      const receipt = await this.client.cancelRun(job.roomId, runId);
      job.status = "aborted";
      job.runStatus = "aborted";
      job.updatedAt = new Date().toISOString();
      this.pruneTerminalJobs();
      return {
        job_id: job.id,
        run_id: runId,
        canceled: true,
        receipt,
      };
    });
  }

  private toSnapshot(job: JobRecord): JobResultSnapshot {
    const replies = job.replies.map((msg) => ({
      message_id: msg.id,
      created_at: msg.created_at,
      text: msg.raw_message,
      attachments: msg.attachments,
    }));

    return {
      job_id: job.id,
      status: job.status,
      room_id: job.roomId,
      agent_actor_id: job.agentActorId,
      agent_name: job.agentName,
      run_id: job.runId,
      run_status: job.runStatus,
      replied: job.replied,
      stop_reason: job.stopReason,
      reply_text: replies.map((r) => r.text).join("\n\n"),
      replies,
      pending_cards: this.collectPendingCards(job),
      auto_approvals: [...job.autoApprovals],
    };
  }
}
