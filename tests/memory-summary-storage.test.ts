import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { StateStore } from '../src/state/store.ts';
import { CURRENT_SCHEMA_VERSION } from '../src/state/migrations/index.ts';
import type { CompanionMemoryDraft, CompanionMemoryPlan } from '../src/memory/companion-types.ts';

const cid = 'summary-companion';
const draft = (eventId: string, summary?: string): CompanionMemoryDraft => ({ meaning: 'REFINED meaning', anchors: ['EXACT anchor'], view: 'shared_episode', certainty: 'explicit', reason: 'Detailed reason', useWhen: 'Detailed use', avoidWhen: 'Detailed avoid', sourceRefs: [{ eventId, sourceRevision: 1 }], parentRefs: [], ...(summary === undefined ? {} : { summary }) });
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'summary-storage-')); const path = join(dir, 'state.sqlite');
  const handles: {close(): void}[] = []; const open = () => { const s = new StateStore(path); handles.push(s); return s; };
  const store = open(); store.ensureCompanion({ id: cid, name: 'Mira', anchors: {} });
  const sql = () => { const d = new Database(path); handles.push(d); return d; };
  t.after(() => { for (const h of handles) if (!(h instanceof Database) || h.open) h.close(); rmSync(dir, { recursive: true, force: true }); });
  const plan = (operations: CompanionMemoryPlan['operations']): CompanionMemoryPlan => ({ planId: randomUUID(), companionId: cid, expectedEpoch: store.currentEpoch(cid), reviewedSources: [], operations });
  const retain = (eventId: string, summary?: string) => {
    store.stageEvent({ id: eventId, companionId: cid, sessionId: 's', role: 'user', visibility: 'private', content: 'RAW secret ' + eventId, occurredAt: '2026-11-01T00:00:00Z' });
    return store.companionMemory.applyPlan(plan([{ action: 'retain', draft: draft(eventId, summary) }])).memories[0]!;
  };
  return { store, open, sql, plan, retain };
}

test('missing summaries persist null and cannot enter the material index', t => {
  const { store, retain } = fixture(t); const ref = retain('legacy');
  assert.equal(store.companionMemory.getMemory(cid, ref)?.summary, null);
  assert.equal(store.companionMemory.materialSnapshot(cid, ref)?.content, '');
  assert.deepEqual(store.companionMemory.indexableMemoryRefs(cid), []);
  assert.equal(store.prepareMaterialOperation(cid, ref, 'bank', 'doc', () => 'operation'), null);
  assert.deepEqual(store.companionMemory.listMemoriesWithoutSummary(cid).map(m => m.memoryId), [ref.memoryId]);
});

test('material content and hash cover only the model summary', t => {
  const { store, retain } = fixture(t); const ref = retain('a', 'Model summary.');
  const snapshot = store.companionMemory.materialSnapshot(cid, ref)!;
  assert.equal(snapshot.content, 'Model summary.');
  assert.equal(snapshot.payloadHash, createHash('sha256').update('Model summary.').digest('hex'));
  assert.deepEqual(store.companionMemory.indexableMemoryRefs(cid), [ref]);
  const op = store.prepareMaterialOperation(cid, ref, 'bank', 'doc', () => 'operation')!;
  assert.equal(store.materialOperationSnapshot(cid, op.operationId)?.content, 'Model summary.');
  assert.deepEqual(store.companionMemory.listMemoriesWithoutSummary(cid), []);
});

test('summarize fills pinned current memory without rewriting its revision or evidence', t => {
  const { store, retain, plan, open } = fixture(t); const ref = retain('a'); store.companionMemory.pinMemory(cid, ref, true);
  const before = store.companionMemory.getMemory(cid, ref)!; const evidence = store.companionMemory.evidenceFor(cid, ref); const epoch = store.currentEpoch(cid);
  const result = store.companionMemory.applyPlan(plan([{ action: 'summarize', target: ref, summary: 'Short summary.' }]));
  assert.deepEqual(result.memories, []); assert.equal(result.stateEpoch, epoch + 1);
  assert.deepEqual(open().companionMemory.getMemory(cid, ref), { ...before, summary: 'Short summary.' });
  assert.deepEqual(store.companionMemory.evidenceFor(cid, ref), evidence);
  assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'summarize', target: ref, summary: 'Overwrite.' }])), /summary/i);
  assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'discard', target: ref }])), /pinned/i);
});

test('summary fill is atomic, bounded and rejects conflicting targets or invalid evidence', t => {
  const { store, retain, plan } = fixture(t); const ref = retain('a');
  for (const summary of ['', ' ', 'x'.repeat(321)]) assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'summarize', target: ref, summary }])), /summary/i);
  assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'summarize', target: ref, summary: 'Short.' }, { action: 'discard', target: ref }])), /duplicate|target/i);
  assert.equal(store.companionMemory.getMemory(cid, ref)?.summary, null);
  const next = store.companionMemory.applyPlan(plan([{ action: 'condense', target: ref, draft: { ...draft('a'), sourceRefs: [] } }])).memories[0]!;
  assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'summarize', target: ref, summary: 'Stale.' }])), /current/i);
  store.forgetEvents(cid, ['a'], 'erase');
  assert.throws(() => store.companionMemory.applyPlan(plan([{ action: 'summarize', target: next, summary: 'Forgotten.' }])), /current|unavailable/i);
});

test('forget erases summaries and refined contents across revisions and descendants', t => {
  const { store, retain, plan } = fixture(t); const ref = retain('a', 'Old summary.');
  const next = store.companionMemory.applyPlan(plan([{ action: 'condense', target: ref, draft: { ...draft('a', 'New summary.'), sourceRefs: [] } }])).memories[0]!;
  store.forgetEvents(cid, ['a'], 'erase');
  for (const r of [ref, next]) { const m = store.companionMemory.getMemory(cid, r)!; assert.equal(m.summary, null); assert.equal(m.meaning, ''); assert.deepEqual(m.anchors, []); }
});

test('a correction without a model summary never reuses the previous revision summary', t => {
  const { store, retain, plan } = fixture(t); const ref = retain('a', 'Previous summary.');
  const corrected = store.companionMemory.applyPlan(plan([{ action: 'condense', target: ref, draft: { ...draft('a'), meaning: 'Corrected meaning', sourceRefs: [] } }])).memories[0]!;
  assert.equal(store.companionMemory.getMemory(cid, corrected)?.summary, null);
  assert.equal(store.companionMemory.getMemory(cid, ref)?.summary, 'Previous summary.');
  assert.deepEqual(store.companionMemory.indexableMemoryRefs(cid), []);
  assert.deepEqual(store.companionMemory.listMemoriesWithoutSummary(cid).map(m => m.memoryId), [corrected.memoryId]);
});

test('v8 migration adds null summary without rewriting memory or evidence', t => {
  const { store, retain, sql, open } = fixture(t); const ref = retain('old'); store.close(); const db = sql();
  // Simulate the actual v8 table while preserving its rows and all provenance tables.
  if ((db.pragma('table_info(companion_memories)') as {name:string}[]).some(c => c.name === 'summary')) db.exec('ALTER TABLE companion_memories DROP COLUMN summary');
  db.pragma('user_version = 8'); const memoryBefore = db.prepare('SELECT * FROM companion_memories').all();
  const evidenceBefore = db.prepare('SELECT * FROM companion_memory_evidence').all(); db.close();
  const upgraded = open(); assert.equal(CURRENT_SCHEMA_VERSION, 9); assert.equal(upgraded.companionMemory.getMemory(cid, ref)?.summary, null);
  assert.deepEqual(sql().prepare('SELECT * FROM companion_memories').all().map((row: any) => { const {summary, ...rest} = row; assert.equal(summary, null); return rest; }), memoryBefore);
  assert.deepEqual(sql().prepare('SELECT * FROM companion_memory_evidence').all(), evidenceBefore);
});
