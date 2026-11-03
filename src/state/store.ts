/**
 * Durable companion state. Schema v4 keeps the legacy tables working while
 * adding source metadata, epochs, durable native operations, evidence-backed
 * temporal facts and deletion accounting. All previous public methods keep
 * their signatures and behavior.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  BackendOperation,
  CandidateDecision,
  CleanupState,
  CompanionSeed,
  ContentMode,
  EventMetadata,
  EvidenceRef,
  FactStatus,
  ForgetMode,
  ForgetReceipt,
  ForgetRequest,
  LearningMode,
  MemoryJob,
  OperationState,
  ProfileCandidate,
  ProfileCandidateInput,
  ProfileChange,
  ProfileDomain,
  ProfileEntry,
  ProfileFact,
  SourceEvent,
  SourceOrigin,
  SourceSubject,
  StoredEvidence,
  ToolReceipt,
  ToolReceiptState,
} from '../contracts.ts';
import { CURRENT_SCHEMA_VERSION, isSupportedVersion, migrate, type MigrationWarning } from './migrations/index.ts';
import { isLongTermSourceAllowed } from '../memory/source.ts';
import { CompanionMemoryStore, invalidateCompanionSourcesTx, isCompanionSourceEligible } from '../memory/companion-store.ts';
import type { StageEventOptions } from '../memory/companion-types.ts';

export const STATE_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

const MAX_ATTEMPTS = 5;
export const SUBMIT_CLAIM_PREFIX = 'submit-claim:';
export const SUBMIT_CLAIM_MS = 120_000;
const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * 撤销证据的确定性校验：引用本身必须含撤销表达，且能定位到当前值或字段 key。
 * 中英文都支持（既有测试与迁移数据里存在 "I do not drink tea anymore." 一类英文来源）。
 */
const RETRACTION_CUE = /(撤销|撤回|取消记录|取消这条|删除记录|删掉|删了|忘掉|忘记|别再记|不要再记|别记录|不要记录|不用记|不必记|别保存|不要保存|清除|移除|作废|do not|don't|doesn't|no longer|stop|forget|remove|delete|retract)/i;
const domains = new Set<string>(['persona', 'user', 'relationship']);
const ORIGINS: readonly SourceOrigin[] = ['owner', 'assistant', 'verified-tool', 'external', 'derived'];
const SUBJECTS: readonly SourceSubject[] = ['owner', 'companion', 'third-party', 'fictional', 'unknown'];
const MODES: readonly ContentMode[] = ['real', 'roleplay', 'quotation', 'hypothetical', 'unknown'];
const LEARNING: readonly LearningMode[] = ['enabled', 'temporary'];
const RECEIPT_STATES: readonly ToolReceiptState[] = ['accepted', 'running', 'waiting-user', 'completed', 'failed', 'unknown', 'cancelled'];
const FORGET_MODES: readonly ForgetMode[] = ['deprioritize', 'suppress', 'erase'];
const CLEANUP_STATES: readonly CleanupState[] = ['not-requested', 'pending', 'done', 'blocked', 'unknown'];
const OPERATION_STATES: readonly OperationState[] = [
  'pending', 'submitted', 'processing', 'completed', 'failed', 'unknown', 'cancel_requested', 'cleanup_pending', 'erased',
];

export interface StateStoreOptions {
  /**
   * Which storage backs listProfile. Since the migration dual-read comparison passes,
   * the default is the fact-version store; 'materialized' keeps the legacy view available
   * as a fallback without dropping the old table.
   */
  profileReadSource?: 'materialized' | 'facts';
  /** Called for every non-fatal migration warning (for example a snapshot that could not be deleted). */
  onMigrationWarning?: (warning: MigrationWarning) => void;
}

export interface DocumentStatus {
  source: 'active' | 'suppressed' | 'superseded' | 'forgotten' | 'missing';
  remote: 'pending' | 'running' | 'failed' | 'uncertain' | 'retained' | 'deleted' | 'not_applicable';
}

export interface ForgetOutcome {
  requestId: string;
  epoch: number;
  mode: ForgetMode;
  forgotten: string[];
}

export interface ProfileReadComparison {
  consistent: boolean;
  materialized: ProfileEntry[];
  facts: ProfileEntry[];
  differences: string[];
}

export interface PrepareOperationInput {
  documentId: string;
  sourceRevision: number;
  payloadHash: string;
  operationId?: string;
  /** External discovery is not evidence that this application sent exactly one POST. */
  provenance?: 'external-unknown';
}

export interface OperationPatch {
  state?: OperationState;
  attempts?: number;
  nextCheckAt?: number;
  lastCheckedAt?: number | null;
  submittedAt?: number | null;
  completedAt?: number | null;
  errorCode?: string | null;
  cleanupState?: CleanupState;
  /** Null clears the stored payload hash once the remote payload is provably erased. */
  payloadHash?: string | null;
}

export interface ForgetPatch {
  local?: CleanupState;
  backend?: CleanupState;
  operationPayloads?: CleanupState;
  hostHistory?: CleanupState;
  backups?: 'not-included' | CleanupState;
}

interface NormalizedCandidate {
  domain: ProfileDomain;
  key: string;
  value: string;
  scope: string;
  certainty: 'explicit' | 'inferred';
  intent: 'add' | 'change-over-time' | 'correct' | 'retract';
  evidence: EvidenceRef[];
  validFrom: string | null;
  validTo: string | null;
  expectedVersion?: number;
  reason: string;
}

interface CommitInput {
  domain: ProfileDomain;
  key: string;
  value: string;
  scope: string;
  certainty: 'explicit' | 'inferred';
  intent: 'add' | 'change-over-time' | 'correct' | 'retract';
  evidence: EvidenceRef[];
  validFrom: string | null;
  validTo: string | null;
  reason: string;
  forceNewVersion: boolean;
}

interface EventRow {
  id: string;
  companion_id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  occurred_at: string;
  occurred_at_ms: number;
  visibility: 'private' | 'group';
  tool_verified: number | null;
  fingerprint: string;
  forgotten: number;
  superseded: number;
  suppressed: number;
  deprioritized: number;
}

interface MetadataRow {
  companion_id: string;
  event_id: string;
  origin: SourceOrigin;
  subject: SourceSubject;
  mode: ContentMode;
  revision: number;
  received_at: string;
  session_seq: number;
  learning: LearningMode;
  host_ref: string | null;
  channel_ref: string | null;
  tool_receipt_id: string | null;
}

interface ProfileRow {
  domain: ProfileDomain;
  key: string;
  value: string;
  certainty: 'anchor' | 'explicit' | 'inferred';
  scope: string;
  source_event_id: string | null;
  evidence_quote: string;
  reason: string;
  version: number;
  updated_at: string;
}

interface FactRow {
  id: string;
  companion_id: string;
  domain: ProfileDomain;
  key: string;
  value: string;
  scope: string;
  certainty: 'anchor' | 'explicit' | 'inferred';
  reason: string;
  valid_from: string | null;
  valid_to: string | null;
  recorded_at: string;
  revision: number;
  status: FactStatus;
  materialized: number;
  primary_source_id: string | null;
}

interface EvidenceRow {
  fact_version_id: string;
  event_id: string;
  source_revision: number;
  quote: string;
  receipt_id: string | null;
  result_hash: string | null;
}

interface ReceiptRow {
  id: string;
  companion_id: string;
  state: ToolReceiptState;
  action_id: string | null;
  idempotency_key: string | null;
  checked_at: string;
  result_hash: string | null;
}

interface CandidateRow {
  id: string;
  companion_id: string;
  domain: ProfileDomain;
  key: string;
  value: string;
  scope: string;
  certainty: 'explicit' | 'inferred';
  intent: string;
  status: string;
  base_version: number;
  reason: string;
  evidence_json: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

interface OperationRow {
  companion_id: string;
  operation_id: string;
  document_id: string;
  source_revision: number;
  payload_hash: string | null;
  state: OperationState;
  attempts: number;
  next_check_at: number;
  last_checked_at: number | null;
  submitted_at: number | null;
  completed_at: number | null;
  error_code: string | null;
  cleanup_state: CleanupState;
  submission_protocol_version: 0 | 1;
  payload_erasure_version: 0 | 1;
}

interface ForgetRow {
  id: string;
  companion_id: string;
  selector_json: string;
  mode: ForgetMode;
  state_epoch: number;
  local_status: CleanupState;
  backend_status: CleanupState;
  operation_payload_status: CleanupState;
  history_status: CleanupState;
  backup_status: 'not-included' | CleanupState;
  detail_json: string;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  id: number;
  companion_id: string;
  document_id: string;
  operation: 'retain' | 'delete';
  attempts: number;
  status: 'pending' | 'running' | 'failed' | 'done' | 'cancelled';
  lease_token: string | null;
  lease_until: number | null;
}

function bounded(value: string, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error('Invalid ' + label);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max || trimmed.includes(String.fromCharCode(0))) {
    throw new Error('Invalid ' + label);
  }
  return trimmed;
}

function identifier(value: string, label: string): string {
  const trimmed = bounded(value, label, 128);
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code < 32 || code === 127) throw new Error('Invalid ' + label);
  }
  return trimmed;
}

/**
 * Normalize a companion seed's persona anchors exactly the way they are stored:
 * profile keys are validated and values are trimmed to at most 4000 characters.
 * Entry budget validation and ensureCompanion must agree on this shape, otherwise
 * an anchor padded with whitespace is measured against a snapshot the store never
 * writes and a valid budget gets rejected.
 */
export function normalizeAnchors(anchors: unknown): Record<string, string> {
  if (typeof anchors !== 'object' || anchors === null || Array.isArray(anchors)) {
    throw new Error('Invalid anchors');
  }
  const entries = Object.entries(anchors as Record<string, unknown>);
  if (entries.length > 64) throw new Error('Too many anchors');
  const normalized: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value !== 'string') throw new Error('Invalid anchor value');
    normalized[profileKey(key)] = bounded(value, 'anchor value', 4000);
  }
  return normalized;
}

function profileKey(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new Error('Invalid profile key');
  }
  return value;
}

function timestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid ' + label);
  return value;
}

function choice<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error('Invalid ' + label);
  return value as T;
}

function isoOrNull(value: string | null | undefined, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('Invalid ' + label);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64 || Number.isNaN(Date.parse(trimmed))) throw new Error('Invalid ' + label);
  return trimmed;
}

function retractionEvidenceSupports(quote: string, value: string, key: string): boolean {
  if (!RETRACTION_CUE.test(quote)) return false;
  if (value.trim() !== '' && quote.toLowerCase().includes(value.toLowerCase())) return true;
  return quote.includes(key);
}

function asEvent(row: EventRow, metadata?: MetadataRow): SourceEvent {
  const event: SourceEvent = {
    id: row.id,
    companionId: row.companion_id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    occurredAt: row.occurred_at,
    visibility: row.visibility,
  };
  if (row.tool_verified !== null) event.toolVerified = row.tool_verified === 1;
  if (metadata !== undefined) {
    event.origin = metadata.origin;
    event.subject = metadata.subject;
    event.contentMode = metadata.mode;
    event.revision = metadata.revision;
    event.receivedAt = metadata.received_at;
    event.learning = metadata.learning;
    if (metadata.host_ref !== null) event.hostRef = metadata.host_ref;
    if (metadata.channel_ref !== null) event.channelRef = metadata.channel_ref;
    if (metadata.tool_receipt_id !== null) event.toolReceiptId = metadata.tool_receipt_id;
  }
  return event;
}

function asMetadata(row: MetadataRow): EventMetadata {
  const metadata: EventMetadata = {
    companionId: row.companion_id,
    eventId: row.event_id,
    origin: row.origin,
    subject: row.subject,
    mode: row.mode,
    revision: row.revision,
    receivedAt: row.received_at,
    sessionSeq: row.session_seq,
    learning: row.learning,
  };
  if (row.host_ref !== null) metadata.hostRef = row.host_ref;
  if (row.channel_ref !== null) metadata.channelRef = row.channel_ref;
  if (row.tool_receipt_id !== null) metadata.toolReceiptId = row.tool_receipt_id;
  return metadata;
}

function asReceipt(row: ReceiptRow): ToolReceipt {
  const receipt: ToolReceipt = { id: row.id, companionId: row.companion_id, state: row.state, checkedAt: row.checked_at };
  if (row.action_id !== null) receipt.actionId = row.action_id;
  if (row.idempotency_key !== null) receipt.idempotencyKey = row.idempotency_key;
  if (row.result_hash !== null) receipt.resultHash = row.result_hash;
  return receipt;
}

function asProfile(row: ProfileRow): ProfileEntry {
  return {
    domain: row.domain,
    key: row.key,
    value: row.value,
    certainty: row.certainty,
    scope: row.scope,
    sourceEventId: row.source_event_id,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function asFactEntry(row: FactRow): ProfileEntry {
  return {
    domain: row.domain,
    key: row.key,
    value: row.value,
    certainty: row.certainty,
    scope: row.scope,
    sourceEventId: row.primary_source_id,
    version: row.revision,
    updatedAt: row.recorded_at,
  };
}

function asFactView(row: FactRow, evidence: StoredEvidence[]): ProfileFact {
  return {
    id: row.id,
    companionId: row.companion_id,
    domain: row.domain,
    key: row.key,
    value: row.value,
    scope: row.scope,
    certainty: row.certainty,
    revision: row.revision,
    recordedAt: row.recorded_at,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    status: row.status,
    reason: row.reason,
    evidence,
  };
}

function asOperation(row: OperationRow): BackendOperation {
  return {
    companionId: row.companion_id,
    operationId: row.operation_id,
    documentId: row.document_id,
    sourceRevision: row.source_revision,
    payloadHash: row.payload_hash,
    state: row.state,
    attempts: row.attempts,
    nextCheckAt: row.next_check_at,
    lastCheckedAt: row.last_checked_at,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    cleanupState: row.cleanup_state,
    submissionProtocolVersion: row.submission_protocol_version,
    payloadErasureVersion: row.payload_erasure_version,
  };
}

function unresolvedOf(row: ForgetRow): string[] {
  const unresolved: string[] = [];
  if (row.backend_status !== 'done' && row.backend_status !== 'not-requested') unresolved.push('backend:' + row.backend_status);
  if (row.operation_payload_status !== 'done' && row.operation_payload_status !== 'not-requested') {
    unresolved.push('operation-payloads:' + row.operation_payload_status);
  }
  if (row.history_status !== 'done' && row.history_status !== 'not-requested') unresolved.push('host-history:' + row.history_status);
  if (row.backup_status !== 'done' && row.backup_status !== 'not-included') unresolved.push('backups:' + row.backup_status);
  return unresolved;
}

function asForgetRequest(row: ForgetRow): ForgetRequest {
  const parsed = JSON.parse(row.selector_json) as unknown;
  const eventIds = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  return {
    id: row.id,
    companionId: row.companion_id,
    eventIds,
    mode: row.mode,
    stateEpoch: row.state_epoch,
    local: row.local_status,
    backend: row.backend_status,
    operationPayloads: row.operation_payload_status,
    hostHistory: row.history_status,
    backups: row.backup_status,
    unresolved: unresolvedOf(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class StateStore {
  private readonly db: Database.Database;
  readonly companionMemory: CompanionMemoryStore;
  private readonly profileReadSource: 'materialized' | 'facts';
  private readonly migrationWarnings: MigrationWarning[] = [];

  constructor(path: string, options: StateStoreOptions = {}) {
    this.profileReadSource = options.profileReadSource === 'materialized' ? 'materialized' : 'facts';
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    try {
      this.db.pragma('busy_timeout = 5000');
      this.requireSupportedSchema();
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('secure_delete = ON');
      this.db.pragma('journal_mode = WAL');
      migrate(this.db, path, this.migrationWarnings);
      for (const warning of this.migrationWarnings) options.onMigrationWarning?.(warning);
      this.requireSupportedSchema();
      this.companionMemory = new CompanionMemoryStore(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  ensureCompanion(seed: CompanionSeed): void {
    const id = identifier(seed.id, 'companion ID');
    const name = bounded(seed.name, 'companion name', 160);
    const anchors = normalizeAnchors(seed.anchors);
    const canonical = JSON.stringify({ id, name, anchors: Object.keys(anchors).sort().reduce<Record<string, string>>((acc, key) => {
      const value = anchors[key];
      if (value !== undefined) acc[key] = value;
      return acc;
    }, {}) });
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const existing = this.db.prepare('SELECT seed_json FROM companions WHERE id = ?').get(id) as { seed_json: string } | undefined;
      if (existing !== undefined) {
        if (existing.seed_json !== canonical) throw new Error('Conflicting companion seed');
        return;
      }
      this.db.prepare('INSERT INTO companions(id, seed_json) VALUES (?, ?)').run(id, canonical);
      this.db.prepare('INSERT OR IGNORE INTO companion_epochs(companion_id, state_epoch, deletion_watermark) VALUES (?, 0, 0)').run(id);
      const insertProfile = this.db.prepare('INSERT INTO profiles(companion_id, domain, key, scope, value, certainty, source_event_id, evidence_quote, reason, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, \'\', \'\', 1, ?)');
      const insertFact = this.db.prepare('INSERT INTO profile_fact_versions(id, companion_id, domain, key, scope, value, certainty, reason, valid_from, valid_to, recorded_at, revision, status, materialized, primary_source_id) VALUES (?, ?, ?, ?, ?, ?, ?, \'\', NULL, NULL, ?, 1, \'active\', 1, NULL)');
      for (const [key, value] of Object.entries(anchors)) {
        insertProfile.run(id, 'persona', key, 'global', value, 'anchor', now);
        insertFact.run('anchor-' + randomUUID(), id, 'persona', key, 'global', value, 'anchor', now);
      }
    }).immediate();
  }

  ingest(event: SourceEvent): boolean {
    return this.appendEvent(event);
  }

  /** Persist an admitted complete source for API review; duplicates and ineligible sources return false. */
  stageEvent(event: SourceEvent, options: StageEventOptions = { purpose: 'companion' }): boolean {
    const purpose = choice(options.purpose, ['companion', 'task'] as const, 'staged source purpose');
    const taskId = options.taskId === undefined ? undefined : identifier(options.taskId, 'task ID');
    if (purpose === 'task' && taskId === undefined) throw new Error('Task staging requires a trusted task ID');
    if (purpose === 'companion' && taskId !== undefined) throw new Error('Companion purpose cannot carry a task ID');
    return this.appendEvent(event, { purpose, taskId });
  }

  private appendEvent(event: SourceEvent, staging?: StageEventOptions): boolean {
    const id = identifier(event.id, 'event ID');
    const companionId = identifier(event.companionId, 'companion ID');
    const sessionId = identifier(event.sessionId, 'session ID');
    const content = bounded(event.content, 'event content', 32000);
    const occurredAt = bounded(event.occurredAt, 'event timestamp', 64);
    if (Number.isNaN(Date.parse(occurredAt))) throw new Error('Invalid event timestamp');
    if (event.role !== 'user' && event.role !== 'assistant' && event.role !== 'tool') throw new Error('Invalid event role');
    if (event.visibility !== 'private' && event.visibility !== 'group') throw new Error('Invalid event visibility');
    if (event.toolVerified !== undefined && typeof event.toolVerified !== 'boolean') throw new Error('Invalid tool verification');
    if (event.role !== 'tool' && event.toolVerified === true) throw new Error('Invalid tool verification');
    if (event.origin !== undefined) choice(event.origin, ORIGINS, 'event origin');
    if (event.origin === 'derived') throw new Error('Invalid event origin');
    if (event.subject !== undefined) choice(event.subject, SUBJECTS, 'event subject');
    if (event.contentMode !== undefined) choice(event.contentMode, MODES, 'event content mode');
    if (event.learning !== undefined) choice(event.learning, LEARNING, 'event learning mode');
    let revision: number | undefined;
    if (event.revision !== undefined) revision = timestamp(event.revision, 'event revision');
    let receivedAt: string | undefined;
    if (event.receivedAt !== undefined) {
      receivedAt = bounded(event.receivedAt, 'received timestamp', 64);
      if (Number.isNaN(Date.parse(receivedAt))) throw new Error('Invalid received timestamp');
    }
    let hostRef: string | undefined;
    if (event.hostRef !== undefined) hostRef = bounded(event.hostRef, 'host reference', 256);
    let channelRef: string | undefined;
    if (event.channelRef !== undefined) channelRef = bounded(event.channelRef, 'channel reference', 256);
    let toolReceiptId: string | undefined;
    if (event.toolReceiptId !== undefined) toolReceiptId = identifier(event.toolReceiptId, 'tool receipt ID');
    const wantsVerified = event.origin === 'verified-tool';
    if (wantsVerified) {
      if (event.role !== 'tool' || event.toolVerified !== true || toolReceiptId === undefined) {
        throw new Error('Verified tool origin requires a completed tool receipt');
      }
    }
    if (toolReceiptId !== undefined && !wantsVerified) throw new Error('Tool receipt requires verified-tool origin');
    const origin: SourceOrigin = event.origin ?? (event.role === 'user' ? 'owner' : event.role === 'assistant' ? 'assistant' : (event.toolVerified === true && toolReceiptId !== undefined ? 'verified-tool' : 'external'));
    const subject: SourceSubject = event.subject ?? (event.role === 'user' ? (event.visibility === 'private' ? 'owner' : 'third-party') : event.role === 'assistant' ? 'owner' : 'unknown');
    const metadataMode: ContentMode = event.contentMode ?? 'real';
    const metadataRevision = revision ?? 1;
    const metadataReceivedAt = receivedAt ?? occurredAt;
    const learning: LearningMode = event.learning ?? 'enabled';
    const fingerprint = createHash('sha256').update(JSON.stringify([
      id, companionId, sessionId, event.role, content, occurredAt, event.visibility, event.toolVerified ?? null,
      event.origin ?? null, event.subject ?? null, event.contentMode ?? null, revision ?? null, receivedAt ?? null,
      learning, hostRef ?? null, channelRef ?? null, toolReceiptId ?? null,
    ])).digest('hex');
    return this.db.transaction((): boolean => {
      this.requireCompanion(companionId);
      const existing = this.eventRow(companionId, id);
      if (existing !== undefined) {
        if (existing.forgotten === 1) return false;
        if (existing.fingerprint !== fingerprint) throw new Error('Event ID collision');
        return false;
      }
      if (wantsVerified && toolReceiptId !== undefined) {
        const receipt = this.db.prepare('SELECT id, companion_id, state, action_id, idempotency_key, checked_at, result_hash FROM tool_receipts WHERE id = ?').get(toolReceiptId) as ReceiptRow | undefined;
        if (receipt === undefined || receipt.companion_id !== companionId || receipt.state !== 'completed') {
          throw new Error('Verified tool origin requires a completed tool receipt');
        }
      }
      // A rejected new source must not become an unreviewed permanent body with
      // no pending entry. Validation/fingerprinting and existing-ID checks above
      // still run, so replay cannot silently change an existing legacy route.
      if (staging !== undefined && !isCompanionSourceEligible({ ...event, origin, contentMode: metadataMode, learning })) return false;
      this.db.prepare('INSERT INTO events(companion_id, id, session_id, role, content, occurred_at, occurred_at_ms, visibility, tool_verified, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        companionId, id, sessionId, event.role, content, occurredAt, Date.parse(occurredAt), event.visibility,
        event.toolVerified === undefined ? null : event.toolVerified ? 1 : 0, fingerprint,
      );
      const seqRow = this.db.prepare('SELECT COALESCE(MAX(m.session_seq), 0) + 1 AS n FROM event_metadata m JOIN events e ON e.companion_id = m.companion_id AND e.id = m.event_id WHERE e.companion_id = ? AND e.session_id = ?').get(companionId, sessionId) as { n: number };
      this.db.prepare('INSERT INTO event_metadata(companion_id, event_id, origin, subject, mode, revision, received_at, session_seq, learning, host_ref, channel_ref, tool_receipt_id, memory_route) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        companionId, id, origin, subject, metadataMode, metadataRevision, metadataReceivedAt, seqRow.n, learning,
        hostRef ?? null, channelRef ?? null, toolReceiptId ?? null, staging === undefined ? 'legacy' : 'staged',
      );
      if (staging !== undefined) {
        if (staging.taskId !== undefined) this.db.prepare('INSERT OR IGNORE INTO companion_tasks(companion_id, task_id) VALUES (?, ?)').run(companionId, staging.taskId);
        this.db.prepare('INSERT INTO companion_staged_sources(companion_id, event_id, source_revision, purpose, task_id, staged_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(companionId, id, metadataRevision, staging.purpose, staging.taskId ?? null, new Date().toISOString());
        if (staging.taskId !== undefined) this.db.prepare('INSERT INTO companion_task_sources(companion_id,task_id,event_id,source_revision) VALUES (?, ?, ?, ?)').run(companionId, staging.taskId, id, metadataRevision);
        // Append fences older review snapshots without moving the deletion watermark.
        this.db.prepare('UPDATE companion_epochs SET state_epoch = state_epoch + 1 WHERE companion_id = ?').run(companionId);
      } else if (this.isDocumentAllowed(companionId, id)) this.enqueue(companionId, id, 'retain');
      return true;
    }).immediate();
  }

  getEvent(companionId: string, eventId: string): SourceEvent | null {
    const row = this.eventRow(companionId, eventId);
    const compacted = this.db.prepare("SELECT 1 FROM companion_staged_sources WHERE companion_id = ? AND event_id = ? AND status = 'compacted'").get(companionId, eventId);
    return row !== undefined && row.forgotten === 0 && row.suppressed === 0 && !compacted ? asEvent(row, this.metadataRow(companionId, eventId)) : null;
  }

  listEvents(companionId: string, sessionId: string, limit = 12): SourceEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid event limit');
    const rows = this.db.prepare("SELECT * FROM events WHERE companion_id = ? AND session_id = ? AND visibility = 'private' AND forgotten = 0 AND suppressed = 0 AND superseded = 0 AND NOT EXISTS (SELECT 1 FROM companion_staged_sources s WHERE s.companion_id = events.companion_id AND s.event_id = events.id AND s.status = 'compacted') ORDER BY occurred_at_ms DESC, rowid DESC LIMIT ?").all(identifier(companionId, 'companion ID'), identifier(sessionId, 'session ID'), limit) as EventRow[];
    return rows.reverse().map(row => asEvent(row, this.metadataRow(row.companion_id, row.id)));
  }

  eventMetadata(companionId: string, eventId: string): EventMetadata | null {
    const metadata = this.metadataRow(companionId, eventId);
    return metadata === undefined ? null : asMetadata(metadata);
  }

  registerToolReceipt(receipt: ToolReceipt): ToolReceipt {
    const id = identifier(receipt.id, 'tool receipt ID');
    const companionId = identifier(receipt.companionId, 'companion ID');
    const state = choice(receipt.state, RECEIPT_STATES, 'tool receipt state');
    const checkedAt = bounded(receipt.checkedAt, 'tool receipt time', 64);
    if (Number.isNaN(Date.parse(checkedAt))) throw new Error('Invalid tool receipt time');
    const actionId = receipt.actionId === undefined ? null : identifier(receipt.actionId, 'tool action ID');
    const idempotencyKey = receipt.idempotencyKey === undefined ? null : identifier(receipt.idempotencyKey, 'tool idempotency key');
    const resultHash = receipt.resultHash === undefined ? null : bounded(receipt.resultHash, 'tool result hash', 128);
    return this.db.transaction((): ToolReceipt => {
      this.requireCompanion(companionId);
      const existing = this.db.prepare('SELECT id, companion_id, state, action_id, idempotency_key, checked_at, result_hash FROM tool_receipts WHERE id = ?').get(id) as ReceiptRow | undefined;
      if (existing !== undefined) {
        const same = existing.companion_id === companionId && existing.state === state && existing.action_id === actionId && existing.idempotency_key === idempotencyKey && existing.checked_at === checkedAt && existing.result_hash === resultHash;
        if (!same) throw new Error('Tool receipt conflict');
        return asReceipt(existing);
      }
      this.db.prepare('INSERT INTO tool_receipts(id, companion_id, state, action_id, idempotency_key, checked_at, result_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, companionId, state, actionId, idempotencyKey, checkedAt, resultHash);
      return asReceipt({ id, companion_id: companionId, state, action_id: actionId, idempotency_key: idempotencyKey, checked_at: checkedAt, result_hash: resultHash });
    }).immediate();
  }

  toolReceipt(id: string): ToolReceipt | null {
    const row = this.db.prepare('SELECT id, companion_id, state, action_id, idempotency_key, checked_at, result_hash FROM tool_receipts WHERE id = ?').get(identifier(id, 'tool receipt ID')) as ReceiptRow | undefined;
    return row === undefined ? null : asReceipt(row);
  }

  isProfileSource(companionId: string, eventId: string): boolean {
    const row = this.eventRow(companionId, eventId);
    if (row === undefined || row.forgotten === 1 || row.suppressed === 1 || row.superseded === 1) return false;
    const metadata = this.metadataRow(companionId, eventId);
    if (metadata === undefined) return false;
    return this.profileSupportRejection(row, metadata) === null;
  }

  applyProfileChange(companionId: string, change: ProfileChange): ProfileEntry {
    const cid = identifier(companionId, 'companion ID');
    const domain = change.domain;
    if (typeof domain !== 'string' || !domains.has(domain)) throw new Error('Invalid profile domain');
    const key = profileKey(change.key);
    const value = bounded(change.value, 'profile value', 4000);
    const evidenceQuote = bounded(change.evidenceQuote, 'evidence quote', 4000);
    const reason = bounded(change.reason, 'profile reason', 1000);
    const evidenceEventId = identifier(change.evidenceEventId, 'evidence event ID');
    const scope = identifier(change.scope ?? 'global', 'profile scope');
    if (change.certainty !== 'explicit' && change.certainty !== 'inferred') throw new Error('Invalid profile certainty');
    if (change.expectedVersion !== undefined) timestamp(change.expectedVersion, 'expected version');
    return this.db.transaction((): ProfileEntry => {
      this.requireCompanion(cid);
      const source = this.eventRow(cid, evidenceEventId);
      if (source === undefined || source.forgotten === 1 || source.suppressed === 1 || source.superseded === 1 || source.role !== 'user' || source.visibility !== 'private') {
        throw new Error('Profile evidence requires an active private user source from this companion');
      }
      if (!source.content.includes(evidenceQuote)) throw new Error('Evidence quote does not match source');
      if (scope.startsWith('session:') && scope !== 'session:' + source.session_id) throw new Error('Profile scope does not match source session');
      const anchor = this.db.prepare("SELECT 1 AS present FROM profiles WHERE companion_id = ? AND domain = 'persona' AND key = ? AND certainty = 'anchor'").get(cid, key) as { present: number } | undefined;
      if (domain === 'persona' && anchor !== undefined) throw new Error('Persona anchor is immutable');
      const metadata = this.metadataRow(cid, evidenceEventId);
      if (metadata === undefined || this.profileSupportRejection(source, metadata) !== null) {
        throw new Error('Profile evidence is not a trusted owner statement');
      }
      const previousRow = this.activeFactRow(cid, domain, key, scope);
      const previousVersion = previousRow === undefined ? 0 : previousRow.revision;
      if (change.expectedVersion !== undefined && change.expectedVersion !== previousVersion) throw new Error('Profile version conflict');
      if (previousRow !== undefined && previousRow.certainty === 'explicit' && change.certainty === 'inferred') {
        throw new Error('Inference cannot replace an explicit profile value');
      }
      const intent: CommitInput['intent'] = previousRow !== undefined && previousRow.value !== value ? 'change-over-time' : 'add';
      const fact = this.commitLocked(cid, {
        domain,
        key,
        value,
        scope,
        certainty: change.certainty,
        intent,
        evidence: [{ kind: 'quote', eventId: evidenceEventId, sourceRevision: metadata.revision, quote: evidenceQuote }],
        validFrom: null,
        validTo: null,
        reason,
        forceNewVersion: true,
      });
      const primary = fact.evidence.find((item) => item.receiptId === undefined);
      return {
        domain: fact.domain,
        key: fact.key,
        value: fact.value,
        certainty: fact.certainty,
        scope: fact.scope,
        sourceEventId: primary === undefined ? null : primary.eventId,
        version: fact.revision,
        updatedAt: fact.recordedAt,
      };
    }).immediate();
  }

  listProfile(companionId: string, domain?: ProfileDomain): ProfileEntry[] {
    if (this.profileReadSource === 'facts') return this.listProfileFromFacts(companionId, domain);
    return this.listProfileMaterialized(companionId, domain);
  }

  listProfileMaterialized(companionId: string, domain?: ProfileDomain): ProfileEntry[] {
    if (domain !== undefined && !domains.has(domain)) throw new Error('Invalid profile domain');
    const cid = identifier(companionId, 'companion ID');
    const rows = (domain === undefined
      ? this.db.prepare('SELECT * FROM profiles WHERE companion_id = ? ORDER BY domain, key, scope').all(cid)
      : this.db.prepare('SELECT * FROM profiles WHERE companion_id = ? AND domain = ? ORDER BY key, scope').all(cid, domain)) as ProfileRow[];
    return rows.map(asProfile);
  }

  listProfileFromFacts(companionId: string, domain?: ProfileDomain): ProfileEntry[] {
    const cid = identifier(companionId, 'companion ID');
    if (domain !== undefined && !domains.has(domain)) throw new Error('Invalid profile domain');
    const rows = (domain === undefined
      ? this.db.prepare("SELECT * FROM profile_fact_versions WHERE companion_id = ? AND materialized = 1 AND status = 'active' ORDER BY domain, key, scope").all(cid)
      : this.db.prepare("SELECT * FROM profile_fact_versions WHERE companion_id = ? AND domain = ? AND materialized = 1 AND status = 'active' ORDER BY key, scope").all(cid, domain)) as FactRow[];
    return rows.map(asFactEntry);
  }

  compareProfileReads(companionId: string): ProfileReadComparison {
    const materialized = this.listProfileMaterialized(companionId);
    const facts = this.listProfileFromFacts(companionId);
    const differences: string[] = [];
    const keyOf = (entry: ProfileEntry): string => entry.domain + '|' + entry.key + '|' + entry.scope;
    const materializedMap = new Map(materialized.map((entry) => [keyOf(entry), JSON.stringify(entry)]));
    const factsMap = new Map(facts.map((entry) => [keyOf(entry), JSON.stringify(entry)]));
    for (const key of materializedMap.keys()) if (!factsMap.has(key)) differences.push('missing-in-facts:' + key);
    for (const key of factsMap.keys()) if (!materializedMap.has(key)) differences.push('missing-in-materialized:' + key);
    for (const [key, encoded] of materializedMap) {
      const other = factsMap.get(key);
      if (other !== undefined && other !== encoded) differences.push('value-mismatch:' + key);
    }
    return { consistent: differences.length === 0, materialized, facts, differences };
  }

  commitCandidate(companionId: string, input: ProfileCandidateInput): CandidateDecision {
    const cid = identifier(companionId, 'companion ID');
    const normalized = this.normalizeCandidate(input);
    return this.db.transaction((): CandidateDecision => {
      this.requireCompanion(cid);
      const current = this.activeFactRow(cid, normalized.domain, normalized.key, normalized.scope);
      const baseVersion = current === undefined ? 0 : current.revision;
      const reject = (reasonCode: string): CandidateDecision => {
        this.insertCandidateTx(cid, normalized, 'rejected', baseVersion);
        return { kind: 'reject', reasonCode };
      };
      if (normalized.expectedVersion !== undefined && normalized.expectedVersion !== baseVersion) {
        this.insertCandidateTx(cid, normalized, 'rejected', baseVersion);
        return { kind: 'conflict', currentVersion: baseVersion };
      }
      if (normalized.domain === 'persona') {
        const anchor = this.db.prepare("SELECT 1 AS present FROM profiles WHERE companion_id = ? AND domain = 'persona' AND key = ? AND certainty = 'anchor'").get(cid, normalized.key) as { present: number } | undefined;
        if (anchor !== undefined) return reject('persona-anchor-immutable');
      }
      const checked = this.validateEvidenceTx(cid, normalized.evidence, normalized.certainty);
      if (!checked.ok) return reject(checked.reasonCode);
      // An inference never outranks an explicit statement, whether it arrives as an
      // add, a move or a correction.
      if (current !== undefined && current.certainty === 'explicit' && normalized.certainty === 'inferred') {
        return reject('weaker-certainty');
      }
      if (normalized.intent === 'add' && current !== undefined && current.value !== normalized.value) {
        this.insertCandidateTx(cid, normalized, 'rejected', baseVersion);
        return { kind: 'conflict', currentVersion: baseVersion };
      }
      if (normalized.intent === 'retract' && current === undefined) return reject('no-current-fact');
      if (normalized.intent === 'add' && current !== undefined && current.value === normalized.value) {
        if (current.certainty === 'explicit' && normalized.certainty === 'inferred') return reject('weaker-certainty');
        const fact = this.addEvidenceToFactTx(cid, current, checked.evidence);
        this.insertCandidateTx(cid, normalized, 'committed', baseVersion);
        return { kind: 'commit', fact: this.asFact(fact), newEpoch: this.currentEpochTx(cid) };
      }
      if (normalized.intent === 'retract' && current !== undefined) {
        // 撤销不能只靠“引用有效”：必须能在引用里看到撤销表达与当前值/字段，
        // 否则任意逐字引用（例如“今天天气不错”）都能静默抑制已确认事实。
        const quotes = checked.evidence.filter((item) => item.kind === 'quote').map((item) => item.quote);
        if (!quotes.some((item) => retractionEvidenceSupports(item, current.value, current.key))) {
          return reject('retract-without-target');
        }
        const fact = this.retractFactTx(cid, current, checked.evidence);
        this.insertCandidateTx(cid, normalized, 'committed', baseVersion);
        return { kind: 'commit', fact: this.asFact(fact), newEpoch: this.currentEpochTx(cid) };
      }
      const committed = this.commitLocked(cid, {
        domain: normalized.domain,
        key: normalized.key,
        value: normalized.value,
        scope: normalized.scope,
        certainty: normalized.certainty,
        intent: normalized.intent,
        evidence: checked.evidence,
        validFrom: normalized.validFrom,
        validTo: normalized.validTo,
        reason: normalized.reason,
        forceNewVersion: false,
      });
      this.insertCandidateTx(cid, normalized, 'committed', baseVersion);
      return { kind: 'commit', fact: committed, newEpoch: this.currentEpochTx(cid) };
    }).immediate();
  }

  addEvidence(companionId: string, factId: string, evidence: EvidenceRef): ProfileFact {
    const cid = identifier(companionId, 'companion ID');
    const id = identifier(factId, 'fact ID');
    const certainty: 'explicit' | 'inferred' = evidence.kind === 'quote' ? 'explicit' : 'inferred';
    return this.db.transaction((): ProfileFact => {
      this.requireCompanion(cid);
      const row = this.db.prepare('SELECT * FROM profile_fact_versions WHERE id = ? AND companion_id = ?').get(id, cid) as FactRow | undefined;
      if (row === undefined) throw new Error('Unknown profile fact');
      const checked = this.validateEvidenceTx(cid, [evidence], certainty);
      if (!checked.ok) throw new Error('Evidence does not support a profile fact: ' + checked.reasonCode);
      const updated = this.insertEvidenceTx(cid, row, checked.evidence);
      return this.asFact(updated);
    }).immediate();
  }

  removeEvidence(companionId: string, factId: string, eventId: string, sourceRevision: number): ProfileFact | null {
    const cid = identifier(companionId, 'companion ID');
    const id = identifier(factId, 'fact ID');
    const eid = identifier(eventId, 'event ID');
    const revision = timestamp(sourceRevision, 'source revision');
    return this.db.transaction((): ProfileFact | null => {
      this.requireCompanion(cid);
      const row = this.db.prepare('SELECT * FROM profile_fact_versions WHERE id = ? AND companion_id = ?').get(id, cid) as FactRow | undefined;
      if (row === undefined) throw new Error('Unknown profile fact');
      this.db.prepare('DELETE FROM profile_evidence WHERE fact_version_id = ? AND event_id = ? AND source_revision = ?').run(id, eid, revision);
      this.db.prepare("DELETE FROM derived_dependencies WHERE derived_kind = 'profile_fact' AND derived_id = ? AND source_id = ? AND source_revision = ?").run(id, eid, revision);
      const remaining = this.evidenceRows(id);
      if (remaining.length === 0) {
        // Losing the last quote only revokes the current value. A historical or
        // corrected fact keeps its past value and validity window for the record;
        // only the materialized fact that backs the current profile is suppressed.
        if (row.materialized === 1) {
          const now = new Date().toISOString();
          this.db.prepare("UPDATE profile_fact_versions SET status = 'suppressed', materialized = 0, value = '', primary_source_id = NULL, valid_to = COALESCE(valid_to, ?) WHERE id = ?").run(now, id);
          this.bumpEpochTx(cid);
          // The current value may still be supported by an older, valid version of
          // the same key; losing today's quote must not delete a provable belief.
          this.restoreFallbackTx(cid, row.domain, row.key, row.scope);
        }
        return this.asFact(this.factRow(id) as FactRow);
      }
      const first = remaining[0];
      if (first !== undefined && row.primary_source_id === eid) {
        this.db.prepare('UPDATE profile_fact_versions SET primary_source_id = ? WHERE id = ?').run(first.event_id, id);
        this.db.prepare('UPDATE profiles SET source_event_id = ?, evidence_quote = ? WHERE companion_id = ? AND domain = ? AND key = ? AND scope = ?').run(first.event_id, first.quote, cid, row.domain, row.key, row.scope);
      }
      return this.asFact(this.factRow(id) as FactRow);
    }).immediate();
  }

  listFacts(companionId: string, domain?: ProfileDomain): ProfileFact[] {
    const cid = identifier(companionId, 'companion ID');
    if (domain !== undefined && !domains.has(domain)) throw new Error('Invalid profile domain');
    const rows = (domain === undefined
      ? this.db.prepare('SELECT * FROM profile_fact_versions WHERE companion_id = ? ORDER BY revision, recorded_at').all(cid)
      : this.db.prepare('SELECT * FROM profile_fact_versions WHERE companion_id = ? AND domain = ? ORDER BY revision, recorded_at').all(cid, domain)) as FactRow[];
    return rows.map((row) => this.asFact(row));
  }

  listCandidates(companionId: string): ProfileCandidate[] {
    const cid = identifier(companionId, 'companion ID');
    const rows = this.db.prepare('SELECT * FROM profile_candidates WHERE companion_id = ? ORDER BY created_at, rowid').all(cid) as CandidateRow[];
    return rows.map((row) => this.asCandidate(row));
  }

  /**
   * Persists a proposed candidate without touching profile facts. Proposals carry
   * an expiry so a later field-review task can expire or commit them.
   */
  proposeCandidate(companionId: string, input: ProfileCandidateInput): ProfileCandidate {
    const cid = identifier(companionId, 'companion ID');
    if (input.domain === 'persona') {
      const key = profileKey(input.key);
      const anchor = this.db.prepare("SELECT 1 AS present FROM profiles WHERE companion_id = ? AND domain = 'persona' AND key = ? AND certainty = 'anchor'").get(cid, key) as { present: number } | undefined;
      if (anchor !== undefined) throw new Error('Persona anchor is immutable');
    }
    const normalized = this.normalizeCandidate(input);
    return this.db.transaction((): ProfileCandidate => {
      this.requireCompanion(cid);
      const current = this.activeFactRow(cid, normalized.domain, normalized.key, normalized.scope);
      const checked = this.validateEvidenceTx(cid, normalized.evidence, normalized.certainty);
      if (!checked.ok) throw new Error('Evidence does not support a profile proposal: ' + checked.reasonCode);
      const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS).toISOString();
      const id = this.insertCandidateTx(cid, normalized, 'proposed', current === undefined ? 0 : current.revision, expiresAt);
      return this.asCandidate(this.db.prepare('SELECT * FROM profile_candidates WHERE id = ?').get(id) as CandidateRow);
    }).immediate();
  }

  /** Uncommitted, unexpired proposals for field review. */
  listProposals(companionId: string): ProfileCandidate[] {
    const cid = identifier(companionId, 'companion ID');
    const rows = this.db.prepare("SELECT * FROM profile_candidates WHERE companion_id = ? AND status = 'proposed' AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at, rowid").all(cid, new Date().toISOString()) as CandidateRow[];
    return rows.map((row) => this.asCandidate(row));
  }

  currentEpoch(companionId: string): number {
    const cid = identifier(companionId, 'companion ID');
    this.requireCompanion(cid);
    return this.currentEpochTx(cid);
  }

  bumpEpoch(companionId: string): number {
    const cid = identifier(companionId, 'companion ID');
    return this.db.transaction((): number => {
      this.requireCompanion(cid);
      return this.bumpEpochTx(cid);
    }).immediate();
  }

  forgetEvents(companionId: string, eventIds: string[], mode: ForgetMode): ForgetOutcome {
    const cid = identifier(companionId, 'companion ID');
    const forgetMode = choice(mode, FORGET_MODES, 'forget mode');
    if (!Array.isArray(eventIds) || eventIds.length < 1 || eventIds.length > 100) throw new Error('Forget requires 1 to 100 event IDs');
    const ids = eventIds.map((eventId) => identifier(eventId, 'event ID'));
    return this.db.transaction((): ForgetOutcome => {
      this.requireCompanion(cid);
      return this.eraseEventsTx(cid, ids, forgetMode, true);
    }).immediate();
  }

  forgetEvent(companionId: string, eventId: string): void {
    const cid = identifier(companionId, 'companion ID');
    const eid = identifier(eventId, 'event ID');
    this.db.transaction(() => {
      this.requireCompanion(cid);
      this.eraseEventsTx(cid, [eid], 'erase', false);
    }).immediate();
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  forgetRequest(requestId: string): ForgetRequest | null {
    return this.db.transaction(() => {
      const id=identifier(requestId,'forget request ID');
      let row=this.db.prepare('SELECT * FROM forget_requests WHERE id = ?').get(id) as ForgetRow | undefined;
      if(row===undefined)return null;
      if(row.mode==='erase') {
        const operations=this.operationsForForget(row.companion_id,JSON.parse(row.selector_json) as string[]);
        const unsafe=operations.some(operation=>operation.submissionProtocolVersion!==1);
        const missing=operations.some(operation=>operation.payloadErasureVersion!==1);
        if(unsafe || missing && (row.backend_status==='done' || row.operation_payload_status==='done')) {
          const state=unsafe?'blocked':'unknown';
          this.db.prepare('UPDATE forget_requests SET backend_status = ?,operation_payload_status = ? WHERE id = ?').run(state,state,id);
          row=this.db.prepare('SELECT * FROM forget_requests WHERE id = ?').get(id) as ForgetRow;
        }
      }
      return asForgetRequest(row);
    }).immediate();
  }

  updateForgetRequest(requestId: string, patch: ForgetPatch): ForgetRequest {
    return this.db.transaction(() => {
      const id = identifier(requestId, 'forget request ID');
      const current = this.db.prepare('SELECT * FROM forget_requests WHERE id = ?').get(id) as ForgetRow | undefined;
      if (current === undefined) throw new Error('Unknown forget request');
      const local = patch.local === undefined ? current.local_status : choice(patch.local, CLEANUP_STATES, 'local cleanup state');
      let backend = patch.backend === undefined ? current.backend_status : choice(patch.backend, CLEANUP_STATES, 'backend cleanup state');
      let operationPayloads = patch.operationPayloads === undefined ? current.operation_payload_status : choice(patch.operationPayloads, CLEANUP_STATES, 'operation payload cleanup state');
      if (current.mode === 'erase') {
        const ids = JSON.parse(current.selector_json) as string[];
        const locations = this.companionMemory.indexLocationsForEvents(current.companion_id, ids);
        const operations = this.operationsForForget(current.companion_id, ids);
        const pendingLocation = locations.some(location => location.cleanupState !== 'done'
          || operations.some(operation => operation.operationId === location.operationId && (operation.state !== 'erased' || operation.payloadErasureVersion!==1 || operation.submissionProtocolVersion!==1)));
        if (backend === 'done' && pendingLocation) backend = 'pending';
        if (operationPayloads === 'done' && operations.some(operation => operation.state !== 'erased' || operation.payloadErasureVersion!==1 || operation.submissionProtocolVersion!==1)) operationPayloads = 'pending';
      }
      const hostHistory = patch.hostHistory === undefined ? current.history_status : choice(patch.hostHistory, CLEANUP_STATES, 'history cleanup state');
      let backups: 'not-included' | CleanupState = current.backup_status;
      if (patch.backups !== undefined) {
        backups = patch.backups === 'not-included' ? 'not-included' : choice(patch.backups, CLEANUP_STATES, 'backup cleanup state');
      }
      this.db.prepare('UPDATE forget_requests SET local_status = ?, backend_status = ?, operation_payload_status = ?, history_status = ?, backup_status = ?, updated_at = ? WHERE id = ?').run(local, backend, operationPayloads, hostHistory, backups, new Date().toISOString(), id);
      return asForgetRequest(this.db.prepare('SELECT * FROM forget_requests WHERE id = ?').get(id) as ForgetRow);
    }).immediate();
  }

  /** Forget requests whose backend or operation-payload cleanup still has unreported work. */
  forgetRequestsToAdvance(limit = 100): ForgetRequest[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid forget batch size');
    const rows = this.db.prepare("SELECT * FROM forget_requests WHERE backend_status IN ('pending', 'unknown') OR operation_payload_status IN ('pending', 'unknown') ORDER BY created_at, rowid LIMIT ?").all(limit) as ForgetRow[];
    return rows.map(asForgetRequest);
  }

  forgetReceipt(requestId: string): ForgetReceipt {
    const request = this.forgetRequest(requestId);
    if (request === null) throw new Error('Unknown forget request');
    return {
      requestId: request.id,
      stateEpoch: request.stateEpoch,
      local: request.local,
      backend: request.backend,
      operationPayloads: request.operationPayloads,
      hostHistory: request.hostHistory,
      backups: request.backups,
      unresolved: request.unresolved,
    };
  }

  /** Cancels a queued legacy retain job, e.g. when the async operation path owns the write. */
  cancelPendingRetain(companionId: string, documentId: string): void {
    this.cancelRetain(identifier(companionId, 'companion ID'), identifier(documentId, 'document ID'));
  }

  /** Every companion with durable state, for batch maintenance. */
  listCompanions(): string[] {
    const rows = this.db.prepare('SELECT id FROM companions ORDER BY id').all() as { id: string }[];
    return rows.map((row) => row.id);
  }

  prepareOperation(companionId: string, input: PrepareOperationInput): BackendOperation {
    const cid = identifier(companionId, 'companion ID');
    const documentId = identifier(input.documentId, 'document ID');
    const sourceRevision = timestamp(input.sourceRevision, 'source revision');
    const payloadHash = bounded(input.payloadHash, 'payload hash', 128);
    const requestedId = input.operationId === undefined ? undefined : identifier(input.operationId, 'operation ID');
    return this.db.transaction((): BackendOperation => {
      this.requireCompanion(cid);
      const existing = this.db.prepare('SELECT * FROM backend_operations WHERE companion_id = ? AND document_id = ? AND source_revision = ?').get(cid, documentId, sourceRevision) as OperationRow | undefined;
      if (existing !== undefined) {
        if (existing.payload_hash !== payloadHash) throw new Error('Operation payload conflict');
        return asOperation(existing);
      }
      const operationId = requestedId ?? randomUUID();
      if (requestedId !== undefined) {
        const collision = this.db.prepare('SELECT * FROM backend_operations WHERE companion_id = ? AND operation_id = ?').get(cid, requestedId) as OperationRow | undefined;
        if (collision !== undefined) throw new Error('Operation ID conflict');
      }
      this.db.prepare("INSERT INTO backend_operations(companion_id, operation_id, document_id, source_revision, payload_hash, state,submission_protocol_version) VALUES (?, ?, ?, ?, ?, 'pending',?)").run(cid, operationId, documentId, sourceRevision, payloadHash,input.provenance==='external-unknown'?0:1);
      if(input.provenance==='external-unknown')this.db.prepare("UPDATE backend_operations SET state = 'cleanup_pending',attempts = 1,cleanup_state = 'blocked',next_check_at = ?,error_code = 'external-attempt-unknown' WHERE companion_id = ? AND operation_id = ?").run(Number.MAX_SAFE_INTEGER,cid,operationId);
      return asOperation(this.db.prepare('SELECT * FROM backend_operations WHERE companion_id = ? AND operation_id = ?').get(cid, operationId) as OperationRow);
    }).immediate();
  }

  /** Location registration, eligibility/hash read, operation creation and binding share one write lock. */
  prepareMaterialOperation(companionId: string, ref: {memoryId:string;revision:number}, bank: string, documentId: string,
    identity: (companionId:string, handle:string, revision:number, hash:string) => string): BackendOperation | null {
    return this.db.transaction(() => {
      const snapshot = this.companionMemory.materialSnapshot(companionId,ref); if (snapshot === null || !snapshot.memory.summary?.trim()) return null;
      const location = this.companionMemory.ensureIndexLocation(companionId,{bank,bankKind:'companion',documentId,memory:ref});
      if (location.cleanupState !== 'not-requested' || location.indexState === 'erased') return null;
      if(location.operationId!==null && this.getOperation(companionId,location.operationId)?.state==='erased')return null;
      const operation = this.prepareOperation(companionId,{documentId:location.id,sourceRevision:ref.revision,payloadHash:snapshot.payloadHash,
        operationId:identity(companionId,location.id,ref.revision,snapshot.payloadHash)});
      this.companionMemory.updateIndexLocation(companionId,location.id,{operationId:operation.operationId});
      return operation;
    }).immediate();
  }

  memoryFence(companionId: string): {stateEpoch:number;deletionWatermark:number} {
    const cid=identifier(companionId,'companion ID'); this.requireCompanion(cid);
    const row=this.db.prepare('SELECT state_epoch, deletion_watermark FROM companion_epochs WHERE companion_id = ?').get(cid) as {state_epoch:number;deletion_watermark:number};
    return {stateEpoch:row.state_epoch,deletionWatermark:row.deletion_watermark};
  }

  materialOperationSnapshot(companionId: string, operationId: string) {
    return this.db.transaction(()=>{
      const operation=this.getOperation(companionId,operationId);if(operation===null || ['cleanup_pending','cancel_requested','erased'].includes(operation.state))return null;
      const location=this.companionMemory.getIndexLocation(companionId,operation.documentId);
      if(location===null || location.operationId!==operationId || location.bankKind!=='companion' || location.memory===null || location.cleanupState!=='not-requested' || location.indexState==='erased')return null;
      const snapshot=this.companionMemory.materialSnapshot(companionId,location.memory);
      if(snapshot===null || !snapshot.memory.summary?.trim() || snapshot.payloadHash!==operation.payloadHash || operation.sourceRevision!==location.memory.revision)return null;
      return {...snapshot,location,operation};
    }).immediate();
  }

  verifyLegacyRollback(companionId: string): {stateEpoch:number;deletionWatermark:number} {
    return this.db.transaction(()=>{
      const pending=this.db.prepare("SELECT 1 FROM forget_requests WHERE companion_id = ? AND mode = 'erase' AND (backend_status != 'done' OR operation_payload_status != 'done') LIMIT 1").get(companionId);
      const location=this.db.prepare("SELECT 1 FROM memory_index_locations WHERE companion_id = ? AND cleanup_state IN ('pending','unknown','blocked') LIMIT 1").get(companionId);
      const operations=this.db.prepare("SELECT 1 FROM backend_operations WHERE companion_id = ? AND state IN ('cleanup_pending','cancel_requested') LIMIT 1").get(companionId);
      const legacy=this.db.prepare("SELECT 1 FROM events e WHERE e.companion_id = ? AND e.forgotten = 1 AND EXISTS (SELECT 1 FROM memory_jobs j WHERE j.companion_id=e.companion_id AND j.document_id=e.id AND j.operation='delete' AND j.status!='done') LIMIT 1").get(companionId);
      const forgotten=(this.db.prepare('SELECT id FROM events WHERE companion_id = ? AND forgotten = 1').all(companionId) as {id:string}[]).map(r=>r.id);
      const payloads=this.operationsForForget(companionId,forgotten).some(o=>o.state!=='erased' || o.submissionProtocolVersion!==1 || o.payloadErasureVersion!==1);
      if(pending!==undefined || location!==undefined || operations!==undefined || legacy!==undefined || payloads || this.legacyWritesUnsettled(companionId,forgotten)) throw new Error('Legacy rollback requires current tombstone cleanup');
      return this.memoryFence(companionId);
    }).immediate();
  }

  getOperation(companionId: string, operationId: string): BackendOperation | null {
    const row = this.db.prepare('SELECT * FROM backend_operations WHERE companion_id = ? AND operation_id = ?').get(identifier(companionId, 'companion ID'), identifier(operationId, 'operation ID')) as OperationRow | undefined;
    return row === undefined ? null : asOperation(row);
  }

  pendingOperations(companionId: string, limit = 100): BackendOperation[] {
    const cid = identifier(companionId, 'companion ID');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid operation batch size');
    const rows = this.db.prepare("SELECT * FROM backend_operations WHERE companion_id = ? AND state = 'pending' ORDER BY rowid LIMIT ?").all(cid, limit) as OperationRow[];
    return rows.map(asOperation);
  }

  /** Only locally proven never-sent work. Operation IDs are not permanent remote replay tombstones. */
  operationsAwaitingSubmit(companionId: string, limit = 100, materialsOnly = false): BackendOperation[] {
    const cid = identifier(companionId, 'companion ID');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid operation batch size');
    const rows = this.db.prepare(`SELECT * FROM backend_operations o WHERE companion_id = ? AND state IN ('pending','unknown')
      AND submitted_at IS NULL AND attempts = 0 AND (error_code IS NULL OR error_code NOT GLOB 'submit-claim:*')
      ${materialsOnly ? "AND EXISTS (SELECT 1 FROM memory_index_locations l WHERE l.companion_id = o.companion_id AND l.id = o.document_id AND l.operation_id = o.operation_id AND l.bank_kind = 'companion' AND l.memory_id IS NOT NULL)" : ''} ORDER BY rowid LIMIT ?`).all(cid, limit) as OperationRow[];
    return rows.map(asOperation);
  }

  /** A claim is never replaced merely because its scheduler deadline expired. */
  claimOperationSubmission(companionId: string, operationId: string, now: number, materialAllowed?: (operation: BackendOperation) => boolean): {operation: BackendOperation; token: string; previousAttempts: number} | null {
    const at = timestamp(now, 'submission time');
    return this.db.transaction(() => {
      const current = this.operationProofsForCleanup(companionId, operationId);
      if (current === null) return null;
      if(current.submissionProtocolVersion!==1)return null;
      if(current.submittedAt!==null || current.attempts!==0 || current.errorCode?.startsWith(SUBMIT_CLAIM_PREFIX)===true)return null;
      const location = this.companionMemory.indexLocationForOperation(companionId,current.operationId);
      const material = location !== null && location.id === current.documentId && location.memory !== null;
      if (material ? materialAllowed === undefined || !materialAllowed(current) : materialAllowed !== undefined || !this.isDocumentAllowed(companionId,current.documentId)) return null;
      if (current.state !== 'pending' && !(current.state === 'unknown' && current.submittedAt === null && current.nextCheckAt <= at)) return null;
      const token = SUBMIT_CLAIM_PREFIX + randomUUID();
      const operation = this.updateOperation(companionId, operationId, {
        state:'unknown', attempts:current.attempts + 1, lastCheckedAt:at,
        nextCheckAt:at + SUBMIT_CLAIM_MS, errorCode:token,
      });
      return {operation, token, previousAttempts:current.attempts};
    }).immediate();
  }

  /** A stale worker cannot replace a newer lease or undo cancellation/forget. */
  settleOperationSubmission(companionId: string, operationId: string, token: string, patch: OperationPatch, writeNotAttempted = false): BackendOperation | null {
    return this.db.transaction(() => {
      const current = this.getOperation(companionId, operationId);
      if (current === null || current.state === 'erased' || current.errorCode !== token) return null;
      const cleanup = current.state === 'cleanup_pending' || current.state === 'cancel_requested';
      return this.updateOperation(companionId, operationId, cleanup ? {
        ...patch, state:'cleanup_pending', cleanupState:'pending',
        attempts:Math.max(current.attempts - (writeNotAttempted ? 1 : 0), patch.attempts ?? current.attempts), nextCheckAt:0,
      } : patch);
    }).immediate();
  }

  /** A remote completion cannot settle or release a still-live local POST claim. */
  recordOperationCompletion(companionId: string, operationId: string, now: number, patch: OperationPatch = {}): BackendOperation {
    return this.db.transaction(() => {
      const current=this.getOperation(companionId,operationId);
      if(current===null)throw new Error('Unknown operation');
      if(current.submissionProtocolVersion!==1 || current.state==='erased' || current.errorCode?.startsWith(SUBMIT_CLAIM_PREFIX)===true)return current;
      return this.updateOperation(companionId,operationId,{...patch,completedAt:now,errorCode:null});
    }).immediate();
  }

  /** Persist payload acknowledgement before final document I/O, without claiming it was deleted. */
  confirmOperationPayloadErased(companionId: string, operationId: string, now: number): BackendOperation | null {
    return this.db.transaction(() => {
      const current=this.operationProofsForCleanup(companionId,operationId);
      if(current===null || current.submissionProtocolVersion!==1 || current.errorCode?.startsWith(SUBMIT_CLAIM_PREFIX)===true)return null;
      if(current.state==='erased')return current;
      this.db.prepare('UPDATE backend_operations SET payload_erasure_version = 1 WHERE companion_id = ? AND operation_id = ?').run(companionId,operationId);
      return this.updateOperation(companionId,operationId,{state:'cleanup_pending',cleanupState:'done',lastCheckedAt:now,nextCheckAt:now,errorCode:null});
    }).immediate();
  }

  /** Quarantine old evidence even when a restored snapshot claims it was already erased. */
  operationProofsForCleanup(companionId: string, operationId: string): BackendOperation | null {
    return this.db.transaction(() => {
      let current=this.getOperation(companionId,operationId);if(current===null)return null;
      if(current.submissionProtocolVersion===0 && current.submittedAt===null && current.attempts===0 && current.errorCode?.startsWith(SUBMIT_CLAIM_PREFIX)!==true) {
        this.db.prepare('UPDATE backend_operations SET submission_protocol_version = 1 WHERE companion_id = ? AND operation_id = ?').run(companionId,operationId);
        current=this.getOperation(companionId,operationId)!;
      }
      const unsafe=current.submissionProtocolVersion!==1;
      if(unsafe || current.payloadErasureVersion!==1 && (current.state==='erased' || current.cleanupState==='done')) {
        const state=unsafe?'blocked':'unknown';
        this.db.prepare("UPDATE backend_operations SET state = 'cleanup_pending',cleanup_state = ?,next_check_at = ?,error_code = ? WHERE companion_id = ? AND operation_id = ?")
          .run(state,unsafe?Number.MAX_SAFE_INTEGER:0,current.errorCode?.startsWith(SUBMIT_CLAIM_PREFIX)===true?current.errorCode:unsafe?'legacy-submit-proof-required':'legacy-family-proof-required',companionId,operationId);
        this.db.prepare('UPDATE memory_index_locations SET cleanup_state = ? WHERE companion_id = ? AND operation_id = ?').run(state,companionId,operationId);
      }
      return this.getOperation(companionId,operationId);
    }).immediate();
  }

  /** Choose token preservation and attempts from the same locked row that is updated. */
  markOperationCleanup(companionId: string, operationId: string, now: number, requestedState: 'unknown' | 'blocked',
    errorCode: string, backoffMs: (attempts: number) => number): BackendOperation | null {
    const at=timestamp(now,'cleanup time');
    return this.db.transaction(() => {
      const current=this.operationProofsForCleanup(companionId,operationId);
      if(current===null || current.state==='erased')return current;
      if(current.submissionProtocolVersion!==1)return current;
      const inFlight=current.errorCode?.startsWith(SUBMIT_CLAIM_PREFIX)===true;
      const cleanupState=current.cleanupState==='done' ? 'done' : inFlight ? 'unknown' : requestedState;
      const delay=timestamp(backoffMs(current.attempts),'cleanup backoff');
      // A failed cleanup cannot create an attempted write, or restore a token
      // that a concurrent owner already released before this transaction began.
      const attempts=inFlight || current.submittedAt===null && current.attempts===0 ? current.attempts : current.attempts+1;
      return this.updateOperation(companionId,operationId,{state:'cleanup_pending',cleanupState,attempts,lastCheckedAt:at,
        nextCheckAt:requestedState==='blocked' && !inFlight ? Number.MAX_SAFE_INTEGER : at+delay,errorCode:inFlight ? current.errorCode : errorCode});
    }).immediate();
  }

  /** Operations that asked for cancellation or whose payload must be erased after a late/ambiguous outcome. */
  operationsToCleanup(now: number, limit = 100): BackendOperation[] {
    const at = timestamp(now, 'cleanup time');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid cleanup batch size');
    const rows = this.db.prepare("SELECT * FROM backend_operations WHERE state IN ('cancel_requested', 'cleanup_pending') AND next_check_at <= ? ORDER BY next_check_at, rowid LIMIT ?").all(at, limit) as OperationRow[];
    return rows.map(asOperation);
  }

  operationsToPoll(now: number, limit = 100): BackendOperation[] {
    const at = timestamp(now, 'poll time');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid poll batch size');
    const rows = this.db.prepare(`SELECT * FROM backend_operations WHERE submission_protocol_version = 1 AND state IN ('submitted','processing','unknown') AND next_check_at <= ?
      AND (error_code IS NULL OR error_code NOT GLOB 'submit-claim:*')
      AND NOT (state = 'unknown' AND submitted_at IS NULL AND attempts = 0)
      ORDER BY next_check_at, rowid LIMIT ?`).all(at, limit) as OperationRow[];
    return rows.map(asOperation);
  }

  operationsForDocument(companionId: string, documentId: string): BackendOperation[] {
    const rows = this.db.prepare('SELECT * FROM backend_operations WHERE companion_id = ? AND document_id = ? ORDER BY rowid').all(identifier(companionId, 'companion ID'), identifier(documentId, 'document ID')) as OperationRow[];
    return rows.map(asOperation);
  }

  /** Re-enumerate history every pass. An externally known operation has no local never-attempted proof. */
  operationsForForget(companionId: string, eventIds: readonly string[]): BackendOperation[] {
    return this.db.transaction(()=>{
      const operations=new Map<string,BackendOperation>();
      const locations=this.companionMemory.indexLocationsForEvents(companionId,eventIds);
      const handles=new Set(locations.map(l=>l.id));
      for(const id of eventIds)for(const op of this.operationsForDocument(companionId,id)) {
        const bound=this.companionMemory.indexLocationForOperation(companionId,op.operationId);
        if(bound===null || bound.id!==op.documentId || handles.has(bound.id))operations.set(op.operationId,op);
      }
      for(const location of locations) {
        if(location.operationId===null)continue;
        let op=this.getOperation(companionId,location.operationId);
        if(op===null) {
          op=this.prepareOperation(companionId,{documentId:location.id,sourceRevision:location.memory?.revision ?? location.source!.sourceRevision,payloadHash:'unknown-external-operation',operationId:location.operationId,provenance:'external-unknown'});
        }
        operations.set(op.operationId,op);
      }
      return [...operations.values()].map(operation=>this.operationProofsForCleanup(companionId,operation.operationId)!).filter(operation=>operation!==null);
    }).immediate();
  }

  acknowledgeForgetDocumentDeletion(companionId: string, eventId: string): void {
    this.db.prepare("UPDATE memory_jobs SET status = 'done', lease_token = NULL, lease_until = NULL WHERE companion_id = ? AND document_id = ? AND operation = 'delete' AND status IN ('pending','failed')").run(companionId,eventId);
  }

  legacyWritesUnsettled(companionId: string, eventIds: readonly string[]): boolean {
    const ids=JSON.stringify(eventIds);
    return this.db.prepare(`SELECT 1 FROM uncertain_writes WHERE companion_id = ? AND document_id IN (SELECT value FROM json_each(?))
      UNION SELECT 1 FROM memory_jobs WHERE companion_id = ? AND document_id IN (SELECT value FROM json_each(?)) AND operation = 'retain' AND status = 'running' LIMIT 1`)
      .get(companionId,ids,companionId,ids)!==undefined;
  }
  /** Documents whose queued retain job has not been converted into a durable async operation yet. */
  pendingRetainDocuments(companionId: string, limit = 100): string[] {
    const cid = identifier(companionId, 'companion ID');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid operation batch size');
    const rows = this.db.prepare("SELECT DISTINCT j.document_id FROM memory_jobs j WHERE j.companion_id = ? AND j.operation = 'retain' AND j.status = 'pending' AND NOT EXISTS (SELECT 1 FROM event_metadata m WHERE m.companion_id = j.companion_id AND m.event_id = j.document_id AND m.memory_route = 'staged') AND NOT EXISTS (SELECT 1 FROM companion_staged_sources s WHERE s.companion_id = j.companion_id AND s.event_id = j.document_id) ORDER BY j.document_id LIMIT ?").all(cid, limit) as { document_id: string }[];
    return rows.map((row) => row.document_id);
  }

  updateOperation(companionId: string, operationId: string, patch: OperationPatch): BackendOperation {
    const cid = identifier(companionId, 'companion ID');
    const id = identifier(operationId, 'operation ID');
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT * FROM backend_operations WHERE companion_id = ? AND operation_id = ?').get(cid, id) as OperationRow | undefined;
      if (current === undefined) throw new Error('Unknown operation');
      // Both guards share the write transaction: another process cannot revoke a
      // source between this read and the UPDATE, then have its intent overwritten.
      if (current.state === 'erased') return asOperation(current);
      const state = patch.state === undefined ? current.state : choice(patch.state, OPERATION_STATES, 'operation state');
      if ((current.state === 'cleanup_pending' || current.state === 'cancel_requested')
        && state !== 'cleanup_pending' && state !== 'cancel_requested' && state !== 'erased') return asOperation(current);
      const attempts = patch.attempts === undefined ? current.attempts : timestamp(patch.attempts, 'operation attempts');
      const nextCheckAt = patch.nextCheckAt === undefined ? current.next_check_at : timestamp(patch.nextCheckAt, 'next check time');
      const lastCheckedAt = patch.lastCheckedAt === undefined ? current.last_checked_at : (patch.lastCheckedAt === null ? null : timestamp(patch.lastCheckedAt, 'last checked time'));
      const submittedAt = patch.submittedAt === undefined ? current.submitted_at : (patch.submittedAt === null ? null : timestamp(patch.submittedAt, 'submitted time'));
      const completedAt = patch.completedAt === undefined ? current.completed_at : (patch.completedAt === null ? null : timestamp(patch.completedAt, 'completed time'));
      const errorCode = patch.errorCode === undefined ? current.error_code : (patch.errorCode === null ? null : bounded(patch.errorCode, 'operation error code', 128));
      const cleanupState = current.cleanup_state === 'done' ? 'done' : patch.cleanupState === undefined ? current.cleanup_state : choice(patch.cleanupState, CLEANUP_STATES, 'cleanup state');
      let payloadHash = patch.payloadHash === undefined ? current.payload_hash : (patch.payloadHash === null ? null : bounded(patch.payloadHash, 'payload hash', 128));
      // An erased operation keeps no fingerprint of the payload it used to hold.
      if (state === 'erased') payloadHash = null;
      this.db.prepare('UPDATE backend_operations SET state = ?, attempts = ?, next_check_at = ?, last_checked_at = ?, submitted_at = ?, completed_at = ?, error_code = ?, cleanup_state = ?, payload_hash = ? WHERE companion_id = ? AND operation_id = ?').run(state, attempts, nextCheckAt, lastCheckedAt, submittedAt, completedAt, errorCode, cleanupState, payloadHash, cid, id);
      return asOperation(this.db.prepare('SELECT * FROM backend_operations WHERE companion_id = ? AND operation_id = ?').get(cid, id) as OperationRow);
    }).immediate();
  }

  listDerivedDependencies(derivedId: string): { sourceId: string; sourceRevision: number }[] {
    const rows = this.db.prepare('SELECT source_id, source_revision FROM derived_dependencies WHERE derived_id = ? ORDER BY source_id').all(identifier(derivedId, 'derived object ID')) as { source_id: string; source_revision: number }[];
    return rows.map((row) => ({ sourceId: row.source_id, sourceRevision: row.source_revision }));
  }

  isDocumentAllowed(companionId: string, documentId: string): boolean {
    const row = this.db.prepare("SELECT e.role, e.visibility, e.tool_verified, m.mode, m.learning FROM events e LEFT JOIN event_metadata m ON m.companion_id = e.companion_id AND m.event_id = e.id WHERE e.companion_id = ? AND e.id = ? AND e.forgotten = 0 AND e.suppressed = 0 AND e.superseded = 0 AND COALESCE(m.memory_route, 'legacy') != 'staged' AND NOT EXISTS (SELECT 1 FROM companion_staged_sources s WHERE s.companion_id = e.companion_id AND s.event_id = e.id)").get(companionId, documentId) as {
      role: SourceEvent['role']; visibility: SourceEvent['visibility']; tool_verified: number | null;
      mode: ContentMode | null; learning: LearningMode | null;
    } | undefined;
    return row !== undefined && isLongTermSourceAllowed({
      role: row.role, visibility: row.visibility, toolVerified: row.tool_verified === 1,
      contentMode: row.mode ?? 'real', learning: row.learning ?? 'enabled',
    });
  }

  documentStatus(companionId: string, documentId: string): DocumentStatus {
    const row = this.eventRow(companionId, documentId);
    if (row === undefined) return { source: 'missing', remote: 'not_applicable' };
    const source: DocumentStatus['source'] = row.forgotten === 1
      ? 'forgotten'
      : row.suppressed === 1
        ? 'suppressed'
        : row.superseded === 1
          ? 'superseded'
          : 'active';
    if (this.hasUncertainWrite(companionId, documentId)) return { source, remote: 'uncertain' };
    const outstanding = this.db.prepare("SELECT status FROM memory_jobs WHERE companion_id = ? AND document_id = ? AND status IN ('running', 'pending', 'failed') ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END LIMIT 1").get(companionId, documentId) as { status: 'pending' | 'running' | 'failed' } | undefined;
    if (outstanding !== undefined) return { source, remote: outstanding.status };
    // The durable operation owns the remote write on an async backend; the legacy
    // lease row is cancelled as soon as the operation exists, so read the operation.
    const operation = this.db.prepare('SELECT state FROM backend_operations WHERE companion_id = ? AND document_id = ? ORDER BY rowid DESC LIMIT 1').get(companionId, documentId) as { state: OperationState } | undefined;
    if (operation !== undefined) {
      if (operation.state === 'completed') return { source, remote: 'retained' };
      if (operation.state === 'erased') return { source, remote: 'deleted' };
      if (operation.state === 'failed') return { source, remote: 'failed' };
      if (operation.state === 'unknown') return { source, remote: 'uncertain' };
      return { source, remote: 'pending' };
    }
    const done = this.db.prepare("SELECT operation FROM memory_jobs WHERE companion_id = ? AND document_id = ? AND status = 'done' ORDER BY id DESC LIMIT 1").get(companionId, documentId) as { operation: 'retain' | 'delete' } | undefined;
    if (done === undefined) return { source, remote: 'not_applicable' };
    return { source, remote: done.operation === 'retain' ? 'retained' : 'deleted' };
  }

  claimJob(now: number, leaseMs: number, companionId?: string): MemoryJob | null {
    const at = timestamp(now, 'claim time');
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isSafeInteger(at + leaseMs)) throw new Error('Invalid lease duration');
    const cid = companionId === undefined ? undefined : identifier(companionId, 'companion ID');
    return this.db.transaction((): MemoryJob | null => {
      const scope = cid === undefined ? '' : ' AND companion_id = ?';
      const scopeArgs: string[] = cid === undefined ? [] : [cid];
      // Rejected/staged raw sources cannot consume the bounded legacy drain, even
      // when a stale writer left a queued retain behind. Existing running writes
      // keep their uncertainty/cleanup accounting and are checked by the guard.
      this.db.prepare("UPDATE memory_jobs SET status = 'cancelled' WHERE operation = 'retain' AND status = 'pending' AND (EXISTS (SELECT 1 FROM event_metadata m WHERE m.companion_id = memory_jobs.companion_id AND m.event_id = memory_jobs.document_id AND m.memory_route = 'staged') OR EXISTS (SELECT 1 FROM companion_staged_sources s WHERE s.companion_id = memory_jobs.companion_id AND s.event_id = memory_jobs.document_id))" + scope).run(...scopeArgs);
      this.db.prepare("INSERT OR IGNORE INTO uncertain_writes(companion_id, document_id) SELECT companion_id, document_id FROM memory_jobs WHERE status = 'running' AND operation = 'retain' AND lease_until IS NOT NULL AND lease_until <= ?" + scope).run(at, ...scopeArgs);
      this.db.prepare("UPDATE memory_jobs SET status = 'failed', lease_token = NULL, lease_until = NULL WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= ? AND attempts >= ?" + scope).run(at, MAX_ATTEMPTS, ...scopeArgs);
      const job = this.db.prepare("SELECT j.id, j.companion_id, j.document_id, j.operation, j.attempts FROM memory_jobs j WHERE j.attempts < ? AND ((j.status = 'pending' AND j.next_attempt_at <= ?) OR (j.status = 'running' AND j.lease_until IS NOT NULL AND j.lease_until <= ?)) AND NOT EXISTS (SELECT 1 FROM memory_jobs active WHERE active.companion_id = j.companion_id AND active.document_id = j.document_id AND active.status = 'running' AND active.lease_until IS NOT NULL AND active.lease_until > ?)" + (cid === undefined ? '' : ' AND j.companion_id = ?') + " ORDER BY j.id LIMIT 1").get(MAX_ATTEMPTS, at, at, at, ...scopeArgs) as { id: number; companion_id: string; document_id: string; operation: 'retain' | 'delete'; attempts: number } | undefined;
      if (job === undefined) return null;
      const leaseToken = randomUUID();
      this.db.prepare("UPDATE memory_jobs SET status = 'running', attempts = attempts + 1, lease_token = ?, lease_until = ? WHERE id = ?").run(leaseToken, at + leaseMs, job.id);
      this.db.prepare('INSERT INTO job_leases(token, job_id, settled) VALUES (?, ?, 0)').run(leaseToken, job.id);
      return {
        id: job.id,
        companionId: job.companion_id,
        documentId: job.document_id,
        operation: job.operation,
        attempts: job.attempts + 1,
        leaseToken,
      };
    }).immediate();
  }

  completeJob(jobId: number, leaseToken: string): boolean {
    return this.settleJob(jobId, leaseToken);
  }

  failJob(jobId: number, leaseToken: string, now: number, uncertainWrite = false): boolean {
    const at = timestamp(now, 'retry time');
    return this.settleJob(jobId, leaseToken, at, uncertainWrite);
  }

  /** Non-fatal warnings produced while opening/migrating this database (e.g. a leftover snapshot). */
  schemaWarnings(): MigrationWarning[] {
    return this.migrationWarnings.map((warning) => ({ ...warning }));
  }

  stats(): { pending: number; running: number; failed: number; uncertainWrites: number } {
    const count = (status: string): number => {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM memory_jobs WHERE status = ?').get(status) as { n: number };
      return row.n;
    };
    const uncertain = this.db.prepare('SELECT COUNT(*) AS n FROM uncertain_writes').get() as { n: number };
    return { pending: count('pending'), running: count('running'), failed: count('failed'), uncertainWrites: uncertain.n };
  }

  retryFailed(): number {
    return this.db.transaction((): number => {
      const failed = this.db.prepare("SELECT id, companion_id, document_id, operation FROM memory_jobs WHERE status = 'failed'").all() as { id: number; companion_id: string; document_id: string; operation: 'retain' | 'delete' }[];
      let retried = 0;
      for (const job of failed) {
        if (job.operation === 'retain' && !this.isDocumentAllowed(job.companion_id, job.document_id)) {
          this.db.prepare("UPDATE memory_jobs SET status = 'cancelled' WHERE id = ?").run(job.id);
          continue;
        }
        this.db.prepare("UPDATE memory_jobs SET status = 'pending', attempts = 0, next_attempt_at = 0 WHERE id = ?").run(job.id);
        retried += 1;
      }
      return retried;
    }).immediate();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  private requireSupportedSchema(): number {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (!isSupportedVersion(version)) throw new Error('Unsupported state schema version');
    return version;
  }

  private requireCompanion(companionId: string): void {
    const row = this.db.prepare('SELECT 1 AS present FROM companions WHERE id = ?').get(companionId) as { present: number } | undefined;
    if (row === undefined) throw new Error('Unknown companion');
  }

  private eventRow(companionId: string, eventId: string): EventRow | undefined {
    return this.db.prepare('SELECT * FROM events WHERE companion_id = ? AND id = ?').get(companionId, eventId) as EventRow | undefined;
  }

  private metadataRow(companionId: string, eventId: string): MetadataRow | undefined {
    return this.db.prepare('SELECT * FROM event_metadata WHERE companion_id = ? AND event_id = ?').get(companionId, eventId) as MetadataRow | undefined;
  }

  private factRow(factId: string): FactRow | undefined {
    return this.db.prepare('SELECT * FROM profile_fact_versions WHERE id = ?').get(factId) as FactRow | undefined;
  }

  private activeFactRow(companionId: string, domain: ProfileDomain, key: string, scope: string): FactRow | undefined {
    return this.db.prepare("SELECT * FROM profile_fact_versions WHERE companion_id = ? AND domain = ? AND key = ? AND scope = ? AND materialized = 1 AND status = 'active' ORDER BY revision DESC LIMIT 1").get(companionId, domain, key, scope) as FactRow | undefined;
  }

  private evidenceRows(factId: string): EvidenceRow[] {
    return this.db.prepare('SELECT * FROM profile_evidence WHERE fact_version_id = ? ORDER BY event_id, source_revision').all(factId) as EvidenceRow[];
  }

  private asFact(row: FactRow): ProfileFact {
    const evidence = this.evidenceRows(row.id).map((item): StoredEvidence => {
      const stored: StoredEvidence = { eventId: item.event_id, sourceRevision: item.source_revision, quote: item.quote };
      if (item.receipt_id !== null) stored.receiptId = item.receipt_id;
      if (item.result_hash !== null) stored.resultHash = item.result_hash;
      return stored;
    });
    return asFactView(row, evidence);
  }

  private asCandidate(row: CandidateRow): ProfileCandidate {
    const candidate: ProfileCandidate = {
      id: row.id,
      companionId: row.companion_id,
      domain: row.domain,
      key: row.key,
      value: row.value,
      scope: row.scope,
      certainty: row.certainty,
      intent: row.intent as ProfileCandidate['intent'],
      status: row.status as ProfileCandidate['status'],
      baseVersion: row.base_version,
      reason: row.reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.expires_at !== null) candidate.expiresAt = row.expires_at;
    return candidate;
  }

  private maxFactRevision(companionId: string, domain: ProfileDomain, key: string, scope: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(revision), 0) AS n FROM profile_fact_versions WHERE companion_id = ? AND domain = ? AND key = ? AND scope = ?').get(companionId, domain, key, scope) as { n: number };
    return row.n;
  }

  private maxProfileRevision(companionId: string, domain: ProfileDomain, key: string, scope: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS n FROM profile_revisions WHERE companion_id = ? AND domain = ? AND key = ? AND scope = ?').get(companionId, domain, key, scope) as { n: number };
    return row.n;
  }

  private profileSupportRejection(event: EventRow, metadata: MetadataRow): string | null {
    if (metadata.origin === 'assistant') return 'assistant-guess';
    if (metadata.origin === 'external') return 'external-source';
    if (metadata.mode === 'roleplay' || metadata.mode === 'hypothetical') return 'roleplay-source';
    if (event.visibility !== 'private') return 'group-source';
    if (metadata.subject !== 'owner') return 'untrusted-source';
    if (metadata.mode === 'quotation' || metadata.mode === 'unknown') return 'untrusted-source';
    if (event.role !== 'user') return 'untrusted-source';
    if (metadata.learning !== 'enabled') return 'temporary-learning';
    return null;
  }

  private normalizeCandidate(input: ProfileCandidateInput): NormalizedCandidate {
    if (typeof input.domain !== 'string' || !domains.has(input.domain)) throw new Error('Invalid profile domain');
    const domain = input.domain as ProfileDomain;
    const key = profileKey(input.key);
    const value = bounded(input.value, 'profile value', 4000);
    const scope = identifier(input.scope ?? 'global', 'profile scope');
    if (input.certainty !== 'explicit' && input.certainty !== 'inferred') throw new Error('Invalid profile certainty');
    const intent = choice(input.intent ?? 'add', ['add', 'change-over-time', 'correct', 'retract'] as const, 'candidate intent');
    if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 8) {
      throw new Error('Candidate requires 1 to 8 evidence references');
    }
    const reason = bounded(input.reason, 'candidate reason', 1000);
    const validFrom = isoOrNull(input.validFrom, 'valid-from timestamp');
    const validTo = isoOrNull(input.validTo, 'valid-to timestamp');
    let expectedVersion: number | undefined;
    if (input.expectedVersion !== undefined) expectedVersion = timestamp(input.expectedVersion, 'expected version');
    return {
      domain,
      key,
      value,
      scope,
      certainty: input.certainty,
      intent,
      evidence: input.evidence,
      validFrom,
      validTo,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      reason,
    };
  }

  private validateEvidenceTx(companionId: string, evidence: EvidenceRef[], certainty: 'explicit' | 'inferred'): { ok: true; evidence: EvidenceRef[] } | { ok: false; reasonCode: string } {
    const checked: EvidenceRef[] = [];
    for (const reference of evidence) {
      if (reference.kind === 'quote') {
        const eventId = identifier(reference.eventId, 'evidence event ID');
        const sourceRevision = timestamp(reference.sourceRevision, 'source revision');
        const quote = bounded(reference.quote, 'evidence quote', 4000);
        const row = this.eventRow(companionId, eventId);
        if (row === undefined || row.forgotten === 1 || row.suppressed === 1) return { ok: false, reasonCode: 'untrusted-source' };
        if (row.superseded === 1) return { ok: false, reasonCode: 'superseded-source' };
        const metadata = this.metadataRow(companionId, eventId);
        if (metadata === undefined) return { ok: false, reasonCode: 'untrusted-source' };
        if (metadata.revision !== sourceRevision) return { ok: false, reasonCode: 'stale-source-revision' };
        const rejection = this.profileSupportRejection(row, metadata);
        if (rejection !== null) return { ok: false, reasonCode: rejection };
        if (!row.content.includes(quote)) return { ok: false, reasonCode: 'evidence-quote-mismatch' };
        checked.push({ kind: 'quote', eventId, sourceRevision, quote });
        continue;
      }
      const receiptId = identifier(reference.receiptId, 'tool receipt ID');
      const resultHash = bounded(reference.resultHash, 'tool result hash', 128);
      const receipt = this.toolReceipt(receiptId);
      if (receipt === null || receipt.companionId !== companionId || receipt.state !== 'completed') return { ok: false, reasonCode: 'tool-receipt-not-completed' };
      if (receipt.resultHash !== undefined && receipt.resultHash !== resultHash) return { ok: false, reasonCode: 'tool-receipt-mismatch' };
      if (certainty === 'explicit') return { ok: false, reasonCode: 'tool-receipt-cannot-establish-explicit' };
      checked.push({ kind: 'tool-receipt', receiptId, resultHash });
    }
    return { ok: true, evidence: checked };
  }

  private insertCandidateTx(companionId: string, normalized: NormalizedCandidate, status: string, baseVersion: number, expiresAt: string | null = null): string {
    const now = new Date().toISOString();
    const id = randomUUID();
    // Rejected inputs are still durable candidates, including early version/anchor
    // rejections. An erased source must never regain a body through that path.
    const erasedSource = normalized.evidence.some((reference) => reference.kind === 'quote'
      && typeof reference.eventId === 'string' && this.eventRow(companionId, reference.eventId.trim())?.forgotten === 1);
    this.db.prepare('INSERT INTO profile_candidates(id, companion_id, domain, key, value, scope, certainty, intent, evidence_json, valid_from, valid_to, expires_at, reason, base_version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, companionId, normalized.domain, normalized.key, erasedSource ? '' : normalized.value, normalized.scope, normalized.certainty,
      normalized.intent, erasedSource ? '[]' : JSON.stringify(normalized.evidence), normalized.validFrom, normalized.validTo, expiresAt, erasedSource ? '' : normalized.reason,
      baseVersion, status, now, now,
    );
    return id;
  }

  private commitLocked(companionId: string, input: CommitInput): ProfileFact {
    const currentRow = this.activeFactRow(companionId, input.domain, input.key, input.scope);
    const previous = currentRow === undefined ? null : this.asFact(currentRow);
    const now = new Date().toISOString();
    const revision = Math.max(this.maxFactRevision(companionId, input.domain, input.key, input.scope), this.maxProfileRevision(companionId, input.domain, input.key, input.scope)) + 1;
    if (previous !== null) {
      const nextStatus: FactStatus = input.intent === 'correct' ? 'corrected' : 'historical';
      const oldValidTo = input.intent === 'correct' ? (input.validTo ?? now) : (input.validFrom ?? now);
      this.db.prepare('UPDATE profile_fact_versions SET status = ?, materialized = 0, valid_to = ? WHERE id = ?').run(nextStatus, oldValidTo, previous.id);
      // A revision bump with the same value keeps the old source active: it still
      // supports the current value. Only a real replacement or correction retires it.
      if (previous.value !== input.value || input.intent === 'correct') {
        this.supersedeEvidenceEvents(companionId, previous.evidence);
      }
    }
    const validFrom = input.intent === 'correct'
      ? (previous === null ? (input.validFrom ?? now) : (previous.validFrom ?? (input.validFrom ?? now)))
      : (input.validFrom ?? now);
    const factId = randomUUID();
    this.db.prepare('INSERT INTO profile_fact_versions(id, companion_id, domain, key, scope, value, certainty, reason, valid_from, valid_to, recorded_at, revision, status, materialized, primary_source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'active\', 1, NULL)').run(
      factId, companionId, input.domain, input.key, input.scope, input.value, input.certainty, input.reason, validFrom, input.validTo, now, revision,
    );
    const factRow = this.factRow(factId) as FactRow;
    const stored = this.insertEvidenceTx(companionId, factRow, input.evidence, false);
    // Every newly published materialized version changes what the companion believes,
    // even when the value is identical: downstream context keyed by the epoch must refresh.
    this.bumpEpochTx(companionId);
    return this.asFact(stored);
  }

  private insertEvidenceTx(companionId: string, fact: FactRow, evidence: EvidenceRef[], bumpEpoch = true): FactRow {
    const insertEvidence = this.db.prepare('INSERT OR IGNORE INTO profile_evidence(fact_version_id, event_id, source_revision, quote, receipt_id, result_hash) VALUES (?, ?, ?, ?, ?, ?)');
    const insertDependency = this.db.prepare("INSERT OR IGNORE INTO derived_dependencies(derived_kind, derived_id, source_id, source_revision) VALUES ('profile_fact', ?, ?, ?)");
    let inserted = 0;
    for (const reference of evidence) {
      if (reference.kind === 'quote') {
        inserted += insertEvidence.run(fact.id, reference.eventId, reference.sourceRevision, reference.quote, null, null).changes;
        insertDependency.run(fact.id, reference.eventId, reference.sourceRevision);
      } else {
        inserted += insertEvidence.run(fact.id, 'tool:' + reference.receiptId, 1, '', reference.receiptId, reference.resultHash).changes;
        insertDependency.run(fact.id, 'tool:' + reference.receiptId, 1);
      }
    }
    const evidenceRows = this.evidenceRows(fact.id);
    const primary = evidenceRows.find((item) => item.receipt_id === null);
    if (primary !== undefined && fact.primary_source_id === null) {
      this.db.prepare('UPDATE profile_fact_versions SET primary_source_id = ? WHERE id = ?').run(primary.event_id, fact.id);
      this.db.prepare('UPDATE profiles SET source_event_id = ? WHERE companion_id = ? AND domain = ? AND key = ? AND scope = ?').run(primary.event_id, companionId, fact.domain, fact.key, fact.scope);
    }
    const refreshed = this.factRow(fact.id) as FactRow;
    // New support for the current value changes the derived state; historical
    // facts can gain quotes without changing what the companion currently believes.
    if (refreshed.materialized === 1 && inserted > 0 && bumpEpoch) this.bumpEpochTx(companionId);
    if (refreshed.materialized === 1) this.writeMaterialized(companionId, refreshed, evidenceRows);
    return refreshed;
  }

  private addEvidenceToFactTx(companionId: string, fact: FactRow, evidence: EvidenceRef[]): FactRow {
    return this.insertEvidenceTx(companionId, fact, evidence);
  }

  private retractFactTx(companionId: string, fact: FactRow, evidence: EvidenceRef[]): FactRow {
    this.db.prepare("UPDATE profile_fact_versions SET status = 'suppressed', materialized = 0, primary_source_id = NULL, valid_to = COALESCE(valid_to, ?) WHERE id = ?").run(new Date().toISOString(), fact.id);
    this.db.prepare('DELETE FROM profiles WHERE companion_id = ? AND domain = ? AND key = ? AND scope = ?').run(companionId, fact.domain, fact.key, fact.scope);
    this.insertEvidenceTx(companionId, fact, evidence);
    this.bumpEpochTx(companionId);
    return this.factRow(fact.id) as FactRow;
  }

  private writeMaterialized(companionId: string, fact: FactRow, evidenceRows: EvidenceRow[]): void {
    const primary = evidenceRows.find((item) => item.receipt_id === null);
    const quote = primary === undefined ? '' : primary.quote;
    const sourceEventId = primary === undefined ? fact.primary_source_id : primary.event_id;
    this.db.prepare("INSERT INTO profiles(companion_id, domain, key, scope, value, certainty, source_event_id, evidence_quote, reason, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(companion_id, domain, key, scope) DO UPDATE SET value = excluded.value, certainty = excluded.certainty, source_event_id = excluded.source_event_id, evidence_quote = excluded.evidence_quote, reason = excluded.reason, version = excluded.version, updated_at = excluded.updated_at").run(
      companionId, fact.domain, fact.key, fact.scope, fact.value, fact.certainty, sourceEventId, quote, fact.reason, fact.revision, fact.recorded_at,
    );
    this.db.prepare('INSERT INTO profile_revisions(companion_id, domain, key, scope, value, certainty, source_event_id, evidence_quote, reason, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      companionId, fact.domain, fact.key, fact.scope, fact.value, fact.certainty, sourceEventId, quote, fact.reason, fact.revision, fact.recorded_at,
    );
  }

  private supersedeEvidenceEvents(companionId: string, evidence: StoredEvidence[]): void {
    for (const item of evidence) {
      if (item.receiptId !== undefined) continue;
      const row = this.eventRow(companionId, item.eventId);
      if (row === undefined || row.forgotten === 1 || row.superseded === 1) continue;
      this.db.prepare('UPDATE events SET superseded = 1 WHERE companion_id = ? AND id = ?').run(companionId, item.eventId);
      invalidateCompanionSourcesTx(this.db, companionId, [item.eventId], 'suppress');
      this.cancelRetain(companionId, item.eventId);
      this.enqueue(companionId, item.eventId, 'delete');
    }
  }

  /**
   * Rebuilds the current value from the most recent past version that still has
   * valid evidence. Corrected values never return: they were explicitly wrong.
   * A past version whose quotes were superseded by a real replacement has no
   * independent support left, so it cannot become current again.
   */
  private restoreFallbackTx(companionId: string, domain: ProfileDomain, key: string, scope: string): void {
    if (this.activeFactRow(companionId, domain, key, scope) !== undefined) return;
    const candidates = this.db.prepare("SELECT * FROM profile_fact_versions WHERE companion_id = ? AND domain = ? AND key = ? AND scope = ? AND status = 'historical' AND materialized = 0 ORDER BY revision DESC, recorded_at DESC").all(companionId, domain, key, scope) as FactRow[];
    for (const candidate of candidates) {
      const evidence = this.evidenceRows(candidate.id);
      if (evidence.length === 0) continue;
      if (!evidence.every((item) => this.evidenceStillAllowed(companionId, item))) continue;
      const primary = evidence.find((item) => item.receipt_id === null);
      this.db.prepare("UPDATE profile_fact_versions SET status = 'active', materialized = 1, primary_source_id = ?, valid_to = NULL WHERE id = ?").run(primary === undefined ? null : primary.event_id, candidate.id);
      const restored = this.factRow(candidate.id) as FactRow;
      this.writeMaterialized(companionId, restored, this.evidenceRows(candidate.id));
      return;
    }
    this.db.prepare('DELETE FROM profiles WHERE companion_id = ? AND domain = ? AND key = ? AND scope = ?').run(companionId, domain, key, scope);
  }

  private evidenceStillAllowed(companionId: string, evidence: EvidenceRow): boolean {
    if (evidence.receipt_id !== null) {
      const receipt = this.toolReceipt(evidence.receipt_id);
      return receipt !== null && receipt.state === 'completed';
    }
    const row = this.eventRow(companionId, evidence.event_id);
    return row !== undefined && row.forgotten === 0 && row.suppressed === 0 && row.superseded === 0;
  }

  private currentEpochTx(companionId: string): number {
    const existing = this.db.prepare('SELECT state_epoch FROM companion_epochs WHERE companion_id = ?').get(companionId) as { state_epoch: number } | undefined;
    if (existing !== undefined) return existing.state_epoch;
    this.db.prepare('INSERT OR IGNORE INTO companion_epochs(companion_id, state_epoch, deletion_watermark) VALUES (?, 0, 0)').run(companionId);
    const created = this.db.prepare('SELECT state_epoch FROM companion_epochs WHERE companion_id = ?').get(companionId) as { state_epoch: number };
    return created.state_epoch;
  }

  private bumpEpochTx(companionId: string): number {
    const next = this.currentEpochTx(companionId) + 1;
    this.db.prepare('UPDATE companion_epochs SET state_epoch = ?, deletion_watermark = ? WHERE companion_id = ?').run(next, Date.now(), companionId);
    return next;
  }

  private eraseEventsTx(companionId: string, eventIds: string[], mode: ForgetMode, recordRequest: boolean): ForgetOutcome {
    const epoch = this.bumpEpochTx(companionId);
    const forgotten: string[] = [];
    if (mode === 'deprioritize') {
      for (const eventId of eventIds) {
        const row = this.eventRow(companionId, eventId);
        if (row === undefined || row.forgotten === 1 || row.deprioritized === 1) continue;
        this.db.prepare('UPDATE events SET deprioritized = 1 WHERE companion_id = ? AND id = ?').run(companionId, eventId);
        forgotten.push(eventId);
      }
    } else {
      const erase = mode === 'erase';
      for (const eventId of eventIds) {
        const row = this.eventRow(companionId, eventId);
        if (row === undefined || row.forgotten === 1) continue;
        this.db.prepare('UPDATE events SET forgotten = ?, suppressed = 1, deprioritized = 0, content = ?, fingerprint = ? WHERE companion_id = ? AND id = ?').run(
          erase ? 1 : 0, erase ? '' : row.content, erase ? 'forgotten' : row.fingerprint, companionId, eventId,
        );
        if (erase) {
          this.db.prepare("UPDATE profile_revisions SET value = '', evidence_quote = '', reason = '', redacted = 1 WHERE companion_id = ? AND source_event_id = ?").run(companionId, eventId);
          // The materialized view is a tombstone too: the erased quote must not survive there.
          this.db.prepare("UPDATE profiles SET evidence_quote = '' WHERE companion_id = ? AND source_event_id = ?").run(companionId, eventId);
        }
        this.cancelRetain(companionId, eventId);
        if (erase) this.enqueue(companionId, eventId, 'delete');
        forgotten.push(eventId);
      }
      // Retry erasure against every selected ID, including sources already marked
      // forgotten, to clean any copies persisted by an older or delayed writer.
      this.reevaluateEvidenceTx(companionId, erase ? eventIds : forgotten, mode);
      invalidateCompanionSourcesTx(this.db, companionId, erase ? eventIds : forgotten, erase ? 'erase' : 'suppress');
      if (forgotten.length > 0 && erase) {
        this.db.prepare(`UPDATE backend_operations SET state = 'cleanup_pending', cleanup_state = CASE WHEN cleanup_state = 'done' THEN 'done' ELSE 'pending' END, next_check_at = 0 WHERE companion_id = ? AND document_id IN (SELECT value FROM json_each(?)) AND state NOT IN ('erased', 'failed')
          AND NOT EXISTS (SELECT 1 FROM memory_index_locations l WHERE l.companion_id = backend_operations.companion_id AND l.operation_id = backend_operations.operation_id AND l.id = backend_operations.document_id AND l.memory_id IS NOT NULL)`).run(
          companionId, JSON.stringify(forgotten),
        );
      }
    }
    let requestId = '';
    if (recordRequest) {
      requestId = randomUUID();
      const now = new Date().toISOString();
      // Only erasure has a remote cleanup to report. Suppression revokes the source
      // locally and leaves the payload where it is.
      const backend: CleanupState = mode === 'erase' ? 'pending' : 'not-requested';
      const payloads: CleanupState = mode === 'erase' ? 'pending' : 'not-requested';
      const history: CleanupState = mode === 'erase' ? 'blocked' : 'not-requested';
      this.db.prepare("INSERT INTO forget_requests(id, companion_id, selector_json, mode, state_epoch, local_status, backend_status, operation_payload_status, history_status, backup_status, detail_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'done', ?, ?, ?, 'not-included', '{}', ?, ?)").run(
        requestId, companionId, JSON.stringify(eventIds), mode, epoch, backend, payloads, history, now, now,
      );
    }
    return { requestId, epoch, mode, forgotten };
  }

  private reevaluateEvidenceTx(companionId: string, eventIds: string[], mode: ForgetMode): void {
    if (eventIds.length === 0) return;
    const placeholders = eventIds.map(() => '?').join(', ');
    // Suppression removes usable quotes but keeps provenance metadata, so a later
    // erase can still find historical bodies without treating them as evidence.
    const affected = this.db.prepare("SELECT f.id FROM profile_fact_versions f WHERE f.companion_id = ? AND (EXISTS (SELECT 1 FROM profile_evidence e WHERE e.fact_version_id = f.id AND e.event_id IN (" + placeholders + ")) OR EXISTS (SELECT 1 FROM derived_dependencies d WHERE d.derived_kind = 'profile_fact' AND d.derived_id = f.id AND d.source_id IN (" + placeholders + ')))').all(companionId, ...eventIds, ...eventIds) as { id: string }[];
    this.db.prepare('DELETE FROM profile_evidence WHERE event_id IN (' + placeholders + ') AND fact_version_id IN (SELECT id FROM profile_fact_versions WHERE companion_id = ?)').run(...eventIds, companionId);
    if (mode === 'erase') {
      this.db.prepare("DELETE FROM derived_dependencies WHERE derived_kind = 'profile_fact' AND source_id IN (" + placeholders + ') AND derived_id IN (SELECT id FROM profile_fact_versions WHERE companion_id = ?)').run(...eventIds, companionId);
    }
    const now = new Date().toISOString();
    // Keys whose current view this revocation cleared. They may still have a provable
    // past value, so try to fall back before declaring the belief unknown.
    const lostCurrent = new Set<string>();
    for (const item of affected) {
      const fact = this.factRow(item.id);
      if (fact === undefined) continue;
      if (mode === 'erase') {
        // A free-form explanation may quote the erased source even when other
        // evidence still supports the value. Clear every copy of this revision's
        // explanation without touching independently supported values or versions.
        this.db.prepare("UPDATE profile_fact_versions SET reason = '' WHERE id = ?").run(fact.id);
        this.db.prepare("UPDATE profiles SET reason = '' WHERE companion_id = ? AND domain = ? AND key = ? AND scope = ? AND version = ?").run(companionId, fact.domain, fact.key, fact.scope, fact.revision);
        this.db.prepare("UPDATE profile_revisions SET reason = '' WHERE companion_id = ? AND domain = ? AND key = ? AND scope = ? AND version = ?").run(companionId, fact.domain, fact.key, fact.scope, fact.revision);
      }
      const remaining = this.evidenceRows(fact.id);
      if (remaining.length === 0) {
        const status: FactStatus = mode === 'erase' ? 'forgotten' : 'suppressed';
        this.db.prepare('UPDATE profile_fact_versions SET status = ?, materialized = 0, primary_source_id = NULL, valid_to = COALESCE(valid_to, ?), value = ?, reason = ? WHERE id = ?').run(
          status, now, mode === 'erase' ? '' : fact.value, mode === 'erase' ? '' : fact.reason, fact.id,
        );
        // Only the fact that currently backs the materialized view may clear it; an old
        // historical/corrected fact losing its own evidence must not hide the current value.
        if (fact.materialized === 1) {
          this.db.prepare('DELETE FROM profiles WHERE companion_id = ? AND domain = ? AND key = ? AND scope = ?').run(companionId, fact.domain, fact.key, fact.scope);
          lostCurrent.add(JSON.stringify([fact.domain, fact.key, fact.scope]));
        }
        continue;
      }
      const primary = remaining.find((entry) => entry.receipt_id === null);
      if (fact.primary_source_id === null || eventIds.includes(fact.primary_source_id)) {
        const nextPrimary = primary === undefined ? null : primary.event_id;
        this.db.prepare('UPDATE profile_fact_versions SET primary_source_id = ? WHERE id = ?').run(nextPrimary, fact.id);
        if (fact.materialized === 1) {
          // Switching the primary quote must also purge the revoked quote from the view.
          this.db.prepare('UPDATE profiles SET source_event_id = ?, evidence_quote = ? WHERE companion_id = ? AND domain = ? AND key = ? AND scope = ?').run(nextPrimary, primary === undefined ? '' : primary.quote, companionId, fact.domain, fact.key, fact.scope);
        }
      }
    }
    for (const lost of lostCurrent) {
      const [domain, key, scope] = JSON.parse(lost) as [ProfileDomain, string, string];
      this.restoreFallbackTx(companionId, domain, key, scope);
    }
    const candidates = this.db.prepare('SELECT id, status, evidence_json FROM profile_candidates WHERE companion_id = ?').all(companionId) as { id: string; status: string; evidence_json: string }[];
    const dependentCandidates = new Set((this.db.prepare("SELECT DISTINCT c.id FROM profile_candidates c JOIN derived_dependencies d ON d.derived_kind = 'profile_candidate' AND d.derived_id = c.id WHERE c.companion_id = ? AND d.source_id IN (" + placeholders + ')').all(companionId, ...eventIds) as { id: string }[]).map(({ id }) => id));
    for (const candidate of candidates) {
      if (mode !== 'erase' && candidate.status !== 'proposed' && candidate.status !== 'committed') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate.evidence_json) as unknown;
      } catch {
        parsed = [];
      }
      const references = Array.isArray(parsed) ? parsed : [];
      const hit = dependentCandidates.has(candidate.id) || references.some((reference) => {
        if (typeof reference !== 'object' || reference === null || !('eventId' in reference)) return false;
        return eventIds.includes(String((reference as { eventId: unknown }).eventId).trim());
      });
      if (!hit) continue;
      if (mode === 'erase') {
        this.db.prepare("UPDATE profile_candidates SET status = 'invalidated', evidence_json = '[]', value = '', reason = '', updated_at = ? WHERE id = ?").run(now, candidate.id);
        this.db.prepare("DELETE FROM derived_dependencies WHERE derived_kind = 'profile_candidate' AND derived_id = ?").run(candidate.id);
      } else {
        // Keep only source IDs/revisions for later erasure, never a second copy of
        // the quote. These links cannot make an invalidated candidate usable.
        for (const reference of references) {
          if (typeof reference !== 'object' || reference === null || reference.kind !== 'quote') continue;
          if (typeof reference.eventId !== 'string' || !Number.isSafeInteger(reference.sourceRevision)) continue;
          this.db.prepare("INSERT OR IGNORE INTO derived_dependencies(derived_kind, derived_id, source_id, source_revision) VALUES ('profile_candidate', ?, ?, ?)").run(candidate.id, reference.eventId.trim(), reference.sourceRevision);
        }
        this.db.prepare("UPDATE profile_candidates SET status = 'invalidated', evidence_json = '[]', updated_at = ? WHERE id = ?").run(now, candidate.id);
      }
    }
  }

  private enqueue(companionId: string, documentId: string, operation: 'retain' | 'delete', dueAt = 0): void {
    const existing = this.db.prepare("SELECT id FROM memory_jobs WHERE companion_id = ? AND document_id = ? AND operation = ? AND status = 'pending' ORDER BY id LIMIT 1").get(companionId, documentId, operation) as { id: number } | undefined;
    if (existing !== undefined) {
      this.db.prepare('UPDATE memory_jobs SET next_attempt_at = MIN(next_attempt_at, ?) WHERE id = ?').run(dueAt, existing.id);
      return;
    }
    this.db.prepare("INSERT INTO memory_jobs(companion_id, document_id, operation, status, attempts, next_attempt_at) VALUES (?, ?, ?, 'pending', 0, ?)").run(companionId, documentId, operation, dueAt);
  }

  private cancelRetain(companionId: string, documentId: string): void {
    this.db.prepare("UPDATE memory_jobs SET status = 'cancelled' WHERE companion_id = ? AND document_id = ? AND operation = 'retain' AND status IN ('pending', 'failed')").run(companionId, documentId);
  }

  private hasUncertainWrite(companionId: string, documentId: string): boolean {
    const row = this.db.prepare('SELECT 1 AS present FROM uncertain_writes WHERE companion_id = ? AND document_id = ?').get(companionId, documentId) as { present: number } | undefined;
    return row !== undefined;
  }

  private settleJob(jobId: number, leaseToken: string, failedAt?: number, uncertainWrite = false): boolean {
    return this.db.transaction((): boolean => {
      const lease = this.db.prepare('SELECT settled FROM job_leases WHERE token = ? AND job_id = ?').get(leaseToken, jobId) as { settled: number } | undefined;
      if (lease === undefined || lease.settled === 1) return false;
      const job = this.db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(jobId) as JobRow | undefined;
      if (job === undefined) return false;
      if (uncertainWrite && job.operation === 'retain') {
        this.db.prepare('INSERT OR IGNORE INTO uncertain_writes(companion_id, document_id) VALUES (?, ?)').run(job.companion_id, job.document_id);
      }
      const owned = job.status === 'running' && job.lease_token === leaseToken;
      this.db.prepare('UPDATE job_leases SET settled = 1 WHERE token = ?').run(leaseToken);
      if (owned) {
        const status = failedAt === undefined ? 'done' : job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
        const nextAttemptAt = failedAt === undefined ? 0 : failedAt + Math.min(60000, 1000 * 2 ** (job.attempts - 1));
        this.db.prepare('UPDATE memory_jobs SET status = ?, next_attempt_at = ?, lease_token = NULL, lease_until = NULL WHERE id = ?').run(status, nextAttemptAt, job.id);
      }
      if (job.operation === 'retain' && !this.isDocumentAllowed(job.companion_id, job.document_id)) {
        this.cancelRetain(job.companion_id, job.document_id);
        this.enqueue(job.companion_id, job.document_id, 'delete');
      }
      if (owned && failedAt === undefined && job.operation === 'delete' && !this.isDocumentAllowed(job.companion_id, job.document_id) && this.hasUncertainWrite(job.companion_id, job.document_id)) {
        this.enqueue(job.companion_id, job.document_id, 'delete', Date.now() + 60000);
      }
      return owned;
    }).immediate();
  }
}
