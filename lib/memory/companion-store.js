import { createHash, randomUUID } from 'node:crypto';
function identifier(value, label) {
    if (typeof value !== 'string')
        throw new Error('Invalid ' + label);
    const normalized = value.trim();
    if (normalized.length < 1 || normalized.length > 128 || /[\x00-\x1f\x7f]/.test(normalized))
        throw new Error('Invalid ' + label);
    return normalized;
}
function exact(value, keys, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
        throw new Error('Invalid ' + label + ' field');
}
function integer(value, label, min = 0) {
    if (!Number.isSafeInteger(value) || value < min)
        throw new Error('Invalid ' + label);
    return value;
}
function bounded(value, label, max, empty = false) {
    if (typeof value !== 'string' || value.length > max || !empty && value.trim().length === 0 || value.includes('\0'))
        throw new Error('Invalid ' + label + ' length');
    return value;
}
function sourceRef(ref) {
    exact(ref, ['eventId', 'sourceRevision'], 'source reference');
    return { eventId: identifier(ref.eventId, 'event ID'), sourceRevision: integer(ref.sourceRevision, 'source revision') };
}
function memoryRef(ref) {
    exact(ref, ['memoryId', 'revision'], 'memory reference');
    return { memoryId: identifier(ref.memoryId, 'memory ID'), revision: integer(ref.revision, 'memory revision', 1) };
}
const sourceKey = (ref) => JSON.stringify([ref.eventId, ref.sourceRevision]);
const memoryKey = (ref) => JSON.stringify([ref.memoryId, ref.revision]);
function refs(values, parse, key, label, min = 0, max = 1000) {
    if (!Array.isArray(values) || values.length < min || values.length > max)
        throw new Error('Invalid ' + label + ' count');
    const seen = new Set();
    return values.map(value => { const parsed = parse(value); const k = key(parsed); if (seen.has(k))
        throw new Error('Duplicate ' + label); seen.add(k); return parsed; });
}
function validateDraft(value) {
    exact(value, ['summary', 'meaning', 'anchors', 'view', 'certainty', 'reason', 'useWhen', 'avoidWhen', 'sourceRefs', 'parentRefs'], 'draft');
    if (!['user_understanding', 'shared_episode', 'interaction_habit'].includes(value.view))
        throw new Error('Invalid draft view');
    if (value.certainty !== 'explicit' && value.certainty !== 'inferred')
        throw new Error('Invalid draft certainty');
    if (!Array.isArray(value.anchors) || value.anchors.length > 100)
        throw new Error('Invalid anchors count');
    return { ...(value.summary === undefined ? {} : { summary: bounded(value.summary, 'summary', 320) }), meaning: bounded(value.meaning, 'meaning', 16000), anchors: value.anchors.map(v => bounded(v, 'anchor', 1000)), view: value.view, certainty: value.certainty,
        reason: bounded(value.reason, 'reason', 8000, true), useWhen: bounded(value.useWhen, 'useWhen', 4000, true), avoidWhen: bounded(value.avoidWhen, 'avoidWhen', 4000, true),
        sourceRefs: refs(value.sourceRefs, sourceRef, sourceKey, 'source references'), parentRefs: refs(value.parentRefs, memoryRef, memoryKey, 'parent references', 0, 100) };
}
function validateOperation(op) {
    if (op === null || typeof op !== 'object')
        throw new Error('Invalid operation');
    switch (op.action) {
        case 'retain':
            exact(op, ['action', 'draft'], 'operation');
            return { action: op.action, draft: validateDraft(op.draft) };
        case 'merge':
            exact(op, ['action', 'targets', 'draft'], 'operation');
            return { action: op.action, targets: refs(op.targets, memoryRef, memoryKey, 'merge targets', 2, 100), draft: validateDraft(op.draft) };
        case 'condense':
            exact(op, ['action', 'target', 'draft'], 'operation');
            return { action: op.action, target: memoryRef(op.target), draft: validateDraft(op.draft) };
        case 'deprioritize':
        case 'discard':
            exact(op, ['action', 'target'], 'operation');
            return { action: op.action, target: memoryRef(op.target) };
        case 'summarize':
            exact(op, ['action', 'target', 'summary'], 'operation');
            return { action: op.action, target: memoryRef(op.target), summary: bounded(op.summary, 'summary', 320) };
        case 'defer':
            exact(op, ['action', 'sourceRefs'], 'operation');
            return { action: op.action, sourceRefs: refs(op.sourceRefs, sourceRef, sourceKey, 'operation sources', 1) };
        case 'release_details':
            exact(op, ['action', 'sourceRefs', 'summaries'], 'operation');
            return { action: op.action, sourceRefs: refs(op.sourceRefs, sourceRef, sourceKey, 'operation sources', 1), ...(op.summaries === undefined ? {} : { summaries: refs(op.summaries, memoryRef, memoryKey, 'sufficient summaries', 0, 100) }) };
        default: throw new Error('Invalid operation action');
    }
}
function asMemory(row) {
    return { companionId: row.companion_id, memoryId: row.id, revision: row.revision, summary: row.summary, meaning: row.meaning, anchors: JSON.parse(row.anchors_json), view: row.view,
        certainty: row.certainty, reason: row.reason, useWhen: row.use_when, avoidWhen: row.avoid_when, status: row.status, pinned: row.pinned === 1,
        detailsUnavailable: row.details_unavailable === 1, detailState: row.detail_state, detailColdSince: row.detail_cold_since,
        createdAt: row.created_at, lastReviewedAt: row.last_reviewed_at, lastRetrievedAt: row.last_retrieved_at, lastPresentedAt: row.last_presented_at };
}
function asLocation(row) {
    return { companionId: row.companion_id, id: row.id, bank: row.bank, bankKind: row.bank_kind, documentId: row.document_id, operationId: row.operation_id,
        source: row.event_id === null ? null : { eventId: row.event_id, sourceRevision: row.source_revision },
        memory: row.memory_id === null ? null : { memoryId: row.memory_id, revision: row.memory_revision }, indexState: row.index_state, cleanupState: row.cleanup_state };
}
/** StateStore calls this only inside its existing source invalidation transaction. */
export function invalidateCompanionSourcesTx(db, companionId, eventIds, mode) {
    if (!db.inTransaction)
        throw new Error('Source invalidation requires a transaction');
    if (eventIds.length === 0)
        return;
    const affected = db.prepare(`WITH RECURSIVE affected(id) AS (
    SELECT memory_id FROM companion_memory_evidence WHERE companion_id = ? AND event_id IN (SELECT value FROM json_each(?))
    UNION SELECT l.child_id FROM companion_memory_links l JOIN affected a ON l.parent_id = a.id WHERE l.companion_id = ?
  ) SELECT id FROM affected`).all(companionId, JSON.stringify(eventIds), companionId);
    const ids = JSON.stringify(affected.map(row => row.id));
    if (mode === 'erase') {
        db.prepare(`UPDATE companion_memories SET status = 'forgotten', summary = NULL, meaning = '', anchors_json = '[]', reason = '', use_when = '', avoid_when = '',
      details_unavailable = 1, detail_state = 'unavailable' WHERE companion_id = ? AND id IN (SELECT value FROM json_each(?))`).run(companionId, ids);
        db.prepare(`UPDATE memory_index_locations SET cleanup_state = 'pending' WHERE companion_id = ? AND cleanup_state != 'done'
      AND (event_id IN (SELECT value FROM json_each(?)) OR memory_id IN (SELECT value FROM json_each(?)))`).run(companionId, JSON.stringify(eventIds), ids);
        db.prepare(`UPDATE backend_operations SET state = 'cleanup_pending', cleanup_state = CASE WHEN cleanup_state = 'done' THEN 'done' ELSE 'pending' END, next_check_at = 0
      WHERE companion_id = ? AND state != 'erased' AND operation_id IN
      (SELECT operation_id FROM memory_index_locations WHERE companion_id = ? AND cleanup_state = 'pending')`)
            .run(companionId, companionId);
        db.prepare("UPDATE companion_staged_sources SET status = 'erased' WHERE companion_id = ? AND event_id IN (SELECT value FROM json_each(?))").run(companionId, JSON.stringify(eventIds));
    }
    else {
        // Keep provenance and body so a later erase can still locate every historical copy.
        db.prepare("UPDATE companion_memories SET status = 'discarded' WHERE companion_id = ? AND status != 'forgotten' AND id IN (SELECT value FROM json_each(?))").run(companionId, ids);
    }
}
/** This is an evidence-admission rule, independent of the legacy document guard. */
export function isCompanionSourceEligible(event) {
    return event.visibility === 'private' && event.learning !== 'temporary' && event.contentMode !== 'roleplay'
        && (event.role !== 'tool' || event.toolVerified === true && event.origin === 'verified-tool' && event.toolReceiptId !== undefined);
}
const SOURCE_JOINS = `FROM companion_staged_sources s
JOIN events e ON e.companion_id = s.companion_id AND e.id = s.event_id
JOIN event_metadata m ON m.companion_id = e.companion_id AND m.event_id = e.id
LEFT JOIN companion_tasks t ON t.companion_id = s.companion_id AND t.task_id = s.task_id`;
const SOURCE_VALIDITY = `e.forgotten = 0 AND e.suppressed = 0 AND e.superseded = 0
AND m.revision = s.source_revision AND e.visibility = 'private' AND m.learning = 'enabled' AND m.mode != 'roleplay'
AND (s.expires_at IS NULL OR julianday(s.expires_at) > julianday(?))
AND (e.role IN ('user', 'assistant') OR (e.role = 'tool' AND e.tool_verified = 1 AND m.origin = 'verified-tool'
  AND EXISTS (SELECT 1 FROM tool_receipts r WHERE r.id = m.tool_receipt_id AND r.companion_id = s.companion_id AND r.state = 'completed')))`;
function asPending(row) {
    const metadata = {
        companionId: row.companion_id, eventId: row.id, origin: row.origin, subject: row.subject,
        mode: row.mode, revision: row.revision, receivedAt: row.received_at, sessionSeq: row.session_seq, learning: row.learning,
    };
    if (row.host_ref !== null)
        metadata.hostRef = row.host_ref;
    if (row.channel_ref !== null)
        metadata.channelRef = row.channel_ref;
    if (row.tool_receipt_id !== null)
        metadata.toolReceiptId = row.tool_receipt_id;
    const event = {
        id: row.id, companionId: row.companion_id, sessionId: row.session_id, role: row.role, content: row.content,
        occurredAt: row.occurred_at, visibility: row.visibility, origin: row.origin, subject: row.subject,
        contentMode: row.mode, revision: row.revision, receivedAt: row.received_at, learning: row.learning,
    };
    if (row.tool_verified !== null)
        event.toolVerified = row.tool_verified === 1;
    if (row.host_ref !== null)
        event.hostRef = row.host_ref;
    if (row.channel_ref !== null)
        event.channelRef = row.channel_ref;
    if (row.tool_receipt_id !== null)
        event.toolReceiptId = row.tool_receipt_id;
    return {
        event, metadata, purpose: row.purpose, taskId: row.task_id, taskState: row.task_state,
        status: 'pending', stagedAt: row.staged_at, expiresAt: row.expires_at,
        evidenceKind: row.role === 'tool' ? 'tool_result'
            : row.role === 'user' && row.origin === 'owner' && row.subject === 'owner' && row.mode === 'real' ? 'user_statement' : 'interaction',
    };
}
/** Shares StateStore's private connection and lifetime; never opens or exposes a database. */
export class CompanionMemoryStore {
    #db;
    constructor(db) { this.#db = db; }
    #reopenLocation(cid, id, operationId) {
        const requests = this.#db.prepare("SELECT id, selector_json FROM forget_requests WHERE companion_id = ? AND mode = 'erase'").all(cid);
        for (const request of requests)
            if (this.indexLocationsForEvents(cid, JSON.parse(request.selector_json)).some(l => l.id === id)) {
                this.#db.prepare("UPDATE forget_requests SET backend_status = 'pending', operation_payload_status = 'pending', updated_at = ? WHERE id = ?").run(new Date().toISOString(), request.id);
            }
        if (operationId !== null)
            this.#db.prepare("UPDATE backend_operations SET state = 'cleanup_pending', cleanup_state = CASE WHEN cleanup_state = 'done' THEN 'done' ELSE 'pending' END, next_check_at = 0 WHERE companion_id = ? AND operation_id = ? AND state != 'erased'").run(cid, operationId);
    }
    /** Re-read current material and its complete evidence/DAG. Never returns staged source text. */
    materialSnapshot(companionId, reference) {
        const cid = identifier(companionId, 'companion ID');
        const ref = memoryRef(reference);
        try {
            return this.#db.transaction(() => {
                const memory = this.getMemory(cid, ref.memoryId);
                if (memory === null || memory.revision !== ref.revision || memory.status !== 'active' && memory.status !== 'deprioritized')
                    return null;
                this.#validParent(cid, ref);
                const content = memory.summary ?? '';
                return { memory, content, payloadHash: createHash('sha256').update(content).digest('hex') };
            }).immediate();
        }
        catch {
            return null;
        }
    }
    indexableMemoryRefs(companionId) {
        return this.#db.prepare(`SELECT m.id, m.revision FROM companion_memories m WHERE companion_id = ? AND status IN ('active','deprioritized')
      AND summary IS NOT NULL AND length(trim(summary)) > 0
      AND revision = (SELECT MAX(n.revision) FROM companion_memories n WHERE n.companion_id = m.companion_id AND n.id = m.id) ORDER BY m.id`)
            .all(identifier(companionId, 'companion ID')).map(r => ({ memoryId: r.id, revision: r.revision }));
    }
    /** Validate the whole DAG and capture a disclosure page under one write lock. */
    disclosureSnapshot(companionId, reference, rawOffset) {
        const cid = identifier(companionId, 'companion ID');
        const ref = memoryRef(reference);
        if (rawOffset !== undefined && (!Number.isSafeInteger(rawOffset) || rawOffset < 0))
            throw new Error('Invalid raw offset');
        return this.#db.transaction(() => {
            const current = this.getMemory(cid, ref.memoryId);
            if (current === null || current.revision !== ref.revision || current.status !== 'active' && current.status !== 'deprioritized')
                throw new Error('Memory unavailable or revision is not current');
            this.#validParent(cid, ref);
            const sourceRefs = this.evidenceFor(cid, ref).map(({ eventId, sourceRevision }) => ({ eventId, sourceRevision }));
            if (rawOffset !== undefined && rawOffset > sourceRefs.length)
                throw new Error('Invalid raw offset');
            const page = rawOffset === undefined ? [] : sourceRefs.slice(rawOffset, rawOffset + 4);
            const sources = page.map(source => {
                const row = this.#db.prepare(`SELECT e.role, e.content, e.occurred_at,
          EXISTS (SELECT 1 FROM companion_staged_sources s WHERE s.companion_id = e.companion_id
            AND s.event_id = e.id AND s.source_revision = ? AND s.status = 'compacted') AS released
          FROM events e WHERE e.companion_id = ? AND e.id = ?`).get(source.sourceRevision, cid, source.eventId);
                return { ...source, role: row.role, content: row.released ? null : row.content, occurredAt: row.occurred_at };
            });
            const nextOffset = rawOffset !== undefined && rawOffset + page.length < sourceRefs.length ? rawOffset + page.length : null;
            return { memory: current, sourceRefs, sources, nextOffset };
        }).immediate();
    }
    #row(cid, ref) {
        const row = this.#db.prepare('SELECT * FROM companion_memories WHERE companion_id = ? AND id = ? AND revision = ?').get(cid, ref.memoryId, ref.revision);
        if (row === undefined)
            throw new Error('Unknown memory revision');
        return row;
    }
    #validSource(cid, ref) {
        const row = this.#db.prepare(`SELECT e.role, m.origin, m.subject, m.mode FROM events e
      JOIN event_metadata m ON m.companion_id = e.companion_id AND m.event_id = e.id
      WHERE e.companion_id = ? AND e.id = ? AND m.revision = ?
      AND e.forgotten = 0 AND e.suppressed = 0 AND e.superseded = 0 AND e.visibility = 'private' AND m.learning = 'enabled' AND m.mode != 'roleplay'
      AND (e.role IN ('user', 'assistant') OR (e.role = 'tool' AND e.tool_verified = 1 AND m.origin = 'verified-tool'
        AND EXISTS (SELECT 1 FROM tool_receipts r WHERE r.id = m.tool_receipt_id AND r.companion_id = e.companion_id AND r.state = 'completed')))
      AND NOT EXISTS (SELECT 1 FROM companion_staged_sources s WHERE s.companion_id = e.companion_id AND s.event_id = e.id AND s.source_revision = m.revision
        AND (s.status IN ('ignored', 'erased') OR s.expires_at IS NOT NULL AND julianday(s.expires_at) <= julianday(?)))`)
            .get(cid, ref.eventId, ref.sourceRevision, new Date().toISOString());
        if (row === undefined)
            throw new Error('Source unavailable or revision conflict');
        return row;
    }
    #validParent(cid, ref) {
        const row = this.#row(cid, ref);
        if (row.status === 'discarded' || row.status === 'forgotten')
            throw new Error('Parent memory is unavailable');
        // Follow actual graph edges as well as inherited evidence; a parent is never independent evidence.
        const ancestors = this.#db.prepare(`WITH RECURSIVE ancestors(id, revision) AS (
      SELECT ?, ? UNION SELECT l.parent_id, l.parent_revision FROM companion_memory_links l
      JOIN ancestors a ON l.child_id = a.id AND l.child_revision = a.revision WHERE l.companion_id = ?
    ) SELECT m.* FROM companion_memories m JOIN ancestors a ON m.id = a.id AND m.revision = a.revision WHERE m.companion_id = ?`)
            .all(ref.memoryId, ref.revision, cid, cid);
        for (const ancestor of ancestors) {
            if (ancestor.status === 'discarded' || ancestor.status === 'forgotten')
                throw new Error('Parent memory is unavailable');
            const evidence = this.evidenceFor(cid, { memoryId: ancestor.id, revision: ancestor.revision });
            if (evidence.length === 0)
                throw new Error('Parent has no source evidence');
            for (const item of evidence)
                this.#validSource(cid, { eventId: item.eventId, sourceRevision: item.sourceRevision });
        }
        return row;
    }
    #currentTarget(cid, ref, allowPinned = false) {
        const row = this.#row(cid, ref);
        const current = this.#db.prepare('SELECT MAX(revision) AS revision FROM companion_memories WHERE companion_id = ? AND id = ?').get(cid, ref.memoryId);
        if (current.revision !== ref.revision || row.status !== 'active' && row.status !== 'deprioritized')
            throw new Error('Target must be the current active memory revision');
        if (row.pinned === 1 && !allowPinned)
            throw new Error('Pinned memory cannot be changed by a plan');
        this.#validParent(cid, ref);
        return row;
    }
    #bump(cid) {
        this.#db.prepare('UPDATE companion_epochs SET state_epoch = state_epoch + 1 WHERE companion_id = ?').run(cid);
        return this.#db.prepare('SELECT state_epoch FROM companion_epochs WHERE companion_id = ?').get(cid).state_epoch;
    }
    /** Validates and commits a whole model plan under one SQLite write lock. Replays are explicit errors. */
    applyPlan(input) {
        exact(input, ['planId', 'companionId', 'expectedEpoch', 'reviewedSources', 'operations'], 'plan');
        const planId = identifier(input.planId, 'plan ID');
        const cid = identifier(input.companionId, 'companion ID');
        const expectedEpoch = integer(input.expectedEpoch, 'expected epoch');
        const reviewed = refs(input.reviewedSources, sourceRef, sourceKey, 'reviewed sources');
        if (!Array.isArray(input.operations) || input.operations.length > 100)
            throw new Error('Invalid operations count');
        if (input.operations.length === 0 && reviewed.length === 0)
            throw new Error('Empty plan requires reviewed sources or operations');
        const operations = input.operations.map(validateOperation);
        return this.#db.transaction(() => {
            if (this.#db.prepare('SELECT 1 FROM companion_memory_plans WHERE plan_id = ?').get(planId) !== undefined)
                throw new Error('Plan ID already applied; replay rejected');
            const epoch = this.#db.prepare('SELECT state_epoch FROM companion_epochs WHERE companion_id = ?').get(cid);
            if (epoch === undefined)
                throw new Error('Unknown companion');
            if (epoch.state_epoch !== expectedEpoch)
                throw new Error('Companion state epoch conflict');
            const now = new Date().toISOString();
            const reviewedKeys = new Set(reviewed.map(sourceKey));
            const deferred = new Set();
            const consumed = new Set();
            for (const ref of reviewed) {
                this.#validSource(cid, ref);
                const staged = this.#db.prepare('SELECT status FROM companion_staged_sources WHERE companion_id = ? AND event_id = ? AND source_revision = ?').get(cid, ref.eventId, ref.sourceRevision);
                if (staged === undefined || staged.status !== 'pending' && staged.status !== 'reviewed')
                    throw new Error('Reviewed staged source unavailable');
            }
            // Validate every target before applying any action, including duplicate consumption.
            for (const op of operations) {
                if (op.action === 'release_details') {
                    for (const ref of op.sourceRefs)
                        this.#validSource(cid, ref);
                    for (const ref of op.summaries ?? [])
                        this.#currentTarget(cid, ref);
                    continue;
                }
                if (op.action === 'defer') {
                    for (const ref of op.sourceRefs) {
                        const key = sourceKey(ref);
                        if (!reviewedKeys.has(key))
                            throw new Error('Deferred source must be in reviewed sources');
                        deferred.add(key);
                    }
                    continue;
                }
                const targets = op.action === 'merge' ? op.targets : op.action === 'retain' ? [] : [op.target];
                for (const ref of targets) {
                    if (consumed.has(ref.memoryId))
                        throw new Error('Duplicate target memory');
                    consumed.add(ref.memoryId);
                    const target = this.#currentTarget(cid, ref, op.action === 'summarize');
                    if (op.action === 'summarize' && target.summary !== null)
                        throw new Error('Memory summary already exists');
                }
            }
            const created = [];
            const changed = new Map();
            const allSources = new Map(reviewed.map(ref => [sourceKey(ref), ref]));
            for (const op of operations) {
                if (op.action === 'defer' || op.action === 'release_details')
                    continue;
                if (op.action === 'summarize') {
                    this.#db.prepare('UPDATE companion_memories SET summary = ? WHERE companion_id = ? AND id = ? AND revision = ?')
                        .run(op.summary, cid, op.target.memoryId, op.target.revision);
                    changed.set(memoryKey(op.target), op.target);
                    for (const item of this.evidenceFor(cid, op.target)) {
                        const ref = { eventId: item.eventId, sourceRevision: item.sourceRevision };
                        allSources.set(sourceKey(ref), ref);
                    }
                    continue;
                }
                if (op.action === 'discard' || op.action === 'deprioritize') {
                    changed.set(memoryKey(op.target), op.target);
                    for (const item of this.evidenceFor(cid, op.target)) {
                        const ref = { eventId: item.eventId, sourceRevision: item.sourceRevision };
                        allSources.set(sourceKey(ref), ref);
                    }
                    this.#db.prepare(`UPDATE companion_memories SET status = ?, last_reviewed_at = ?,
            detail_state = CASE WHEN ? THEN 'cold' ELSE detail_state END,
            detail_cold_since = CASE WHEN ? THEN ? ELSE detail_cold_since END
            WHERE companion_id = ? AND id = ? AND revision = ?`)
                        .run(op.action === 'discard' ? 'discarded' : 'deprioritized', now, op.action === 'discard' ? 1 : 0, op.action === 'discard' ? 1 : 0, now, cid, op.target.memoryId, op.target.revision);
                    continue;
                }
                const targets = op.action === 'merge' ? op.targets : op.action === 'condense' ? [op.target] : [];
                const parentMap = new Map();
                for (const ref of [...targets, ...op.draft.parentRefs])
                    parentMap.set(memoryKey(ref), ref);
                const parents = [...parentMap.values()];
                const parentRows = parents.map(ref => this.#validParent(cid, ref));
                const evidence = new Map();
                const inheritedKeys = new Set();
                const direct = op.draft.sourceRefs.map(ref => ({ ref, row: this.#validSource(cid, ref) }));
                for (const item of direct)
                    evidence.set(sourceKey(item.ref), item);
                for (const ref of parents)
                    for (const item of this.evidenceFor(cid, ref)) {
                        const source = { eventId: item.eventId, sourceRevision: item.sourceRevision };
                        inheritedKeys.add(sourceKey(source));
                        evidence.set(sourceKey(source), { ref: source, row: this.#validSource(cid, source) });
                    }
                if (evidence.size === 0)
                    throw new Error('Memory requires source or parent evidence');
                const ownerStatement = (row) => row.role === 'user' && row.origin === 'owner' && row.subject === 'owner' && row.mode === 'real';
                if (op.draft.view === 'user_understanding' && op.draft.certainty === 'explicit' && ![...evidence.values()].some(item => ownerStatement(item.row)))
                    throw new Error('Explicit user understanding requires a user source');
                const newExplicitEvidence = direct.some(item => !inheritedKeys.has(sourceKey(item.ref)) && (op.draft.view !== 'user_understanding' || ownerStatement(item.row)));
                if (op.draft.certainty === 'explicit' && parentRows.some(row => row.certainty === 'inferred') && !newExplicitEvidence)
                    throw new Error('Inferred parents cannot become explicit without a new source');
                const ref = op.action === 'condense' ? { memoryId: op.target.memoryId, revision: op.target.revision + 1 } : { memoryId: randomUUID(), revision: 1 };
                const cold = op.action === 'condense';
                for (const target of targets) {
                    changed.set(memoryKey(target), target);
                    this.#db.prepare(`UPDATE companion_memories SET status = ?, last_reviewed_at = ?,
          detail_state = CASE WHEN ? THEN 'cold' ELSE detail_state END, detail_cold_since = CASE WHEN ? THEN COALESCE(detail_cold_since, ?) ELSE detail_cold_since END
          WHERE companion_id = ? AND id = ? AND revision = ?`).run(cold ? 'condensed' : 'historical', now, cold ? 1 : 0, cold ? 1 : 0, now, cid, target.memoryId, target.revision);
                }
                this.#db.prepare(`INSERT INTO companion_memories(companion_id,id,revision,summary,meaning,anchors_json,view,certainty,reason,use_when,avoid_when,status,created_at,last_reviewed_at,detail_state,detail_cold_since)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`).run(cid, ref.memoryId, ref.revision, op.draft.summary ?? null, op.draft.meaning, JSON.stringify(op.draft.anchors), op.draft.view, op.draft.certainty, op.draft.reason, op.draft.useWhen, op.draft.avoidWhen, now, now, cold ? 'cold' : 'required', cold ? now : null);
                for (const item of evidence.values()) {
                    this.#db.prepare('INSERT INTO companion_memory_evidence(companion_id,memory_id,memory_revision,event_id,source_revision,source_role) VALUES (?, ?, ?, ?, ?, ?)')
                        .run(cid, ref.memoryId, ref.revision, item.ref.eventId, item.ref.sourceRevision, item.row.role);
                    allSources.set(sourceKey(item.ref), item.ref);
                }
                this.#db.prepare(`UPDATE companion_memories SET details_unavailable = 1, detail_state = 'unavailable'
          WHERE companion_id = ? AND id = ? AND revision = ? AND EXISTS (
            SELECT 1 FROM companion_memory_evidence e JOIN companion_staged_sources s
              ON s.companion_id = e.companion_id AND s.event_id = e.event_id AND s.source_revision = e.source_revision
            WHERE e.companion_id = ? AND e.memory_id = ? AND e.memory_revision = ? AND s.status = 'compacted')`)
                    .run(cid, ref.memoryId, ref.revision, cid, ref.memoryId, ref.revision);
                for (const parent of parents)
                    this.#db.prepare('INSERT INTO companion_memory_links(companion_id,parent_id,parent_revision,child_id,child_revision) VALUES (?, ?, ?, ?, ?)').run(cid, parent.memoryId, parent.revision, ref.memoryId, ref.revision);
                created.push(ref);
                changed.set(memoryKey(ref), ref);
            }
            // Discard is authorized for exact targets only. It cannot strand useful descendants or silently discard them.
            for (const op of operations)
                if (op.action === 'discard') {
                    const dependent = this.#db.prepare(`WITH RECURSIVE descendants(id, revision) AS (
          SELECT child_id, child_revision FROM companion_memory_links WHERE companion_id = ? AND parent_id = ? AND parent_revision = ?
          UNION SELECT l.child_id, l.child_revision FROM companion_memory_links l JOIN descendants d ON l.parent_id = d.id AND l.parent_revision = d.revision WHERE l.companion_id = ?
        ) SELECT 1 FROM companion_memories m JOIN descendants d ON m.id = d.id AND m.revision = d.revision
          WHERE m.companion_id = ? AND m.status IN ('active', 'deprioritized') LIMIT 1`).get(cid, op.target.memoryId, op.target.revision, cid, cid);
                    if (dependent !== undefined)
                        throw new Error('Discarded parent still has active dependent memories');
                }
            // A later action in this batch must not invalidate an earlier child's required parent.
            for (const ref of created)
                this.#validParent(cid, ref);
            for (const ref of reviewed)
                if (!deferred.has(sourceKey(ref)))
                    this.#db.prepare("UPDATE companion_staged_sources SET status = 'reviewed', reviewed_at = ? WHERE companion_id = ? AND event_id = ? AND source_revision = ?").run(now, cid, ref.eventId, ref.sourceRevision);
            // A defer can deliberately put an already-reviewed source back in the pending queue.
            for (const ref of reviewed)
                if (deferred.has(sourceKey(ref)))
                    this.#db.prepare("UPDATE companion_staged_sources SET status = 'pending', reviewed_at = NULL WHERE companion_id = ? AND event_id = ? AND source_revision = ?").run(cid, ref.eventId, ref.sourceRevision);
            // This is an explicit model operation, never an age/frequency/importance heuristic.
            // Newly authored summaries and their replaced revisions can stand in for the
            // selected originals. Independent consumers still have to release their needs.
            for (const op of operations)
                if (op.action === 'release_details') {
                    const sufficient = new Map((op.summaries ?? []).map(ref => [memoryKey(ref), ref]));
                    const releasable = new Map([...changed, ...sufficient]);
                    for (const source of op.sourceRefs) {
                        if (deferred.has(sourceKey(source)))
                            throw new Error('Deferred source details are still needed');
                        for (const reference of releasable.values()) {
                            const memory = this.#row(cid, reference);
                            if (!sufficient.has(memoryKey(reference)) && !created.some(item => memoryKey(item) === memoryKey(reference)) && !['historical', 'condensed', 'discarded'].includes(memory.status))
                                continue;
                            this.#db.prepare(`UPDATE companion_memories SET detail_state = 'cold', detail_cold_since = COALESCE(detail_cold_since, ?)
              WHERE companion_id = ? AND id = ? AND revision = ? AND detail_state != 'unavailable'
              AND EXISTS (SELECT 1 FROM companion_memory_evidence e WHERE e.companion_id = companion_memories.companion_id
                AND e.memory_id = companion_memories.id AND e.memory_revision = companion_memories.revision AND e.event_id = ? AND e.source_revision = ?)`)
                                .run(now, cid, reference.memoryId, reference.revision, source.eventId, source.sourceRevision);
                        }
                        const eligibility = this.checkDetailCleanup(cid, source);
                        if (!eligibility.eligible)
                            throw new Error('Source details still required: ' + eligibility.blockers.join(', '));
                        // Legacy raw-source indexing has a separate payload lifecycle. It cannot
                        // silently retain a raw copy while this operation claims detail release.
                        const rawCopy = this.#db.prepare(`SELECT 1 FROM memory_index_locations WHERE companion_id = ? AND event_id = ? AND cleanup_state != 'done'
            UNION SELECT 1 FROM backend_operations WHERE companion_id = ? AND document_id = ? AND state != 'erased' LIMIT 1`)
                            .get(cid, source.eventId, cid, source.eventId);
                        if (rawCopy)
                            throw new Error('Source details still have a raw index copy');
                        this.#db.prepare("UPDATE events SET content = '' WHERE companion_id = ? AND id = ?").run(cid, source.eventId);
                        this.#db.prepare("UPDATE companion_staged_sources SET status = 'compacted', reviewed_at = ? WHERE companion_id = ? AND event_id = ? AND source_revision = ?")
                            .run(now, cid, source.eventId, source.sourceRevision);
                        this.#db.prepare(`UPDATE companion_memories SET details_unavailable = 1, detail_state = 'unavailable'
            WHERE companion_id = ? AND EXISTS (SELECT 1 FROM companion_memory_evidence e
              WHERE e.companion_id = companion_memories.companion_id AND e.memory_id = companion_memories.id
              AND e.memory_revision = companion_memories.revision AND e.event_id = ? AND e.source_revision = ?)`)
                            .run(cid, source.eventId, source.sourceRevision);
                        allSources.set(sourceKey(source), source);
                    }
                }
            const stateEpoch = this.#bump(cid);
            this.#db.prepare("INSERT INTO companion_memory_plans(plan_id,companion_id,expected_epoch,applied_epoch,source_refs_json,result_refs_json,state,applied_at) VALUES (?, ?, ?, ?, ?, ?, 'applied', ?)")
                .run(planId, cid, expectedEpoch, stateEpoch, JSON.stringify([...allSources.values()]), JSON.stringify([...changed.values()]), now);
            return { status: 'applied', planId, stateEpoch, memories: created };
        }).immediate();
    }
    listMemories(companionId, options = {}) {
        const cid = identifier(companionId, 'companion ID');
        const limit = options.limit === undefined ? 100 : options.limit;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
            throw new Error('Invalid memory limit');
        if (options.includeHistory !== undefined && typeof options.includeHistory !== 'boolean')
            throw new Error('Invalid history option');
        return this.#db.prepare(`SELECT m.* FROM companion_memories m WHERE companion_id = ? ${options.includeHistory === true ? '' : "AND status IN ('active', 'deprioritized') AND revision = (SELECT MAX(n.revision) FROM companion_memories n WHERE n.companion_id = m.companion_id AND n.id = m.id)"}
      ORDER BY created_at DESC, id, revision DESC LIMIT ?`).all(cid, limit).map(asMemory);
    }
    /** Stable bounded backfill page. Eligibility checks do not assign semantic importance. */
    listMemoriesWithoutSummary(companionId, limit = 24, excluded = []) {
        const cid = identifier(companionId, 'companion ID');
        const skip = new Set(excluded.map(ref => memoryKey(memoryRef(ref))));
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
            throw new Error('Invalid memory limit');
        const rows = this.#db.prepare(`SELECT m.* FROM companion_memories m WHERE companion_id = ? AND summary IS NULL
      AND status IN ('active', 'deprioritized') AND revision = (SELECT MAX(n.revision) FROM companion_memories n WHERE n.companion_id = m.companion_id AND n.id = m.id)
      ORDER BY id`).iterate(cid);
        const result = [];
        for (const row of rows) {
            if (skip.has(memoryKey({ memoryId: row.id, revision: row.revision })))
                continue;
            try {
                this.#validParent(cid, { memoryId: row.id, revision: row.revision });
            }
            catch {
                continue;
            }
            result.push(asMemory(row));
            if (result.length >= limit)
                break;
        }
        return result;
    }
    /** All current model-classified profile entries, independent of the general catalog page limit. */
    listProfileMemories(companionId) {
        return this.#db.prepare(`SELECT m.* FROM companion_memories m WHERE companion_id = ?
      AND view IN ('user_understanding', 'interaction_habit') AND status IN ('active', 'deprioritized')
      AND revision = (SELECT MAX(n.revision) FROM companion_memories n WHERE n.companion_id = m.companion_id AND n.id = m.id)
      ORDER BY id`).all(identifier(companionId, 'companion ID')).map(asMemory);
    }
    getMemory(companionId, refOrId) {
        const cid = identifier(companionId, 'companion ID');
        const row = typeof refOrId === 'string'
            ? this.#db.prepare('SELECT * FROM companion_memories WHERE companion_id = ? AND id = ? ORDER BY revision DESC LIMIT 1').get(cid, identifier(refOrId, 'memory ID'))
            : this.#db.prepare('SELECT * FROM companion_memories WHERE companion_id = ? AND id = ? AND revision = ?').get(cid, memoryRef(refOrId).memoryId, refOrId.revision);
        return row === undefined ? null : asMemory(row);
    }
    evidenceFor(companionId, reference) {
        const cid = identifier(companionId, 'companion ID');
        const ref = memoryRef(reference);
        this.#row(cid, ref);
        const rows = this.#db.prepare('SELECT event_id, source_revision, source_role FROM companion_memory_evidence WHERE companion_id = ? AND memory_id = ? AND memory_revision = ? ORDER BY event_id, source_revision').all(cid, ref.memoryId, ref.revision);
        return rows.map(row => ({ companionId: cid, ...ref, eventId: row.event_id, sourceRevision: row.source_revision, sourceRole: row.source_role }));
    }
    parentsFor(companionId, reference) {
        const cid = identifier(companionId, 'companion ID');
        const ref = memoryRef(reference);
        this.#row(cid, ref);
        return this.#db.prepare('SELECT parent_id, parent_revision FROM companion_memory_links WHERE companion_id = ? AND child_id = ? AND child_revision = ? ORDER BY parent_id, parent_revision').all(cid, ref.memoryId, ref.revision)
            .map(row => ({ memoryId: row.parent_id, revision: row.parent_revision }));
    }
    /** Trusted user pin control; exact current revision, with plan invalidation on change. */
    pinMemory(companionId, reference, pinned) {
        const cid = identifier(companionId, 'companion ID');
        const ref = memoryRef(reference);
        if (typeof pinned !== 'boolean')
            throw new Error('Invalid pinned value');
        return this.#db.transaction(() => {
            const row = this.#row(cid, ref);
            const latest = this.getMemory(cid, ref.memoryId);
            if (latest.revision !== ref.revision || row.status !== 'active' && row.status !== 'deprioritized')
                throw new Error('Pin requires the current active memory revision');
            if (row.pinned === (pinned ? 1 : 0))
                return false;
            this.#db.prepare('UPDATE companion_memories SET pinned = ? WHERE companion_id = ? AND id = ? AND revision = ?').run(pinned ? 1 : 0, cid, ref.memoryId, ref.revision);
            this.#bump(cid);
            return true;
        }).immediate();
    }
    recordRetrieved(companionId, references) { this.#recordTime(companionId, references, 'last_retrieved_at'); }
    recordPresented(companionId, references) { this.#recordTime(companionId, references, 'last_presented_at'); }
    #recordTime(companionId, references, column) {
        const cid = identifier(companionId, 'companion ID');
        const parsed = refs(references, memoryRef, memoryKey, 'memory references', 1);
        this.#db.transaction(() => {
            for (const ref of parsed)
                this.#row(cid, ref);
            const now = new Date().toISOString();
            for (const ref of parsed)
                this.#db.prepare('UPDATE companion_memories SET ' + column + ' = ? WHERE companion_id = ? AND id = ? AND revision = ?').run(now, cid, ref.memoryId, ref.revision);
        }).immediate();
    }
    /** Trusted lifecycle control only; this neither claims raw text was removed nor performs erasure. */
    setDetailState(companionId, reference, state) {
        const cid = identifier(companionId, 'companion ID');
        const ref = memoryRef(reference);
        if (state !== 'required' && state !== 'cold')
            throw new Error('Invalid detail state');
        return this.#db.transaction(() => {
            const row = this.#row(cid, ref);
            this.#validParent(cid, ref);
            if (row.detail_state === 'unavailable')
                throw new Error('Details already unavailable');
            if (row.detail_state === state)
                return false;
            this.#db.prepare('UPDATE companion_memories SET detail_state = ?, detail_cold_since = ? WHERE companion_id = ? AND id = ? AND revision = ?')
                .run(state, state === 'cold' ? new Date().toISOString() : null, cid, ref.memoryId, ref.revision);
            this.#bump(cid);
            return true;
        }).immediate();
    }
    /** Event-wide eligibility: a summary's references never authorize clearing another use's original text. */
    checkDetailCleanup(companionId, reference) {
        const cid = identifier(companionId, 'companion ID');
        const ref = sourceRef(reference);
        const blockers = new Set();
        try {
            this.#validSource(cid, ref);
        }
        catch {
            blockers.add('source-unavailable');
        }
        if (this.#db.prepare("SELECT 1 FROM companion_staged_sources WHERE companion_id = ? AND event_id = ? AND status = 'pending'").get(cid, ref.eventId))
            blockers.add('pending-review');
        if (this.#db.prepare(`SELECT 1 FROM companion_staged_sources s JOIN companion_tasks t ON t.companion_id = s.companion_id AND t.task_id = s.task_id
      WHERE s.companion_id = ? AND s.event_id = ? AND t.state = 'active'
      UNION SELECT 1 FROM companion_task_sources s JOIN companion_tasks t ON t.companion_id = s.companion_id AND t.task_id = s.task_id
      WHERE s.companion_id = ? AND s.event_id = ? AND t.state = 'active' LIMIT 1`).get(cid, ref.eventId, cid, ref.eventId))
            blockers.add('active-task');
        const memories = this.#db.prepare(`SELECT DISTINCT m.* FROM companion_memories m JOIN companion_memory_evidence e
      ON e.companion_id = m.companion_id AND e.memory_id = m.id AND e.memory_revision = m.revision
      WHERE m.companion_id = ? AND e.event_id = ?`).all(cid, ref.eventId);
        for (const row of memories) {
            const latest = this.getMemory(cid, row.id);
            for (const evidence of this.evidenceFor(cid, { memoryId: row.id, revision: row.revision })) {
                try {
                    this.#validSource(cid, { eventId: evidence.eventId, sourceRevision: evidence.sourceRevision });
                }
                catch {
                    blockers.add('source-unavailable');
                }
            }
            if (latest.pinned && latest.status !== 'forgotten' && latest.status !== 'discarded')
                blockers.add('pinned-memory');
            if (row.status !== 'discarded' && row.status !== 'forgotten' && row.detail_state === 'required')
                blockers.add('memory-needs-details');
        }
        if (this.#db.prepare(`SELECT 1 FROM profile_evidence e JOIN profile_fact_versions f ON f.id = e.fact_version_id WHERE f.companion_id = ? AND e.event_id = ?
      UNION SELECT 1 FROM profiles WHERE companion_id = ? AND source_event_id = ?
      UNION SELECT 1 FROM profile_revisions WHERE companion_id = ? AND source_event_id = ? AND redacted = 0
      UNION SELECT 1 FROM derived_dependencies d JOIN profile_fact_versions f ON f.id = d.derived_id WHERE d.derived_kind = 'profile_fact' AND f.companion_id = ? AND d.source_id = ? LIMIT 1`)
            .get(cid, ref.eventId, cid, ref.eventId, cid, ref.eventId, cid, ref.eventId))
            blockers.add('profile-evidence');
        if (this.#pendingProposalNeedsDetails(cid, ref.eventId))
            blockers.add('profile-candidate');
        return { source: ref, eligible: blockers.size === 0, blockers: [...blockers] };
    }
    #pendingProposalNeedsDetails(cid, eventId) {
        if (this.#db.prepare(`SELECT 1 FROM profile_candidates c JOIN derived_dependencies d ON d.derived_kind = 'profile_candidate' AND d.derived_id = c.id
      WHERE c.companion_id = ? AND c.status = 'proposed' AND trim(d.source_id) = ? LIMIT 1`).get(cid, eventId) !== undefined)
            return true;
        const receipt = this.#db.prepare('SELECT tool_receipt_id FROM event_metadata WHERE companion_id = ? AND event_id = ?').get(cid, eventId);
        const candidates = this.#db.prepare("SELECT evidence_json FROM profile_candidates WHERE companion_id = ? AND status = 'proposed'").all(cid);
        for (const candidate of candidates) {
            let evidence;
            try {
                evidence = JSON.parse(candidate.evidence_json);
            }
            catch {
                return true;
            }
            if (!Array.isArray(evidence))
                return true;
            for (const item of evidence) {
                if (item === null || typeof item !== 'object' || Array.isArray(item))
                    return true;
                const entry = item;
                if (entry.kind === 'quote') {
                    if (typeof entry.eventId !== 'string' || entry.eventId.trim().length === 0 || !Number.isSafeInteger(entry.sourceRevision) || entry.sourceRevision < 0 || typeof entry.quote !== 'string')
                        return true;
                    if (entry.eventId.trim() === eventId)
                        return true;
                }
                else if (entry.kind === 'tool-receipt') {
                    if (typeof entry.receiptId !== 'string' || entry.receiptId.trim().length === 0 || typeof entry.resultHash !== 'string')
                        return true;
                    if (receipt?.tool_receipt_id !== null && receipt?.tool_receipt_id !== undefined && entry.receiptId.trim() === receipt.tool_receipt_id)
                        return true;
                }
                else
                    return true;
            }
        }
        return false;
    }
    /** Internal opaque routing handle, never derived from model content or a backend algorithm. */
    registerIndexLocation(companionId, input) {
        const cid = identifier(companionId, 'companion ID');
        exact(input, ['bank', 'bankKind', 'documentId', 'operationId', 'source', 'memory'], 'index location');
        const hasSource = input.source !== undefined;
        const hasMemory = input.memory !== undefined;
        if (hasSource === hasMemory)
            throw new Error('Index location requires exactly one source or memory reference (XOR)');
        const source = hasSource ? sourceRef(input.source) : null;
        const memory = hasMemory ? memoryRef(input.memory) : null;
        const bank = bounded(input.bank, 'bank', 512);
        const documentId = bounded(input.documentId, 'document ID', 512);
        const operationId = input.operationId === undefined || input.operationId === null ? null : identifier(input.operationId, 'operation ID');
        if (input.bankKind !== 'legacy' && input.bankKind !== 'companion')
            throw new Error('Invalid bank kind');
        return this.#db.transaction(() => {
            let revoked = false;
            if (source !== null) {
                const known = this.#db.prepare(`SELECT e.forgotten, m.revision FROM events e JOIN event_metadata m ON m.companion_id = e.companion_id AND m.event_id = e.id WHERE e.companion_id = ? AND e.id = ?
          AND (m.revision = ? OR EXISTS (SELECT 1 FROM companion_staged_sources s WHERE s.companion_id = e.companion_id AND s.event_id = e.id AND s.source_revision = ?)
            OR EXISTS (SELECT 1 FROM companion_memory_evidence c WHERE c.companion_id = e.companion_id AND c.event_id = e.id AND c.source_revision = ?))`)
                    .get(cid, source.eventId, source.sourceRevision, source.sourceRevision, source.sourceRevision);
                if (known === undefined)
                    throw new Error('Unknown source revision');
                revoked = known.forgotten === 1;
            }
            if (memory !== null)
                revoked = this.#row(cid, memory).status === 'forgotten';
            const id = randomUUID();
            this.#db.prepare(`INSERT INTO memory_index_locations(companion_id,id,bank,bank_kind,document_id,operation_id,event_id,source_revision,memory_id,memory_revision,cleanup_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(cid, id, bank, input.bankKind, documentId, operationId, source?.eventId ?? null, source?.sourceRevision ?? null, memory?.memoryId ?? null, memory?.revision ?? null, revoked ? 'pending' : 'not-requested');
            // A delayed external registration must reopen every matching erase receipt.
            if (revoked)
                this.#reopenLocation(cid, id, operationId);
            return this.getIndexLocation(cid, id);
        }).immediate();
    }
    getIndexLocation(companionId, handle) {
        const row = this.#db.prepare('SELECT * FROM memory_index_locations WHERE companion_id = ? AND id = ?').get(identifier(companionId, 'companion ID'), identifier(handle, 'location handle'));
        return row === undefined ? null : asLocation(row);
    }
    findIndexLocation(companionId, bank, documentId) {
        const row = this.#db.prepare('SELECT * FROM memory_index_locations WHERE companion_id = ? AND bank = ? AND document_id = ?').get(identifier(companionId, 'companion ID'), bank, documentId);
        return row === undefined ? null : asLocation(row);
    }
    indexLocationForOperation(companionId, operationId) {
        const row = this.#db.prepare('SELECT * FROM memory_index_locations WHERE companion_id = ? AND operation_id = ?').get(identifier(companionId, 'companion ID'), identifier(operationId, 'operation ID'));
        return row === undefined ? null : asLocation(row);
    }
    listIndexLocations(companionId) {
        return this.#db.prepare('SELECT * FROM memory_index_locations WHERE companion_id = ? ORDER BY id').all(identifier(companionId, 'companion ID')).map(asLocation);
    }
    ensureIndexLocation(companionId, input) {
        return this.#db.transaction(() => {
            const existing = this.findIndexLocation(companionId, input.bank, input.documentId);
            if (existing === null)
                return this.registerIndexLocation(companionId, input);
            if (existing.bankKind !== input.bankKind || JSON.stringify(existing.memory) !== JSON.stringify(input.memory ?? null) || JSON.stringify(existing.source) !== JSON.stringify(input.source ?? null)
                || input.operationId !== undefined && input.operationId !== existing.operationId)
                throw new Error('Index location identity conflict');
            return existing;
        }).immediate();
    }
    updateIndexLocation(companionId, handle, patch) {
        exact(patch, ['operationId', 'indexState', 'cleanupState'], 'location patch');
        return this.#db.transaction(() => {
            const current = this.getIndexLocation(companionId, handle);
            if (current === null)
                throw new Error('Unknown index location');
            if (patch.operationId !== undefined && current.operationId !== null && patch.operationId !== current.operationId)
                throw new Error('Location operation identity conflict');
            const operationId = patch.operationId === undefined ? current.operationId : patch.operationId === null ? null : identifier(patch.operationId, 'operation ID');
            const state = current.indexState === 'erased' ? 'erased' : patch.indexState ?? current.indexState;
            let cleanup = patch.cleanupState ?? current.cleanupState;
            const lateOperation = operationId !== current.operationId && current.cleanupState !== 'not-requested';
            if (lateOperation)
                cleanup = 'pending';
            else if (current.cleanupState === 'done')
                cleanup = 'done';
            if (cleanup === 'done' && operationId !== null) {
                const operation = this.#db.prepare('SELECT state FROM backend_operations WHERE companion_id = ? AND operation_id = ?').get(companionId, operationId);
                if (operation?.state !== 'erased')
                    cleanup = 'pending';
            }
            if (!['pending', 'indexed', 'failed', 'erased'].includes(state) || !['not-requested', 'pending', 'done', 'unknown', 'blocked'].includes(cleanup))
                throw new Error('Invalid location state');
            this.#db.prepare('UPDATE memory_index_locations SET operation_id = ?, index_state = ?, cleanup_state = ? WHERE companion_id = ? AND id = ?').run(operationId, state, cleanup, companionId, handle);
            if (lateOperation)
                this.#reopenLocation(companionId, handle, operationId);
            return this.getIndexLocation(companionId, handle);
        }).immediate();
    }
    /** Event-wide across all revisions and historical DAG edges; erasure must not depend on current bodies. */
    indexLocationsForEvents(companionId, eventIds) {
        const cid = identifier(companionId, 'companion ID');
        const ids = JSON.stringify(eventIds.map(id => identifier(id, 'event ID')));
        return this.#db.prepare(`WITH RECURSIVE affected(id) AS (
      SELECT memory_id FROM companion_memory_evidence WHERE companion_id = ? AND event_id IN (SELECT value FROM json_each(?))
      UNION SELECT l.child_id FROM companion_memory_links l JOIN affected a ON l.parent_id = a.id WHERE l.companion_id = ?
    ) SELECT * FROM memory_index_locations WHERE companion_id = ? AND (event_id IN (SELECT value FROM json_each(?)) OR memory_id IN (SELECT id FROM affected)) ORDER BY id`)
            .all(cid, ids, cid, cid, ids).map(asLocation);
    }
    indexLocationsForSource(companionId, reference) {
        const cid = identifier(companionId, 'companion ID');
        const ref = sourceRef(reference);
        return this.#db.prepare(`WITH RECURSIVE affected(id) AS (
      SELECT memory_id FROM companion_memory_evidence WHERE companion_id = ? AND event_id = ? AND source_revision = ?
      UNION SELECT l.child_id FROM companion_memory_links l JOIN affected a ON l.parent_id = a.id WHERE l.companion_id = ?
    ) SELECT * FROM memory_index_locations WHERE companion_id = ? AND ((event_id = ? AND source_revision = ?) OR memory_id IN (SELECT id FROM affected)) ORDER BY id`)
            .all(cid, ref.eventId, ref.sourceRevision, cid, cid, ref.eventId, ref.sourceRevision).map(asLocation);
    }
    /** Trusted task orchestration: one real source revision may support several independent tasks. */
    linkTaskSource(companionId, taskId, reference) {
        const cid = identifier(companionId, 'companion ID');
        const tid = identifier(taskId, 'task ID');
        const ref = sourceRef(reference);
        return this.#db.transaction(() => {
            this.#validSource(cid, ref);
            this.#db.prepare('INSERT OR IGNORE INTO companion_tasks(companion_id,task_id) VALUES (?, ?)').run(cid, tid);
            const changed = this.#db.prepare('INSERT OR IGNORE INTO companion_task_sources(companion_id,task_id,event_id,source_revision) VALUES (?, ?, ?, ?)').run(cid, tid, ref.eventId, ref.sourceRevision).changes > 0;
            if (changed)
                this.#bump(cid);
            return changed;
        }).immediate();
    }
    /** Ordered by source occurredAt, then append order for ties; returns complete text. */
    listPending(companionId, options = {}) {
        const cid = identifier(companionId, 'companion ID');
        const limit = options.limit === undefined ? 100 : options.limit;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
            throw new Error('Invalid pending source limit');
        const sessionId = options.sessionId === undefined ? null : identifier(options.sessionId, 'session ID');
        const rows = this.#db.prepare(`SELECT e.*, m.*, s.purpose, s.task_id, t.state AS task_state, s.staged_at, s.expires_at
      ${SOURCE_JOINS} WHERE s.companion_id = ? AND s.status = 'pending' AND ${SOURCE_VALIDITY}
      ${sessionId === null ? '' : 'AND e.session_id = ?'} ORDER BY e.occurred_at_ms, e.rowid LIMIT ?`)
            .all(cid, new Date().toISOString(), ...(sessionId === null ? [] : [sessionId]), limit);
        return rows.map(asPending);
    }
    /** Total UTF-8 body bytes over every currently valid pending source, independent of page size. */
    pendingBytes(companionId) {
        const cid = identifier(companionId, 'companion ID');
        const row = this.#db.prepare(`SELECT COALESCE(SUM(length(CAST(e.content AS BLOB))), 0) AS bytes
      ${SOURCE_JOINS} WHERE s.companion_id = ? AND s.status = 'pending' AND ${SOURCE_VALIDITY}`)
            .get(cid, new Date().toISOString());
        return row.bytes;
    }
    /** All references must still exist at the supplied revisions; any invalid item rolls back the batch. */
    markReviewed(companionId, sources) {
        const cid = identifier(companionId, 'companion ID');
        if (!Array.isArray(sources) || sources.length < 1 || sources.length > 1000)
            throw new Error('Review requires 1..1000 sources');
        const seen = new Set();
        const refs = sources.map(source => {
            const eventId = identifier(source.eventId, 'event ID');
            if (!Number.isSafeInteger(source.sourceRevision) || source.sourceRevision < 0)
                throw new Error('Invalid source revision');
            if (seen.has(eventId))
                throw new Error('Duplicate source reference');
            seen.add(eventId);
            return { eventId, sourceRevision: source.sourceRevision };
        });
        return this.#db.transaction(() => {
            const now = new Date().toISOString();
            let changed = 0;
            for (const ref of refs) {
                const current = this.#db.prepare(`SELECT s.status, m.revision ${SOURCE_JOINS}
          WHERE s.companion_id = ? AND s.event_id = ? AND s.source_revision = ?`)
                    .get(cid, ref.eventId, ref.sourceRevision);
                if (current === undefined) {
                    const exists = this.#db.prepare('SELECT 1 FROM companion_staged_sources WHERE companion_id = ? AND event_id = ?').get(cid, ref.eventId);
                    throw new Error(exists === undefined ? 'Unknown staged source' : 'Source revision conflict');
                }
                if (current.revision !== ref.sourceRevision)
                    throw new Error('Source revision conflict');
                const valid = this.#db.prepare(`SELECT 1 ${SOURCE_JOINS}
          WHERE s.companion_id = ? AND s.event_id = ? AND s.source_revision = ? AND ${SOURCE_VALIDITY}`)
                    .get(cid, ref.eventId, ref.sourceRevision, now);
                if (valid === undefined || current.status !== 'pending' && current.status !== 'reviewed')
                    throw new Error('Staged source is unavailable');
                changed += this.#db.prepare("UPDATE companion_staged_sources SET status = 'reviewed', reviewed_at = ? WHERE companion_id = ? AND event_id = ? AND source_revision = ? AND status = 'pending'")
                    .run(now, cid, ref.eventId, ref.sourceRevision).changes;
            }
            return changed;
        }).immediate();
    }
    /** Returns whether state changed. Task changes invalidate plans through the shared epoch. */
    setTaskState(companionId, taskId, state) {
        const cid = identifier(companionId, 'companion ID');
        const tid = identifier(taskId, 'task ID');
        if (state !== 'active' && state !== 'completed')
            throw new Error('Invalid task state');
        return this.#db.transaction(() => {
            const current = this.#db.prepare('SELECT state FROM companion_tasks WHERE companion_id = ? AND task_id = ?').get(cid, tid);
            if (current === undefined)
                throw new Error('Unknown companion task');
            if (current.state === state)
                return false;
            this.#db.prepare('UPDATE companion_tasks SET state = ? WHERE companion_id = ? AND task_id = ?').run(state, cid, tid);
            this.#db.prepare('UPDATE companion_epochs SET state_epoch = state_epoch + 1 WHERE companion_id = ?').run(cid);
            return true;
        }).immediate();
    }
}
