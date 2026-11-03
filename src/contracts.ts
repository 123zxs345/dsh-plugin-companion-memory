/** Stable boundary between companion policy, durable state and replaceable memory engines. */
export type ProfileDomain = 'persona' | 'user' | 'relationship';
export interface SourceEvent {
  id: string;
  companionId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  occurredAt: string;
  visibility: 'private' | 'group';
  toolVerified?: boolean;
  /** Additive source metadata (schema v3). Adapters may supply it; omitted values are derived. */
  origin?: SourceOrigin;
  subject?: SourceSubject;
  contentMode?: ContentMode;
  revision?: number;
  receivedAt?: string;
  learning?: LearningMode;
  hostRef?: string;
  channelRef?: string;
  /** Required when origin is 'verified-tool': must name a completed registered receipt. */
  toolReceiptId?: string;
}
export interface CompanionSeed {
  id: string;
  name: string;
  anchors: Record<string, string>;
}
export interface ProfileChange {
  domain: ProfileDomain;
  key: string;
  value: string;
  evidenceEventId: string;
  evidenceQuote: string;
  certainty: 'explicit' | 'inferred';
  reason: string;
  scope?: string;
  expectedVersion?: number;
}
export interface ProfileEntry {
  domain: ProfileDomain;
  key: string;
  value: string;
  certainty: 'anchor' | 'explicit' | 'inferred';
  scope: string;
  sourceEventId: string | null;
  version: number;
  updatedAt: string;
}
export interface MemoryJob {
  id: number;
  companionId: string;
  documentId: string;
  operation: 'retain' | 'delete';
  attempts: number;
  leaseToken: string;
}
export interface MemoryHit {
  /** Actual semantic cosine score, never rank position or importance. */
  similarity?: number;
  id: string;
  text: string;
  documentId: string;
  type: 'world' | 'experience';
}
export interface MemoryBackend {
  retain(event: SourceEvent): Promise<void>;
  recall(companionId: string, query: string, maxTokens: number): Promise<MemoryHit[]>;
  deleteDocument(companionId: string, documentId: string): Promise<void>;
  health(): Promise<boolean>;
}

/* ---------------------------------------------------------------------------
 * Additive contracts for source metadata, evidence-backed profile facts and
 * native asynchronous backend operations (schema v3/v4). No existing field or
 * type is removed or renamed.
 * ------------------------------------------------------------------------- */

export type SourceOrigin = 'owner' | 'assistant' | 'verified-tool' | 'external' | 'derived';
export type SourceSubject = 'owner' | 'companion' | 'third-party' | 'fictional' | 'unknown';
export type ContentMode = 'real' | 'roleplay' | 'quotation' | 'hypothetical' | 'unknown';
export type LearningMode = 'enabled' | 'temporary';

export interface EventMetadata {
  companionId: string;
  eventId: string;
  origin: SourceOrigin;
  subject: SourceSubject;
  mode: ContentMode;
  revision: number;
  receivedAt: string;
  sessionSeq: number;
  learning: LearningMode;
  hostRef?: string;
  channelRef?: string;
  toolReceiptId?: string;
}

export type ToolReceiptState = 'accepted' | 'running' | 'waiting-user' | 'completed' | 'failed' | 'unknown' | 'cancelled';
export interface ToolReceipt {
  id: string;
  companionId: string;
  state: ToolReceiptState;
  actionId?: string;
  idempotencyKey?: string;
  checkedAt: string;
  resultHash?: string;
}

/** Evidence must carry the source revision it was read at; stale revisions do not support facts. */
export type EvidenceRef =
  | { kind: 'quote'; eventId: string; sourceRevision: number; quote: string }
  | { kind: 'tool-receipt'; receiptId: string; resultHash: string };

export interface StoredEvidence {
  eventId: string;
  sourceRevision: number;
  quote: string;
  receiptId?: string;
  resultHash?: string;
}

export type FactStatus = 'active' | 'historical' | 'corrected' | 'suppressed' | 'forgotten';
export interface ProfileFact {
  id: string;
  companionId: string;
  domain: ProfileDomain;
  key: string;
  value: string;
  scope: string;
  certainty: 'anchor' | 'explicit' | 'inferred';
  revision: number;
  recordedAt: string;
  validFrom: string | null;
  validTo: string | null;
  status: FactStatus;
  reason: string;
  evidence: StoredEvidence[];
}

export type CandidateIntent = 'add' | 'change-over-time' | 'correct' | 'retract';
export type CandidateStatus = 'proposed' | 'committed' | 'rejected' | 'expired' | 'invalidated';
export interface ProfileCandidateInput {
  domain: ProfileDomain;
  key: string;
  value: string;
  scope?: string;
  certainty: 'explicit' | 'inferred';
  intent?: CandidateIntent;
  evidence: EvidenceRef[];
  validFrom?: string | null;
  validTo?: string | null;
  expectedVersion?: number;
  reason: string;
}
export interface ProfileCandidate {
  id: string;
  companionId: string;
  domain: ProfileDomain;
  key: string;
  value: string;
  scope: string;
  certainty: 'explicit' | 'inferred';
  intent: CandidateIntent;
  status: CandidateStatus;
  baseVersion: number;
  reason: string;
  createdAt: string;
  updatedAt: string;
  /** ISO expiry for an uncommitted proposal; absent on decided candidates. */
  expiresAt?: string | null;
}
export type CandidateDecision =
  | { kind: 'commit'; fact: ProfileFact; newEpoch: number }
  | { kind: 'hold'; reasonCode: string }
  | { kind: 'reject'; reasonCode: string }
  | { kind: 'conflict'; currentVersion: number };

export type CleanupState = 'not-requested' | 'pending' | 'done' | 'blocked' | 'unknown';
export type ForgetMode = 'deprioritize' | 'suppress' | 'erase';
export interface ForgetRequest {
  id: string;
  companionId: string;
  eventIds: string[];
  mode: ForgetMode;
  stateEpoch: number;
  local: CleanupState;
  backend: CleanupState;
  operationPayloads: CleanupState;
  hostHistory: CleanupState;
  backups: 'not-included' | CleanupState;
  unresolved: string[];
  createdAt: string;
  updatedAt: string;
}
export interface ForgetReceipt {
  requestId: string;
  stateEpoch: number;
  local: CleanupState;
  backend: CleanupState;
  operationPayloads: CleanupState;
  hostHistory: CleanupState;
  backups: 'not-included' | CleanupState;
  unresolved: string[];
}

export type OperationState =
  | 'pending' | 'submitted' | 'processing' | 'completed' | 'failed'
  | 'unknown' | 'cancel_requested' | 'cleanup_pending' | 'erased';

export interface BackendOperation {
  companionId: string;
  operationId: string;
  documentId: string;
  sourceRevision: number;
  /** Null once the derived payload is proven erased; old rows may also lack it. */
  payloadHash: string | null;
  state: OperationState;
  attempts: number;
  nextCheckAt: number;
  lastCheckedAt: number | null;
  submittedAt: number | null;
  completedAt: number | null;
  errorCode: string | null;
  /** 'done' records confirmed whole-family payload erasure; cleanup_pending may still owe final document DELETE. */
  cleanupState: CleanupState;
  /** 0 cannot prove old requests obeyed the single-POST protocol. */
  submissionProtocolVersion: 0 | 1;
  /** 1 acknowledges the whole payload family under the current protocol. */
  payloadErasureVersion: 0 | 1;
}

export type BackendOperationStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'not_found';

/** Optional capability: native async retain with durable operation identities. */
export interface AsyncOperationBackend extends MemoryBackend {
  /**
   * How a scheduler should drive this backend. 'sync' keeps the legacy lease
   * queue; 'async' uses the durable operation state machine. Absent means
   * async (a fake or a dedicated async adapter owns no lease queue).
   */
  readonly operationMode?: 'sync' | 'async';
  /** Absent is conservative. Only 'quiescent' promises an accepted cancel joins acknowledged writes. */
  readonly cancellationGuarantee?: 'cooperative' | 'quiescent';
  submitRetain(event: SourceEvent, operationId: string): Promise<{ operationId: string; state: 'submitted' | 'processing' }>;
  operationStatus(companionId: string, operationId: string): Promise<{ state: BackendOperationStatus; errorCode?: string }>;
  /** True acknowledges cancellation; it is not a write-settlement proof without an explicit quiescent guarantee. */
  cancelOperation(companionId: string, operationId: string): Promise<boolean>;
  /** Call after local write-settlement proof. Missing parents need explicit local never-sent proof. */
  deleteOperationPayload(companionId: string, operationId: string, proof?: {neverAttempted?:true}): Promise<boolean>;
}
