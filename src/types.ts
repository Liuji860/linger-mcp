export type ActorKind = "human" | "agent";

export interface ActorRef {
  id: string;
  tenant_id: string;
  kind: ActorKind;
  display_name: string;
}

export interface Actor extends ActorRef {
  account_id?: string;
  handle?: string;
  email?: string;
  created_at: string;
}

export interface CurrentIdentity {
  account: {
    id: string;
    email: string;
    created_at: string;
  };
  actors: Actor[];
  server_capabilities?: string[];
}

export interface Session {
  id: string;
  account_id: string;
  created_at: string;
  expires_at: string;
  identity: CurrentIdentity;
}

export interface PageMeta {
  next_cursor?: string;
  has_more: boolean;
}

export interface TenantAgent {
  actor: Actor;
  agent_management_id: string;
  agent_type: "general" | "anotherme";
  description: string;
  configuration_revision: number;
  instructions: string;
  runtime: {
    model: string;
    reasoning_effort?: string;
    placement?: {
      type: "local";
      computer_id?: string;
      runtime_type?: string;
      workspace_grant_id?: string;
    };
  };
  visibility_scope: "sponsor" | "workspace";
  created_by: ActorRef;
  created_at: string;
  updated_at: string;
}

export interface TenantAgentPage {
  items: TenantAgent[];
  page: PageMeta;
}

export type AgentAvailabilityStatus = "online" | "error" | "offline" | "unknown";

export interface TenantAgentAvailabilitySnapshot {
  actor_id: string;
  availability: {
    status: AgentAvailabilityStatus;
    label: string;
    reason?: string;
    active_task_count: number;
    current_activity?: {
      summary: string;
      run_id?: string;
      work_item_id?: string;
    };
  };
}

export interface TenantAgentAvailabilityPage {
  items: TenantAgentAvailabilitySnapshot[];
  page: PageMeta;
}

export type RoomKind = "room" | "direct" | "thread";

export interface Room {
  id: string;
  tenant_id: string;
  kind: RoomKind;
  name: string;
  description?: string;
  created_by: ActorRef;
  created_at: string;
  updated_at: string;
  direct_peer?: ActorRef;
  direct_peer_active?: boolean;
  snapshot_room_seq?: number;
}

export interface RoomListItem extends Room {
  latest_room_seq: number;
  read_through_room_seq: number;
  unread_message_count: number;
  unread_mention_count: number;
}

export interface RoomPage {
  items: RoomListItem[];
  page: PageMeta;
}

export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "reference"; content: string; target: string; target_type: "user" | "agent" }
  | { type: "document"; content: string; document_id: string; presentation?: "inline" | "card" | "canvas" }
  | { type: "file"; content: string; document_id: string; document_version_id: string; filename?: string; media_type?: string }
  | { type: string; content: string; [key: string]: unknown };

export interface MessageAttachment {
  id: string;
  document_id: string;
  document_version_id: string;
  source_room_id?: string;
  filename: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  available: boolean;
}

export type DecisionKind =
  | "connector_write"
  | "agent_change"
  | "question"
  | "runtime_permission"
  | "profile_setup_apps"
  | "profile_setup_sources"
  | "connection_auth"
  | "provider_key"
  | "browser_connection"
  | "room_creation"
  | "computer_permission"
  | "search_key";

export type DecisionStatus =
  | "pending"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "unknown"
  | "denied"
  | "expired"
  | "answered"
  | "consumed"
  | "authorizing";

export interface RuntimePermissionDecisionView {
  kind: "code" | "gui";
  title: string;
  rationale: string;
  tool: string;
  input: string;
  script?: { path: string; sha256?: string; body: string };
  patch?: string;
  page?: { url: string; title?: string; target_role?: string; target_name?: string };
  screenshot?: { url: string; width: number; height: number };
}

export interface DecisionQuestionOption {
  id: string;
  label: string;
}

export interface DecisionQuestion {
  id: string;
  prompt: string;
  input: "radio" | "checkbox";
  options: DecisionQuestionOption[];
}

export interface QuestionDecisionView {
  questions: DecisionQuestion[];
}

export interface ConnectorWriteDecisionView {
  kind: "message" | "change";
  app: string;
  title: string;
  account: string;
  tool: string;
  input: string;
  message?: {
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    destination?: string;
    body: string;
    format: string;
  };
  fields?: Array<{ label: string; value: string }>;
}

export interface AgentChangeDecisionView {
  action: "create" | "update";
  target_actor_id?: string;
  agent_name: string;
  changes: Array<{ field: string; before?: string; after: string }>;
}

export interface DecisionRequestedMessageCard {
  card_type: "personal_notice";
  intent: "decision_requested";
  version: number;
  decision_owner: { id: string; kind: "human"; display_name: string };
  requester: { id: string; kind: ActorKind; display_name: string };
  decision_id: string;
  kind: DecisionKind;
  title: string;
  status: DecisionStatus;
  outcome?: string;
  expires_at?: string;
  decided_at?: string;
  runtime_permission?: RuntimePermissionDecisionView;
  question?: QuestionDecisionView;
  connector_write?: ConnectorWriteDecisionView;
  agent_change?: AgentChangeDecisionView;
  connection_auth?: { app_key: string; account?: string; connection_id?: string };
  provider_key?: { app_key?: string };
  browser_connection?: { computer_id: string };
  computer_permission?: { computer_id: string; subject: string; permissions: string[]; reason?: string };
  search_key?: { backend: string; origin: string; reason: string };
  room_creation?: { name: string; description?: string; member_ids: string[]; origin_room_id: string };
  profile_setup?: { apps?: string[]; more_apps?: string[] };
}

export type MessageKind = "conversation" | "agent_runtime" | "room_notice";

export interface Message {
  id: string;
  tenant_id: string;
  room_id: string;
  author: ActorRef;
  message_kind: MessageKind;
  raw_message: string;
  segments: MessageSegment[];
  attachments: MessageAttachment[];
  card?: DecisionRequestedMessageCard;
  card_context_message_id?: string;
  reply_to_message_id?: string;
  created_at: string;
}

export interface MessagePage {
  items: Message[];
  page: PageMeta;
  snapshot_room_seq: number;
}

export type RoomRunState = "active" | "completed" | "aborted";

export interface RoomRunStatus {
  run_id: string;
  room_id: string;
  replied: boolean;
  agent: { id: string; kind: "agent"; display_name: string };
  status: RoomRunState;
  event_ordinal: number;
  stop_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface RoomRunStatusList {
  items: RoomRunStatus[];
}

export interface RoomRunCancelResult {
  run_id: string;
  status: string;
  agent_actor_id?: string;
  message_ids?: string[];
}

export type RoomEventPayload =
  | { kind: "message.created"; message: Message }
  | { kind: "card.changed"; message_id: string; version: number }
  | { kind: "agent_run.status_changed"; run: RoomRunStatus }
  | { kind: string; [key: string]: unknown };

export interface RoomEventEnvelope {
  event_id: string;
  tenant_id: string;
  room_id: string;
  room_seq: number;
  occurred_at: string;
  event_type: string;
  actor?: ActorRef;
  payload: RoomEventPayload;
}

export interface RoomEventPage {
  items: RoomEventEnvelope[];
  latest_room_seq: number;
  has_more: boolean;
}

export type DecisionAnswerAction = "approve" | "deny" | "submit";

export interface DecisionRequest {
  expected_version: number;
  decision: DecisionAnswerAction;
  comment?: string;
  answers?: Record<string, string | string[]>;
}

export type ApprovalMode = "tiered" | "relay" | "manual";
export type RoomMode = "bridge" | "direct";

export interface ApprovalPolicyConfig {
  mode: ApprovalMode;
  allowedTools: string[];
  allowedCommandPrefixes: string[];
  denyPatterns: RegExp[];
  allowGuiAutoApprove: boolean;
  allowHumanConfirmedRelay: boolean;
}

export interface LingerMcpConfig {
  baseUrl: string;
  email?: string;
  password?: string;
  keychainService?: string;
  sessionFile: string;
  localIdentityKey?: string;
  localIdentityOrigin?: string;
  roomMode: RoomMode;
  bridgeRoomName: string;
  approvalPolicy: ApprovalPolicyConfig;
  pollIntervalMs: number;
  defaultWaitSeconds: number;
  maxConcurrency: number;
  requestTimeoutMs: number;
}

export type ApprovalTier = "auto" | "codex" | "human";
export type ApprovalAction = "auto_approve" | "relay_to_codex" | "require_human";

export interface ApprovalEvaluation {
  tier: ApprovalTier;
  action: ApprovalAction;
  reason: string;
  matchedRule?: string;
}

export interface PendingCardInfo {
  message_id: string;
  room_id: string;
  decision_id: string;
  version: number;
  kind: DecisionKind;
  title: string;
  status: DecisionStatus;
  expires_at?: string;
  tier: ApprovalTier;
  action: ApprovalAction;
  policy_reason: string;
  codex_can_decide: boolean;
  details: Record<string, unknown>;
}

export interface AutoApprovalAuditEntry {
  decision_id: string;
  version: number;
  kind: DecisionKind;
  title: string;
  matched_rule: string;
  outcome: "approved" | "conflict_or_expired" | "error";
  error?: string;
}

export type JobStatus = "running" | "completed" | "aborted" | "pending_approval";

export interface JobRecord {
  id: string;
  roomId: string;
  agentActorId: string;
  agentName: string;
  prompt: string;
  triggerMessageId: string;
  seenTrigger: boolean;
  cursorSeq: number;
  runId?: string;
  runStatus?: RoomRunState;
  replied: boolean;
  stopReason?: string;
  status: JobStatus;
  replies: Message[];
  replyMessageIds: Set<string>;
  cardsByMessageId: Map<string, DecisionRequestedMessageCard>;
  processedCardVersions: Map<string, string>;
  autoApprovals: AutoApprovalAuditEntry[];
  createdAt: string;
  updatedAt: string;
}
