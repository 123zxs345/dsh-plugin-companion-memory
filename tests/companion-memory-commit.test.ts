import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { SourceEvent } from '../src/contracts.ts';
import type { CompanionMemoryDraft, CompanionMemoryPlan, CompanionMemoryRevisionRef, CompanionSourceRef } from '../src/memory/companion-types.ts';
import { StateStore } from '../src/state/store.ts';
import { CURRENT_SCHEMA_VERSION } from '../src/state/migrations/index.ts';

const cid = 'companion';
const source = (id: string, extra: Partial<SourceEvent> = {}): SourceEvent => ({ id, companionId: cid, sessionId: 'session', role: 'user', content: 'I like tea.', occurredAt: '2026-10-28T00:00:00Z', visibility: 'private', ...extra });
const sr = (eventId: string, sourceRevision = 1): CompanionSourceRef => ({ eventId, sourceRevision });
const draft = (sourceRefs: CompanionSourceRef[], extra: Partial<CompanionMemoryDraft> = {}): CompanionMemoryDraft => ({ meaning: 'Likes tea.', anchors: ['tea'], view: 'user_understanding', certainty: 'explicit', reason: 'Stated by user.', useWhen: 'Choosing a drink.', avoidWhen: 'Irrelevant.', sourceRefs, parentRefs: [], ...extra });
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-commit-')); const path = join(dir, 'state.sqlite');
  const connections: { close(): void }[] = [];
  const open = () => { const store = new StateStore(path); connections.push(store); return store; };
  const sql = () => { const db = new Database(path); db.pragma('foreign_keys = ON'); connections.push(db); return db; };
  const store = open(); store.ensureCompanion({ id: cid, name: 'Mira', anchors: { identity: 'Mira' } });
  t.after(() => { for (const entry of connections) { if (!(entry instanceof Database) || entry.open) entry.close(); } rmSync(dir, { recursive: true, force: true }); });
  const plan = (operations: CompanionMemoryPlan['operations'], reviewedSources: CompanionSourceRef[] = []): CompanionMemoryPlan => ({ planId: randomUUID(), companionId: cid, expectedEpoch: store.currentEpoch(cid), reviewedSources, operations });
  const retain = (eventId: string, extra: Partial<CompanionMemoryDraft> = {}) => {
    store.stageEvent(source(eventId));
    return store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([sr(eventId)], extra) }], [sr(eventId)])).memories[0]!;
  };
  return { store, open, sql, path, plan, retain };
}

test('retains a service ID atomically with reviewed sources and state epoch only', t => {
  const { store, open, sql, plan } = fixture(t); const peer = open(); store.stageEvent(source('a'));
  const before = store.currentEpoch(cid); const watermark = sql().prepare('SELECT deletion_watermark FROM companion_epochs WHERE companion_id=?').get(cid);
  const result = store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([sr('a')]) }], [sr('a')]));
  assert.equal(result.status, 'applied'); assert.match(result.memories[0]!.memoryId, /^[0-9a-f-]{36}$/);
  assert.equal(result.memories[0]!.revision, 1); assert.equal(peer.currentEpoch(cid), before + 1); assert.deepEqual(sql().prepare('SELECT deletion_watermark FROM companion_epochs WHERE companion_id=?').get(cid), watermark);
  assert.deepEqual(peer.companionMemory.listPending(cid), []);
  const memory = peer.companionMemory.getMemory(cid, result.memories[0]!)!;
  assert.equal(memory.meaning, 'Likes tea.'); assert.equal(memory.pinned, false); assert.equal(memory.lastRetrievedAt, null);
  assert.deepEqual(peer.companionMemory.evidenceFor(cid, result.memories[0]!).map(e => [e.eventId, e.sourceRole]), [['a', 'user']]);
  const columns = (sql().pragma('table_info(companion_memory_plans)') as { name: string }[]).map(c => c.name);
  assert.ok(!columns.some(c => /body|prompt|meaning|hash|content/.test(c)));
  assert.equal(store.listProfile(cid).find(p => p.domain === 'persona')?.value, 'Mira');
});

test('replay rejects even a replaced body without creating another memory or revision', t => {
  const { store, plan } = fixture(t); store.stageEvent(source('a'));
  const p = plan([{ action: 'retain', draft: draft([sr('a')]) }], [sr('a')]); store.companionMemory.applyPlan(p);
  p.operations = [{ action: 'retain', draft: draft([sr('a')], { meaning: 'Changed replay.' }) }]; p.expectedEpoch = store.currentEpoch(cid);
  assert.throws(() => store.companionMemory.applyPlan(p), /already applied|replay/i);
  assert.equal(store.companionMemory.listMemories(cid, { includeHistory: true }).length, 1);
});

test('new interaction and concurrent domain commits fence stale plans', t => {
  const { store, open, plan, retain } = fixture(t); const a = retain('a'); const peer = open();
  const stale = plan([{ action: 'discard', target: a }]); peer.stageEvent(source('new'));
  assert.throws(() => store.companionMemory.applyPlan(stale), /epoch/i);
  const fresh = plan([{ action: 'deprioritize', target: a }]); peer.companionMemory.applyPlan(fresh);
  fresh.planId = randomUUID(); assert.throws(() => store.companionMemory.applyPlan(fresh), /epoch/i);
  assert.equal(store.companionMemory.getMemory(cid, a)?.status, 'deprioritized');
});

test('a pin from another connection fences an already-computed destructive plan', t => {
  const { store, open, retain, plan } = fixture(t); const a = retain('a'); const peer = open(); const p = plan([{ action: 'discard', target: a }]);
  peer.companionMemory.pinMemory(cid, a, true);
  assert.throws(() => store.companionMemory.applyPlan(p), /epoch/i); assert.equal(store.companionMemory.getMemory(cid, a)?.status, 'active');
});

test('a current revision from one companion cannot be a target or parent of another', t => {
  const { store, retain } = fixture(t); const a = retain('a'); store.ensureCompanion({ id: 'other', name: 'Other', anchors: {} });
  store.stageEvent(source('other-event', { companionId: 'other' }));
  for (const operation of [{ action: 'discard', target: a }, { action: 'retain', draft: draft([sr('other-event')], { parentRefs: [a] }) }] as CompanionMemoryPlan['operations']) assert.throws(() => store.companionMemory.applyPlan({ planId: randomUUID(), companionId: 'other', expectedEpoch: store.currentEpoch('other'), reviewedSources: [], operations: [operation] }), /memory|parent|revision/i);
  assert.equal(store.companionMemory.getMemory(cid, a)?.status, 'active');
});

test('merge consumes current refs into a new ID; condense creates same-ID revision with a DAG', t => {
  const { store, retain, plan } = fixture(t); const a = retain('a'); const b = retain('b');
  const merged = store.companionMemory.applyPlan(plan([{ action: 'merge', targets: [a, b], draft: draft([]) }])).memories[0]!;
  assert.notEqual(merged.memoryId, a.memoryId); assert.equal(store.companionMemory.getMemory(cid, a)?.status, 'historical');
  assert.equal(store.companionMemory.parentsFor(cid, merged).length, 2);
  assert.deepEqual(store.companionMemory.evidenceFor(cid, merged).map(e => e.eventId).sort(), ['a', 'b']);
  const next = store.companionMemory.applyPlan(plan([{ action: 'condense', target: merged, draft: draft([], { meaning: 'Tea preference.' }) }])).memories[0]!;
  assert.equal(next.memoryId, merged.memoryId); assert.equal(next.revision, 2);
  assert.equal(store.companionMemory.getMemory(cid, merged)?.status, 'condensed');
  assert.equal(store.companionMemory.getMemory(cid, next.memoryId)?.revision, 2);
  assert.equal(store.companionMemory.listMemories(cid).length, 1);
  assert.equal(store.companionMemory.listMemories(cid, { includeHistory: true }).length, 4);
  assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'condense', target: merged, draft: draft([]) }])), /current|revision/i);
});

test('a failed operation rolls back earlier memory writes, review, ledger and epoch across connections', t => {
  const { store, open, plan, sql } = fixture(t); const peer = open(); store.stageEvent(source('a'));
  const before = store.currentEpoch(cid); const p = plan([{ action: 'retain', draft: draft([sr('a')]) }, { action: 'discard', target: { memoryId: 'missing', revision: 1 } }], [sr('a')]);
  assert.throws(() => store.companionMemory.applyPlan(p), /memory|target|revision/i);
  assert.deepEqual(peer.companionMemory.listMemories(cid), []); assert.equal(peer.companionMemory.listPending(cid).length, 1); assert.equal(peer.currentEpoch(cid), before);
  assert.equal(sql().prepare('SELECT 1 FROM companion_memory_plans WHERE plan_id = ?').get(p.planId), undefined);
});

test('late SQL failures roll back the whole plan including review', t => {
  const { store, sql, plan } = fixture(t); store.stageEvent(source('a')); const before = store.currentEpoch(cid);
  sql().exec("CREATE TRIGGER reject_plan BEFORE INSERT ON companion_memory_plans BEGIN SELECT RAISE(ABORT, 'reject ledger'); END");
  assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([sr('a')]) }], [sr('a')])), /reject ledger/);
  assert.equal(store.companionMemory.listPending(cid).length, 1); assert.equal(store.companionMemory.listMemories(cid).length, 0); assert.equal(store.currentEpoch(cid), before);
});

test('defer leaves exact sources pending while reviewing the others', t => {
  const { store, plan } = fixture(t); store.stageEvent(source('a')); store.stageEvent(source('b'));
  store.companionMemory.applyPlan(plan([{ action: 'defer', sourceRefs: [sr('a')] }], [sr('a'), sr('b')]));
  assert.deepEqual(store.companionMemory.listPending(cid).map(p => p.event.id), ['a']);
  assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'defer', sourceRefs: [sr('b')] }], [sr('a')])), /defer|review/i);
});

test('an empty change plan atomically reviews sources with a replay fence and no memory writes', t => {
  const { store, open, plan, sql } = fixture(t); const peer = open(); store.stageEvent(source('a')); store.stageEvent(source('b'));
  const before = store.currentEpoch(cid); const p = plan([], [sr('a'), sr('b')]); const result = store.companionMemory.applyPlan(p);
  assert.deepEqual(result.memories, []); assert.equal(peer.currentEpoch(cid), before + 1); assert.deepEqual(peer.companionMemory.listPending(cid), []); assert.deepEqual(peer.companionMemory.listMemories(cid), []);
  const row = sql().prepare('SELECT source_refs_json,result_refs_json FROM companion_memory_plans WHERE plan_id=?').get(p.planId) as { source_refs_json: string; result_refs_json: string };
  assert.deepEqual(JSON.parse(row.source_refs_json), [sr('a'), sr('b')]); assert.deepEqual(JSON.parse(row.result_refs_json), []);
  assert.throws(() => peer.companionMemory.applyPlan({ ...p, expectedEpoch: peer.currentEpoch(cid) }), /already applied|replay/i);
  assert.throws(() => store.companionMemory.applyPlan(plan([])), /empty|review|operations/i);
});

test('an empty change plan still rejects an expired source without reviewing any part of the batch', t => {
  const { store, open, plan, sql } = fixture(t); const peer = open(); store.stageEvent(source('a')); store.stageEvent(source('expired'));
  sql().exec("UPDATE companion_staged_sources SET expires_at='2000-01-01T00:00:00Z' WHERE event_id='expired'");
  const before = store.currentEpoch(cid); const p = plan([], [sr('a'), sr('expired')]);
  assert.throws(() => store.companionMemory.applyPlan(p), /source|revision|available/i); assert.equal(peer.currentEpoch(cid), before);
  assert.equal((sql().prepare("SELECT status FROM companion_staged_sources WHERE event_id='a'").get() as { status: string }).status, 'pending');
  assert.equal(sql().prepare('SELECT 1 FROM companion_memory_plans WHERE plan_id=?').get(p.planId), undefined);
});

test('source revision, actual role and companion are checked in the database', t => {
  const { store, plan } = fixture(t); store.ensureCompanion({ id: 'other', name: 'Other', anchors: {} });
  store.stageEvent(source('assistant', { role: 'assistant' })); store.stageEvent(source('foreign', { companionId: 'other' })); store.stageEvent(source('user', { revision: 2 }));
  for (const d of [draft([sr('assistant')]), draft([sr('foreign')]), draft([sr('user')])]) assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'retain', draft: d }])), /source|user|revision/i);
  const ref = store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([sr('assistant')], { view: 'shared_episode' }) }])).memories[0]!;
  assert.equal(store.companionMemory.evidenceFor(cid, ref)[0]?.sourceRole, 'assistant');
});

test('inferred parents cannot become explicit through repeated summarization alone', t => {
  const { store, retain, plan } = fixture(t); const a = retain('a', { certainty: 'inferred' });
  assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([], { parentRefs: [a] }) }])), /inferred|explicit/i);
  const inferred = store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([], { certainty: 'inferred', parentRefs: [a] }) }])).memories[0]!;
  assert.deepEqual(store.companionMemory.evidenceFor(cid, inferred).map(e => e.eventId), ['a']);
});

test('relabeling an inferred parent source as direct does not manufacture new explicit evidence', t => {
  const { store, retain, plan } = fixture(t); const a = retain('a', { certainty: 'inferred' });
  assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([sr('a')], { parentRefs: [a] }) }])), /inferred|explicit|new source/i);
  store.stageEvent(source('confirmation'));
  const confirmed = store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([sr('confirmation')], { parentRefs: [a] }) }])).memories[0]!;
  assert.equal(store.companionMemory.getMemory(cid, confirmed)?.certainty, 'explicit');
});

test('foreign, missing, self and cyclic parent refs cannot be introduced', t => {
  const { store, retain, plan, sql } = fixture(t); const a = retain('a');
  for (const parentRefs of [[{ memoryId: 'foreign', revision: 1 }], [{ memoryId: a.memoryId, revision: 2 }]]) assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([], { parentRefs }) }])), /parent|memory|revision/i);
  const db = sql(); const b = retain('b');
  const link = db.prepare('INSERT INTO companion_memory_links VALUES (?, ?, ?, ?, ?)'); link.run(cid, a.memoryId, a.revision, b.memoryId, b.revision);
  assert.throws(() => link.run(cid, b.memoryId, b.revision, a.memoryId, a.revision), /acyclic/);
});

test('pin rejects every destructive model action but user erase wins', t => {
  const { store, retain, plan } = fixture(t); const a = retain('a'); const b = retain('b'); store.companionMemory.pinMemory(cid, a, true);
  for (const operation of [{ action: 'discard', target: a }, { action: 'deprioritize', target: a }, { action: 'condense', target: a, draft: draft([]) }, { action: 'merge', targets: [a, b], draft: draft([]) }] as CompanionMemoryPlan['operations']) assert.throws(() => store.companionMemory.applyPlan(plan([operation])), /pin/i);
  store.forgetEvent(cid, 'a'); assert.equal(store.companionMemory.getMemory(cid, a)?.meaning, ''); assert.equal(store.companionMemory.getMemory(cid, a)?.status, 'forgotten');
});

test('model discard and deprioritize keep the body without masquerading as source suppression', t => {
  const { store, retain, plan } = fixture(t); const a = retain('a'); const b = retain('b');
  store.companionMemory.applyPlan(plan([{ action: 'discard', target: a }, { action: 'deprioritize', target: b }]));
  assert.equal(store.companionMemory.getMemory(cid, a)?.meaning, 'Likes tea.'); assert.equal(store.companionMemory.getMemory(cid, a)?.status, 'discarded');
  assert.equal(store.companionMemory.getMemory(cid, b)?.status, 'deprioritized'); assert.equal(store.getEvent(cid, 'a')?.content, 'I like tea.');
});

test('suppression survives reopen, deactivates all derived versions, and later erase purges every body copy', t => {
  const { store, retain, plan, open, sql } = fixture(t); const secret = 'CANARY_PRIVATE_7c2e'; const a = retain('a', { meaning: secret, anchors: [secret], reason: secret, useWhen: secret, avoidWhen: secret }); const independent = retain('safe', { meaning: 'independent' });
  const b = store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([], { parentRefs: [a], meaning: secret, reason: secret }) }])).memories[0]!;
  const c = store.companionMemory.applyPlan(plan([{ action: 'condense', target: b, draft: draft([], { meaning: secret, anchors: [secret] }) }])).memories[0]!;
  const location = store.companionMemory.registerIndexLocation(cid, { bank: 'bank', bankKind: 'companion', documentId: 'doc', operationId: 'op', memory: c });
  store.forgetEvents(cid, ['a'], 'suppress'); store.close(); const reopened = open();
  assert.equal(reopened.companionMemory.getMemory(cid, a)?.meaning, secret); assert.equal(reopened.companionMemory.getMemory(cid, c)?.status, 'discarded');
  assert.equal(reopened.companionMemory.getIndexLocation(cid, location.id)?.cleanupState, 'not-requested');
  const stale: CompanionMemoryPlan = { planId: randomUUID(), companionId: cid, reviewedSources: [], operations: [{ action: 'retain', draft: draft([], { parentRefs: [a] }) }], expectedEpoch: reopened.currentEpoch(cid) };
  assert.throws(() => reopened.companionMemory.applyPlan(stale), /source|parent|available/i);
  reopened.forgetEvent(cid, 'a');
  assert.equal(reopened.companionMemory.getMemory(cid, independent)?.meaning, 'independent');
  assert.equal(reopened.companionMemory.getIndexLocation(cid, location.id)?.cleanupState, 'pending');
  const db = sql();
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) {
    const rows = db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all(); assert.ok(!JSON.stringify(rows).includes(secret), name);
  }
  assert.throws(() => reopened.companionMemory.applyPlan({ ...stale, planId: randomUUID(), expectedEpoch: reopened.currentEpoch(cid) }), /source|parent|available/i);
});

test('mixed-source summary is deactivated wholesale and cannot recall from an old parent', t => {
  const { store, retain, plan } = fixture(t); const a = retain('a'); const b = retain('b');
  const merged = store.companionMemory.applyPlan(plan([{ action: 'merge', targets: [a, b], draft: draft([]) }])).memories[0]!;
  store.forgetEvent(cid, 'a'); assert.equal(store.companionMemory.getMemory(cid, merged)?.status, 'forgotten');
  assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([], { parentRefs: [merged] }) }])), /parent|source|available/i);
  const rebuilt = store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([sr('b')]) }])).memories[0]!;
  assert.equal(store.companionMemory.getMemory(cid, rebuilt)?.status, 'active');
});

test('retrieval and presentation update only exact revisions and never the epoch or usefulness', t => {
  const { store, retain, plan } = fixture(t); const a = retain('a'); const b = store.companionMemory.applyPlan(plan([{ action: 'condense', target: a, draft: draft([]) }])).memories[0]!;
  const before = store.currentEpoch(cid); store.companionMemory.recordRetrieved(cid, [a]); store.companionMemory.recordPresented(cid, [b]);
  assert.ok(store.companionMemory.getMemory(cid, a)?.lastRetrievedAt); assert.equal(store.companionMemory.getMemory(cid, a)?.lastPresentedAt, null);
  assert.equal(store.companionMemory.getMemory(cid, b)?.lastRetrievedAt, null); assert.ok(store.companionMemory.getMemory(cid, b)?.lastPresentedAt); assert.equal(store.currentEpoch(cid), before);
  assert.throws(() => store.companionMemory.recordPresented(cid, [b, { memoryId: 'missing', revision: 1 }]), /memory|revision/i);
});

test('detail cleanup checks shared tasks, pins, every memory use and profile evidence', t => {
  const { store, plan, sql } = fixture(t); store.stageEvent(source('both'), { purpose: 'task', taskId: 'work' });
  const a = store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([sr('both')]) }], [sr('both')])).memories[0]!;
  store.companionMemory.setDetailState(cid, a, 'cold');
  assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('both')).eligible, false);
  store.companionMemory.setTaskState(cid, 'work', 'completed'); assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('both')).eligible, true);
  store.companionMemory.pinMemory(cid, a, true); assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('both')).eligible, false); store.companionMemory.pinMemory(cid, a, false);
  const b = store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([sr('both')]) }])).memories[0]!;
  assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('both')).eligible, false); store.companionMemory.setDetailState(cid, b, 'cold');
  store.companionMemory.linkTaskSource(cid, 'another', sr('both'));
  assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('both')).eligible, false); store.companionMemory.setTaskState(cid, 'another', 'completed');
  assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('both')).eligible, true);
  const db = sql();
  const anchor = db.prepare("SELECT id FROM profile_fact_versions WHERE companion_id=? AND domain='persona'").get(cid) as { id: string };
  db.prepare("INSERT INTO profile_evidence(fact_version_id,event_id,source_revision,quote) VALUES (?, 'both', 1, 'quote')").run(anchor.id);
  assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('both')).eligible, false);
  assert.equal(store.getEvent(cid, 'both')?.content, 'I like tea.', 'check never physically clears raw text');
});

test('an unreviewed profile proposal keeps its source details even after its expiry date', t => {
  const { store, retain, sql } = fixture(t); const a = retain('a'); store.companionMemory.setDetailState(cid, a, 'cold');
  assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('a')).eligible, true);
  const proposal = store.proposeCandidate(cid, { domain: 'user', key: 'drink', value: 'tea', certainty: 'explicit', evidence: [{ kind: 'quote', eventId: ' a ', sourceRevision: 1, quote: 'like tea' }], reason: 'Needs review.' });
  sql().prepare("UPDATE profile_candidates SET expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(proposal.id);
  const check = store.companionMemory.checkDetailCleanup(cid, sr('a')); assert.equal(check.eligible, false); assert.ok(check.blockers.includes('profile-candidate'));
  sql().prepare("UPDATE profile_candidates SET status='expired' WHERE id=?").run(proposal.id); assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('a')).eligible, true);
});

test('pending profile dependency metadata still blocks details when the proposal quote list is absent', t => {
  const { store, retain, sql } = fixture(t); const a = retain('a'); store.companionMemory.setDetailState(cid, a, 'cold');
  const proposal = store.proposeCandidate(cid, { domain: 'user', key: 'drink', value: 'tea', certainty: 'explicit', evidence: [{ kind: 'quote', eventId: 'a', sourceRevision: 1, quote: 'like tea' }], reason: 'Needs review.' });
  sql().prepare("UPDATE profile_candidates SET evidence_json='[]' WHERE id=?").run(proposal.id);
  sql().prepare("INSERT INTO derived_dependencies(derived_kind,derived_id,source_id,source_revision) VALUES ('profile_candidate',?,'a',1)").run(proposal.id);
  assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('a')).eligible, false);
});

test('malformed pending proposal evidence conservatively blocks same-companion detail cleanup without exposing text', t => {
  const { store, retain, sql } = fixture(t); const a = retain('a'); const unrelated = retain('unrelated'); store.companionMemory.setDetailState(cid, a, 'cold'); store.companionMemory.setDetailState(cid, unrelated, 'cold');
  const proposal = store.proposeCandidate(cid, { domain: 'user', key: 'drink', value: 'tea', certainty: 'explicit', evidence: [{ kind: 'quote', eventId: 'unrelated', sourceRevision: 1, quote: 'like tea' }], reason: 'Needs review.' });
  assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('a')).eligible, true, 'valid unrelated quote is isolated');
  const corrupt = 'MALFORMED_PRIVATE_CANARY';
  for (const evidence of [corrupt, '{}', '[null]']) {
    sql().prepare('UPDATE profile_candidates SET evidence_json=? WHERE id=?').run(evidence, proposal.id);
    const check = store.companionMemory.checkDetailCleanup(cid, sr('a')); assert.equal(check.eligible, false); assert.ok(!JSON.stringify(check).includes(corrupt));
  }
});

test('other-companion pending proposal evidence does not block local detail cleanup', t => {
  const { store, retain, sql } = fixture(t); const a = retain('a'); store.companionMemory.setDetailState(cid, a, 'cold');
  store.ensureCompanion({ id: 'other', name: 'Other', anchors: {} }); store.stageEvent(source('a', { companionId: 'other' }));
  const proposal = store.proposeCandidate('other', { domain: 'user', key: 'drink', value: 'tea', certainty: 'explicit', evidence: [{ kind: 'quote', eventId: 'a', sourceRevision: 1, quote: 'like tea' }], reason: 'Needs review.' });
  sql().prepare("UPDATE profile_candidates SET evidence_json='bad-json' WHERE id=?").run(proposal.id);
  assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('a')).eligible, true);
});

test('real same-revision task links are atomic, idempotent and never revive completed work', t => {
  const { store, open, plan, sql } = fixture(t); const peer = open(); store.stageEvent(source('both'), { purpose: 'task', taskId: 'first' });
  store.companionMemory.applyPlan(plan([{ action: 'defer', sourceRefs: [sr('both')] }], [sr('both')])); store.companionMemory.markReviewed(cid, [sr('both')]);
  const before = store.currentEpoch(cid); assert.equal(store.companionMemory.linkTaskSource(cid, 'second', sr('both')), true);
  assert.equal(peer.currentEpoch(cid), before + 1); assert.equal(peer.companionMemory.linkTaskSource(cid, 'second', sr('both')), false); assert.equal(peer.currentEpoch(cid), before + 1);
  store.companionMemory.setTaskState(cid, 'first', 'completed'); assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('both')).eligible, false);
  store.companionMemory.setTaskState(cid, 'second', 'completed'); assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('both')).eligible, true);
  assert.equal(store.companionMemory.linkTaskSource(cid, 'second', sr('both')), false); assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('both')).eligible, true);
  assert.throws(() => store.companionMemory.linkTaskSource(cid, 'bad', sr('both', 9)), /source|revision/i);
  assert.equal(sql().prepare("SELECT 1 FROM companion_tasks WHERE task_id='bad'").get(), undefined);
  assert.equal((sql().prepare("SELECT COUNT(*) n FROM companion_task_sources WHERE event_id='both' AND source_revision=1").get() as { n: number }).n, 2);
});

test('the plan ledger records changed target refs as metadata without storing content', t => {
  const { store, retain, plan, sql } = fixture(t); const a = retain('a'); const p = plan([{ action: 'discard', target: a }]); store.companionMemory.applyPlan(p);
  const row = sql().prepare('SELECT result_refs_json FROM companion_memory_plans WHERE plan_id=?').get(p.planId) as { result_refs_json: string };
  assert.deepEqual(JSON.parse(row.result_refs_json), [a]);
});

test('source suppression does not grant model-discard cleanup permission', t => {
  const { store, retain, plan } = fixture(t); const discarded = retain('discarded'); store.companionMemory.applyPlan(plan([{ action: 'discard', target: discarded }]));
  assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('discarded')).eligible, true);
  const suppressed = retain('suppressed'); store.companionMemory.setDetailState(cid, suppressed, 'cold'); store.forgetEvents(cid, ['suppressed'], 'suppress');
  assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('suppressed')).eligible, false);
});

test('suppression of one mixed-summary source never grants cleanup of its other source', t => {
  const { store, retain, plan } = fixture(t); const a = retain('a'); const b = retain('b');
  const merged = store.companionMemory.applyPlan(plan([{ action: 'merge', targets: [a, b], draft: draft([]) }])).memories[0]!;
  for (const ref of [a, b, merged]) store.companionMemory.setDetailState(cid, ref, 'cold');
  store.forgetEvents(cid, ['a'], 'suppress');
  assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('b')).eligible, false);
});

test('a plan cannot create a child and discard its required parent in the same batch', t => {
  const { store, retain, plan } = fixture(t); const a = retain('a'); const before = store.currentEpoch(cid);
  assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([], { parentRefs: [a] }) }, { action: 'discard', target: a }])), /parent|available/i);
  assert.equal(store.companionMemory.getMemory(cid, a)?.status, 'active'); assert.equal(store.currentEpoch(cid), before);
});

test('discard refuses a parent with existing active descendants across batches without altering the children', t => {
  const { store, open, retain, plan } = fixture(t); const peer = open(); const a = retain('a');
  const child = store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([], { parentRefs: [a] }) }])).memories[0]!;
  const grandchild = store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([], { parentRefs: [child] }) }])).memories[0]!;
  store.companionMemory.applyPlan(plan([{ action: 'deprioritize', target: child }])); const before = store.currentEpoch(cid);
  assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'discard', target: a }])), /depend|descendant|parent/i);
  assert.equal(peer.currentEpoch(cid), before); assert.equal(peer.companionMemory.getMemory(cid, a)?.status, 'active'); assert.equal(peer.companionMemory.getMemory(cid, child)?.status, 'deprioritized'); assert.equal(peer.companionMemory.getMemory(cid, grandchild)?.status, 'active');
  const revised = store.companionMemory.applyPlan(plan([{ action: 'condense', target: grandchild, draft: draft([]) }])).memories[0]!; assert.equal(revised.revision, 2, 'rejected discard leaves descendant operations usable');
});

test('a plan can explicitly discard a parent and every active descendant without an implicit cascade', t => {
  const { store, retain, plan } = fixture(t); const a = retain('a'); const unrelated = retain('unrelated');
  const child = store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([], { parentRefs: [a] }) }])).memories[0]!;
  const grandchild = store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([], { parentRefs: [child] }) }])).memories[0]!;
  const partial = plan([{ action: 'discard', target: a }, { action: 'discard', target: child }]);
  assert.throws(() => store.companionMemory.applyPlan(partial), /depend|descendant|parent/i);
  store.companionMemory.applyPlan(plan([{ action: 'discard', target: a }, { action: 'discard', target: child }, { action: 'discard', target: grandchild }]));
  for (const ref of [a, child, grandchild]) { assert.equal(store.companionMemory.getMemory(cid, ref)?.status, 'discarded'); assert.equal(store.companionMemory.getMemory(cid, ref)?.meaning, 'Likes tea.'); }
  assert.equal(store.companionMemory.getMemory(cid, unrelated)?.status, 'active');
});

test('model discard starts a fresh cold window without erasing details while source suppression does not', t => {
  const { store, retain, plan, sql } = fixture(t); const a = retain('a'); store.companionMemory.setDetailState(cid, a, 'cold');
  sql().prepare("UPDATE companion_memories SET detail_cold_since='2000-01-01T00:00:00Z' WHERE id=?").run(a.memoryId);
  const started = Date.now(); store.companionMemory.applyPlan(plan([{ action: 'discard', target: a }])); const discarded = store.companionMemory.getMemory(cid, a)!;
  assert.equal(discarded.detailState, 'cold'); assert.ok(Date.parse(discarded.detailColdSince!) >= started); assert.equal(discarded.detailsUnavailable, false); assert.equal(discarded.meaning, 'Likes tea.'); assert.equal(store.getEvent(cid, 'a')?.content, 'I like tea.');
  const b = retain('b'); store.forgetEvents(cid, ['b'], 'suppress'); const suppressed = store.companionMemory.getMemory(cid, b)!;
  assert.equal(suppressed.status, 'discarded'); assert.equal(suppressed.detailState, 'required'); assert.equal(suppressed.detailColdSince, null); assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('b')).eligible, false);
});

test('source eligibility is rechecked after snapshot for metadata, expiry and receipt revocation', t => {
  const { store, plan, sql } = fixture(t); const db = sql();
  for (const [id, statement] of [['revision', "UPDATE event_metadata SET revision=2 WHERE event_id='revision'"], ['temporary', "UPDATE event_metadata SET learning='temporary' WHERE event_id='temporary'"], ['roleplay', "UPDATE event_metadata SET mode='roleplay' WHERE event_id='roleplay'"], ['expired', "UPDATE companion_staged_sources SET expires_at='2000-01-01T00:00:00Z' WHERE event_id='expired'"]]) {
    store.stageEvent(source(id!)); const p = plan([{ action: 'retain', draft: draft([sr(id!)]) }]); db.exec(statement!);
    assert.throws(() => store.companionMemory.applyPlan(p), /source|revision/i);
  }
  store.registerToolReceipt({ id: 'receipt', companionId: cid, state: 'completed', checkedAt: '2026-10-28T00:00:00Z' });
  store.stageEvent(source('tool', { role: 'tool', toolVerified: true, origin: 'verified-tool', toolReceiptId: 'receipt' }));
  const p = plan([{ action: 'retain', draft: draft([sr('tool')], { view: 'shared_episode' }) }]);
  db.exec("UPDATE tool_receipts SET state='failed' WHERE id='receipt'"); assert.throws(() => store.companionMemory.applyPlan(p), /source/i);
});

test('source supersession in the existing profile transaction deactivates companion descendants', t => {
  const { store, retain, plan } = fixture(t); const a = retain('old');
  store.applyProfileChange(cid, { domain: 'user', key: 'drink', value: 'tea', certainty: 'explicit', evidenceEventId: 'old', evidenceQuote: 'like tea', reason: 'stated', expectedVersion: 0 });
  const child = store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([], { parentRefs: [a] }) }])).memories[0]!;
  store.ingest(source('new', { content: 'I prefer coffee.' }));
  store.applyProfileChange(cid, { domain: 'user', key: 'drink', value: 'coffee', certainty: 'explicit', evidenceEventId: 'new', evidenceQuote: 'prefer coffee', reason: 'changed', expectedVersion: 1 });
  assert.equal(store.companionMemory.getMemory(cid, a)?.status, 'discarded'); assert.equal(store.companionMemory.getMemory(cid, child)?.status, 'discarded');
  assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([], { parentRefs: [a] }) }])), /source|parent|available/i);
});

test('condense sets cold metadata on both revisions without claiming physical detail erasure', t => {
  const { store, retain, plan } = fixture(t); const a = retain('a');
  const b = store.companionMemory.applyPlan(plan([{ action: 'condense', target: a, draft: draft([]) }])).memories[0]!;
  for (const ref of [a, b]) { const row = store.companionMemory.getMemory(cid, ref)!; assert.equal(row.detailState, 'cold'); assert.ok(row.detailColdSince); assert.equal(row.detailsUnavailable, false); }
  assert.equal(store.companionMemory.checkDetailCleanup(cid, sr('a')).eligible, true);
  assert.equal(store.getEvent(cid, 'a')?.content, 'I like tea.');
});

test('forgotten sources reject late bodies and late location registration enters cleanup', t => {
  const { store, retain, plan, sql } = fixture(t); const a = retain('a'); store.forgetEvent(cid, 'a');
  const canary = 'LATE_PRIVATE_CANARY';
  assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft([sr('a')], { meaning: canary, reason: canary }) }])), /source/i);
  const location = store.companionMemory.registerIndexLocation(cid, { bank: 'bank', bankKind: 'companion', documentId: 'late', memory: a });
  assert.equal(location.cleanupState, 'pending');
  for (const { name } of sql().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) assert.ok(!JSON.stringify(sql().prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()).includes(canary), name);
});

test('index routing handles validate XOR, operation uniqueness, scoped refs and historical revisions', t => {
  const { store, retain, plan } = fixture(t); const a = retain('a'); const b = store.companionMemory.applyPlan(plan([{ action: 'condense', target: a, draft: draft([]) }])).memories[0]!;
  const base = { bank: 'opaque-bank', bankKind: 'legacy' as const, documentId: 'legacy-doc', operationId: 'op', source: sr('a') };
  const first = store.companionMemory.registerIndexLocation(cid, base); assert.notEqual(first.id, base.documentId);
  const old = store.companionMemory.registerIndexLocation(cid, { bank: 'material', bankKind: 'companion', documentId: 'old', memory: a });
  store.companionMemory.registerIndexLocation(cid, { bank: 'material', bankKind: 'companion', documentId: 'new', memory: b });
  assert.equal(store.companionMemory.indexLocationsForSource(cid, sr('a')).length, 3);
  assert.deepEqual(store.companionMemory.getIndexLocation(cid, old.id)?.memory, a);
  for (const input of [{ ...base, documentId: 'other' }, { ...base, operationId: null, documentId: 'xor', memory: a }, { bank: 'b', bankKind: 'legacy', documentId: 'none' }, { ...base, documentId: 'bad-rev', operationId: null, source: sr('a', 999) }]) assert.throws(() => store.companionMemory.registerIndexLocation(cid, input as Parameters<typeof store.companionMemory.registerIndexLocation>[1]), /UNIQUE|reference|source|revision|XOR|exactly/i);
  store.ensureCompanion({ id: 'other', name: 'Other', anchors: {} }); assert.equal(store.companionMemory.getIndexLocation('other', first.id), null);
  assert.throws(() => store.companionMemory.registerIndexLocation('other', { ...base, operationId: null }), /source|revision/i);
});

test('runtime boundaries reject content controls and invalid arrays before any write', t => {
  const { store, plan } = fixture(t); store.stageEvent(source('a'));
  for (const extra of [{ pinned: true }, { scope: 'global' }, { persona: 'other' }, { memoryId: 'model-id' }, { meaning: '' }, { anchors: Array(101).fill('a') }]) assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'retain', draft: { ...draft([sr('a')]), ...extra } } as CompanionMemoryPlan['operations'][number]])), /field|Invalid|length|anchor|draft/i);
  assert.equal(store.companionMemory.listMemories(cid).length, 0);
  for (const limit of [0, 1001, 1.5]) assert.throws(() => store.companionMemory.listMemories(cid, { limit }), /limit/i);
});

test('a real v6 database upgrades detail metadata and a ledger without retaining its snapshot', t => {
  const { store, sql, open, path, retain } = fixture(t); const a = retain('a'); const erased = retain('erased'); store.forgetEvent(cid, 'erased'); store.stageEvent(source('task'), { purpose: 'task', taskId: 'work' }); store.close(); const db = sql();
  db.exec('DROP TABLE companion_task_sources; DROP TABLE companion_memory_plans; ALTER TABLE companion_memories DROP COLUMN detail_state; ALTER TABLE companion_memories DROP COLUMN detail_cold_since; ALTER TABLE companion_memories DROP COLUMN summary; PRAGMA user_version=6');
  const upgraded = open(); assert.equal(sql().pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION); assert.equal(existsSync(path + '.v6.snapshot'), false);
  assert.equal(upgraded.companionMemory.getMemory(cid, a)?.detailState, 'required'); assert.equal(upgraded.companionMemory.getMemory(cid, a)?.detailColdSince, null);
  assert.equal(upgraded.companionMemory.getMemory(cid, erased)?.detailState, 'unavailable');
  assert.ok(sql().prepare("SELECT 1 FROM companion_task_sources WHERE task_id='work' AND event_id='task' AND source_revision=1").get());
});

test('source invalidation failures roll event text, memories and epoch back together', t => {
  const { store, open, retain, sql } = fixture(t); const a = retain('a'); const peer = open(); const before = store.currentEpoch(cid);
  sql().exec("CREATE TRIGGER reject_erase BEFORE UPDATE ON companion_memories BEGIN SELECT RAISE(ABORT, 'reject memory invalidation'); END");
  assert.throws(() => store.forgetEvent(cid, 'a'), /reject memory invalidation/);
  assert.equal(peer.getEvent(cid, 'a')?.content, 'I like tea.'); assert.equal(peer.companionMemory.getMemory(cid, a)?.meaning, 'Likes tea.'); assert.equal(peer.currentEpoch(cid), before);
});

test('a conflicting v7 ledger view rolls back every v6 metadata change and retains recovery snapshot', t => {
  const { store, sql, open, path } = fixture(t); store.close(); const db = sql();
  db.exec('DROP TABLE companion_memory_plans; ALTER TABLE companion_memories DROP COLUMN detail_state; ALTER TABLE companion_memories DROP COLUMN detail_cold_since; CREATE VIEW companion_memory_plans AS SELECT id FROM events; PRAGMA user_version=6');
  assert.throws(() => open(), /view|ledger|table/i); assert.equal(sql().pragma('user_version', { simple: true }), 6);
  assert.ok(!(sql().pragma('table_info(companion_memories)') as { name: string }[]).some(c => c.name === 'detail_state'));
  assert.equal(existsSync(path + '.v6.snapshot'), true);
});
