import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StateStore } from '../src/state/store.ts';
import type { CompanionMemoryDraft, CompanionMemoryOperation, CompanionMemoryRevisionRef } from '../src/memory/companion-types.ts';

const cid = 'detail-release-test';
const sourceRef = {eventId:'original',sourceRevision:1};
const draft = (parents:CompanionMemoryRevisionRef[]=[]):CompanionMemoryDraft => ({
  meaning:'奶奶留给用户的荷包蛋承载被照顾的回忆。',anchors:['留一个荷包蛋'],view:'shared_episode',certainty:'explicit',
  reason:'用户主动解释了这段回忆的意义。',useWhen:'用户谈到奶奶或这种食物时。',avoidWhen:'无关话题。',
  sourceRefs:parents.length?[]:[sourceRef],parentRefs:parents,
});
function fixture(t:test.TestContext,task=false){
  const directory=mkdtempSync(join(tmpdir(),'companion-details-'));
  const store=new StateStore(join(directory,'state.sqlite'));
  store.ensureCompanion({id:cid,name:'测试伙伴',anchors:{identity:'测试'}});
  store.stageEvent({id:'original',companionId:cid,sessionId:'conversation',role:'user',content:'这碗面让我想起奶奶，以前她总给我留一个荷包蛋。今天订单号123。',occurredAt:'2000-01-01T00:00:00Z',visibility:'private',revision:1},task?{purpose:'task',taskId:'work'}:{purpose:'companion'});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const apply=(operations:CompanionMemoryOperation[],reviewed=true)=>store.companionMemory.applyPlan({planId:randomUUID(),companionId:cid,expectedEpoch:store.currentEpoch(cid),reviewedSources:reviewed?[sourceRef]:[],operations});
  return {store,apply};
}

test('explicit model detail release keeps meaningful anchors and usable provenance',t=>{
  const {store,apply}=fixture(t);
  const result=apply([{action:'retain',draft:draft()},{action:'release_details',sourceRefs:[sourceRef]}]);
  const reference=result.memories[0]!;
  const memory=store.companionMemory.getMemory(cid,reference)!;
  assert.deepEqual(memory.anchors,['留一个荷包蛋']);
  assert.equal(memory.detailsUnavailable,true);
  assert.equal(store.getEvent(cid,'original'),null);
  assert.deepEqual(store.listEvents(cid,'conversation'),[]);
  assert.ok(store.companionMemory.materialSnapshot(cid,reference));
  assert.equal(store.companionMemory.evidenceFor(cid,reference)[0]!.eventId,'original');
  const next=apply([{action:'condense',target:reference,draft:draft([reference])}],false);
  assert.ok(store.companionMemory.materialSnapshot(cid,next.memories[0]!));
  assert.equal(store.companionMemory.getMemory(cid,next.memories[0]!)!.detailsUnavailable,true);
  store.forgetEvents(cid,['original'],'erase');
  assert.equal(store.companionMemory.materialSnapshot(cid,next.memories[0]!),null);
});

test('old sources are retained unless the model explicitly releases their details',t=>{
  const {store,apply}=fixture(t);
  const first=apply([{action:'retain',draft:draft()}]).memories[0]!;
  apply([{action:'condense',target:first,draft:draft([first])}],false);
  assert.match(store.getEvent(cid,'original')!.content,/订单号123/);
});

test('model can reuse a sufficient existing summary to release detail without rewriting it',t=>{
  const {store,apply}=fixture(t);
  const reference=apply([{action:'retain',draft:draft()}]).memories[0]!;
  const released=apply([{action:'release_details',sourceRefs:[sourceRef],summaries:[reference]}],false);
  assert.deepEqual(released.memories,[]);
  assert.equal(store.companionMemory.getMemory(cid,reference)!.revision,1);
  assert.equal(store.companionMemory.getMemory(cid,reference)!.detailsUnavailable,true);
  assert.deepEqual(store.companionMemory.getMemory(cid,reference)!.anchors,['留一个荷包蛋']);
  assert.equal(store.getEvent(cid,'original'),null);
});

test('an unrelated memory needing original details blocks release atomically',t=>{
  const {store,apply}=fixture(t);
  apply([{action:'retain',draft:draft()}]);
  assert.throws(()=>apply([{action:'retain',draft:draft()},{action:'release_details',sourceRefs:[sourceRef]}]),/details|详情|memory-needs-details/);
  assert.equal(store.companionMemory.listMemories(cid).length,1);
  assert.ok(store.getEvent(cid,'original'));
});

test('active task and pinned memory protect their original data from detail release',t=>{
  const {store,apply}=fixture(t,true);
  store.companionMemory.setTaskState(cid,'work','active');
  assert.throws(()=>apply([{action:'retain',draft:draft()},{action:'release_details',sourceRefs:[sourceRef]}]),/details|详情|active-task/);
  store.companionMemory.setTaskState(cid,'work','completed');
  const first=apply([{action:'retain',draft:draft()}]).memories[0]!;
  store.companionMemory.pinMemory(cid,first,true);
  assert.throws(()=>apply([{action:'release_details',sourceRefs:[sourceRef]}],false),/details|详情|pinned-memory/);
  assert.ok(store.getEvent(cid,'original'));
});
