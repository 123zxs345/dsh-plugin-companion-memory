import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { StateStore } from '../src/state/store.ts';
import type { CompanionMemoryDraft, CompanionMemoryOperation } from '../src/memory/companion-types.ts';

const cid = 'disclosure';
const draft = (ids: string[]): CompanionMemoryDraft => ({ summary: 'Short model summary.', meaning: 'REFINED full meaning', anchors: ['EXACT anchor'], view: 'shared_episode', certainty: 'explicit', reason: 'Detailed reason', useWhen: 'Detailed use', avoidWhen: 'Detailed avoid', sourceRefs: ids.map(eventId => ({eventId, sourceRevision: 1})), parentRefs: [] });
function fixture(t: test.TestContext, count = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'memory-disclosure-')); const path = join(directory, 'state.sqlite'); const store = new StateStore(path);
  store.ensureCompanion({id: cid, name: 'Mira', anchors: {}}); const ids = Array.from({length: count}, (_, i) => 'source-' + i);
  for (const id of ids) store.stageEvent({id, companionId: cid, sessionId: 's', role: 'user', visibility: 'private', content: 'RAW secret ' + id, occurredAt: '2026-11-01T00:00:00Z'});
  const apply = (operations: CompanionMemoryOperation[], reviewed = false) => store.companionMemory.applyPlan({planId: randomUUID(), companionId: cid, expectedEpoch: store.currentEpoch(cid), reviewedSources: reviewed ? ids.map(eventId => ({eventId, sourceRevision: 1})) : [], operations});
  const ref = apply([{action: 'retain', draft: draft(ids)}], true).memories[0]!;
  t.after(() => {store.close(); rmSync(directory, {recursive: true, force: true});});
  return {store, ref, ids, apply, path};
}
async function disclosure() {
  assert.ok(existsSync(new URL('../src/memory/disclosure.ts', import.meta.url)), 'disclosure API must exist');
  return import('../src/memory/disclosure.ts');
}

test('summary projection exposes only summaries and handles within bounded capacity', async t => {
  const {store, ref} = fixture(t); const {memorySummaryItems} = await disclosure(); const memory = store.companionMemory.getMemory(cid, ref)!;
  const projected = memorySummaryItems([memory], 1000);
  assert.deepEqual(projected, [{memoryId: ref.memoryId, revision: 1, summary: 'Short model summary.', availableLayers: ['refined', 'raw']}]);
  assert.doesNotMatch(JSON.stringify(projected), /REFINED|EXACT|RAW|reason|source-|useWhen|certainty/);
  assert.deepEqual(memorySummaryItems([{...memory, summary: null}], 1000), []);
  assert.deepEqual(memorySummaryItems([memory], 1), []);
  assert.equal(memorySummaryItems(Array.from({length: 30}, (_, i) => ({...memory, memoryId: String(i)})), 10000, 100).length, 24);
  assert.equal(memorySummaryItems([memory, memory], 10000).length, 1);
});

test('refined read revalidates identity and exposes no source text', async t => {
  const {store, ref} = fixture(t); const {readCompanionMemory} = await disclosure();
  const result = readCompanionMemory({store, companionId: cid, reference: ref, level: 'refined'});
  assert.equal(result.level, 'refined'); if (result.level !== 'refined') return;
  assert.equal(result.meaning, 'REFINED full meaning'); assert.deepEqual(result.anchors, ['EXACT anchor']);
  assert.deepEqual(result.sourceRefs, [{eventId: 'source-0', sourceRevision: 1}]); assert.doesNotMatch(JSON.stringify(result), /RAW secret|content/);
  assert.throws(() => readCompanionMemory({store, companionId: 'other', reference: ref, level: 'refined'}), /unavailable|current|unknown/i);
});

test('raw reads page four complete original sources without silent truncation', async t => {
  const {store, ref, path} = fixture(t, 6); const {readCompanionMemory} = await disclosure();
  const long = 'Original '.repeat(10000); const db = new Database(path); db.prepare("UPDATE events SET content = ? WHERE id = 'source-0'").run(long); db.close();
  const first = readCompanionMemory({store, companionId: cid, reference: ref, level: 'raw'});
  assert.equal(first.level, 'raw'); if (first.level !== 'raw') return;
  assert.equal(first.sources.length, 4); assert.equal(first.sources[0]!.content, long); assert.equal(first.nextOffset, 4);
  const second = readCompanionMemory({store, companionId: cid, reference: ref, level: 'raw', offset: first.nextOffset!});
  assert.equal(second.level, 'raw'); if (second.level !== 'raw') return;
  assert.equal(second.sources.length, 2); assert.equal(second.nextOffset, null); assert.deepEqual(second.sources.map(s => s.eventId), ['source-4', 'source-5']);
  assert.doesNotMatch(JSON.stringify(first), /REFINED|EXACT/);
  for (const offset of [-1, 0.5, 7]) assert.throws(() => readCompanionMemory({store, companionId: cid, reference: ref, level: 'raw', offset}), /offset/i);
});

test('released raw sources remain known references with null contents', async t => {
  const {store, ref, apply} = fixture(t); const {readCompanionMemory, memorySummaryItems} = await disclosure();
  apply([{action: 'release_details', sourceRefs: [{eventId: 'source-0', sourceRevision: 1}], summaries: [ref]}]);
  const raw = readCompanionMemory({store, companionId: cid, reference: ref, level: 'raw'});
  assert.equal(raw.level, 'raw'); if (raw.level !== 'raw') return;
  assert.equal(raw.detailsUnavailable, true); assert.equal(raw.sources[0]!.content, null); assert.equal(raw.sources[0]!.eventId, 'source-0');
  const hint=memorySummaryItems([store.companionMemory.getMemory(cid, ref)!],1000)[0]!;
  assert.deepEqual(hint.availableLayers,['refined','raw']);assert.equal(hint.detailsUnavailable,true);
});

test('partially released sources do not hide remaining raw pages from candidate hints',async t=>{
  const {store,ref,apply}=fixture(t,2);const {readCompanionMemory,memorySummaryItems}=await disclosure();
  apply([{action:'release_details',sourceRefs:[{eventId:'source-0',sourceRevision:1}],summaries:[ref]}]);
  const hint=memorySummaryItems([store.companionMemory.getMemory(cid,ref)!],1000)[0]!;
  assert.ok(hint.availableLayers.includes('raw'));assert.equal(hint.detailsUnavailable,true);
  const raw=readCompanionMemory({store,companionId:cid,reference:ref,level:'raw'});
  assert.equal(raw.level,'raw');if(raw.level!=='raw')return;
  assert.deepEqual(raw.sources.map(source=>source.content),[null,'RAW secret source-1']);
});

test('every layer rejects stale revisions, invalid evidence and forgotten DAG ancestors', async t => {
  const {store, ref, apply, path} = fixture(t); const {readCompanionMemory} = await disclosure();
  const next = apply([{action: 'condense', target: ref, draft: {...draft([]), parentRefs: []}}]).memories[0]!;
  for (const level of ['refined', 'raw'] as const) assert.throws(() => readCompanionMemory({store, companionId: cid, reference: ref, level}), /current|unavailable/i);
  const db = new Database(path); db.prepare("UPDATE event_metadata SET revision = 2 WHERE event_id = 'source-0'").run();
  assert.throws(() => readCompanionMemory({store, companionId: cid, reference: next, level: 'raw'}), /unavailable|revision/i);
  db.prepare("UPDATE event_metadata SET revision = 1 WHERE event_id = 'source-0'").run();
  db.prepare("UPDATE companion_memories SET status = 'forgotten' WHERE revision = 1").run(); db.close();
  assert.throws(() => readCompanionMemory({store, companionId: cid, reference: next, level: 'refined'}), /unavailable|current/i);
});
