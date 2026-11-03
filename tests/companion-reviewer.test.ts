import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StateStore} from '../src/state/store.ts';
import {DEFAULT_TEST_SETTINGS as DEFAULT_DEMO_SETTINGS} from './fixtures/review-settings.ts';
import type {ProfileModel,ProfileModelRequest} from '../src/profile/model-types.ts';

async function fixture(t:test.TestContext){
  assert.ok(existsSync(new URL('../src/memory/reviewer.ts',import.meta.url)), 'Shared memory reviewer must exist');
  const {CompanionMemoryReviewer}=await import('../src/memory/reviewer.ts');
  const directory=mkdtempSync(join(tmpdir(),'companion-review-'));
  const store=new StateStore(join(directory,'state.sqlite'));
  store.ensureCompanion({id:'owner',name:'小伴',anchors:{}});
  const settings={...DEFAULT_DEMO_SETTINGS};
  const calls:ProfileModelRequest[]=[];
  let failB=false,budgetBlocked=false, decision:'retain'|'noop'|'defer'|'skip'|'invalid-evidence'='retain';
  const model:ProfileModel=async request=>{
    if(request.task==='memory-b'&&budgetBlocked)throw Object.assign(new Error('budget'),{budget:true});
    calls.push(request);
    if(request.task==='memory-a')return {model:'fake',text:JSON.stringify({needsReview:decision!=='skip',topics:['有意义的散步']})};
    if(failB)throw new Error('provider private failure');
    const input=JSON.parse(request.prompt), source=input.blocks[0].sources[decision==='invalid-evidence'?1:0];
    const sourceRefs=[{eventId:source.event.id,sourceRevision:source.metadata.revision}];
    const operations=decision==='noop'?[]:decision==='defer'?[{action:'defer',sourceRefs}]:[{action:'retain',draft:{summary:'河边的安静散步让用户感到有人陪伴。',meaning:'用户把那次安静散步视作有人陪伴的时刻。',anchors:decision==='invalid-evidence'?[]:['河边那一刻'],view:decision==='invalid-evidence'?'user_understanding':'shared_episode',certainty:'explicit',reason:'用户亲自赋予那一刻被陪伴的意义。',useWhen:'自然谈起共同经历',avoidWhen:'不在无关话题反复提起',sourceRefs,parentRefs:[]}}];
    return {model:'fake',text:JSON.stringify({operations})};
  };
  const make=()=>new CompanionMemoryReviewer({store,companionId:'owner',model,getSettings:()=>settings,index:()=>undefined,persistenceDir:directory,isBudgetError:error=>!!error&&typeof error==='object'&&'budget' in error});
  const add=(suffix='1')=>{
    for(const [role,content] of [['user','河边那一刻，你安静听着，对我很重要。'],['assistant','我在听。']] as const)
      store.stageEvent({id:role+suffix,companionId:'owner',sessionId:'chat',role,content,visibility:'private',occurredAt:new Date().toISOString(),revision:1});
  };
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,settings,calls,make,add,directory,setFailure:(value:boolean)=>{failB=value;},setBudget:(value:boolean)=>{budgetBlocked=value;},setDecision:(value:typeof decision)=>{decision=value;}};
}

test('durable A survives B failure and manual restart retry only pays B',async t=>{
  const f=await fixture(t);f.add();f.setFailure(true);
  assert.equal((await f.make().review('apply',true)).status,'error');
  assert.deepEqual(f.calls.map(c=>c.task),['memory-a','memory-b']);
  f.setFailure(false);
  const reopened=f.make();
  assert.equal(reopened.snapshot().status,'error');
  assert.equal((await reopened.review('apply',true)).status,'error');
  assert.equal(f.calls.length,2);
  assert.equal((await reopened.review('apply')).status,'applied');
  assert.deepEqual(f.calls.map(c=>c.task),['memory-a','memory-b','memory-b']);
  assert.equal(f.calls[2]?.harness,undefined,'Restored A must not invent a native branch');
});

test('external source erasure clears already applied review text from snapshots',async t=>{
  const f=await fixture(t);f.add();const reviewer=f.make();
  assert.equal((await reviewer.review('apply')).status,'applied');
  assert.ok(reviewer.snapshot().operations.length);
  f.store.forgetEvents('owner',['user1'],'erase');
  assert.deepEqual(reviewer.snapshot().operations,[]);
});

test('a full pending page advances completed exchanges and leaves the next page eligible',async t=>{
  const f=await fixture(t);f.setDecision('skip');
  for(let index=0;index<501;index++)f.add('page-'+index);
  const reviewer=f.make();
  assert.equal((await reviewer.review('apply',true)).status,'applied');
  assert.equal(f.store.companionMemory.listPending('owner',{limit:1000}).length,2);
  assert.equal((await reviewer.review('apply',true)).status,'applied');
  assert.equal(f.store.companionMemory.listPending('owner',{limit:1000}).length,0);
  assert.equal(f.calls.length,2);
});

test('budget replenishment retries the saved A automatically without treating budget as a paid failure',async t=>{
  const f=await fixture(t);f.add();f.setBudget(true);
  assert.equal((await f.make().review('apply',true)).status,'budget-exceeded');
  assert.deepEqual(f.calls.map(c=>c.task),['memory-a']);
  assert.equal((await f.make().review('apply',true)).status,'budget-exceeded');
  assert.equal(f.calls.length,1);
  f.setBudget(false);
  assert.equal((await f.make().review('apply',true)).status,'applied');
  assert.deepEqual(f.calls.map(c=>c.task),['memory-a','memory-b']);
});

test('store validation failure pauses automatic payment and manual retry replaces B while retaining A',async t=>{
  const f=await fixture(t);f.add();f.setDecision('invalid-evidence');
  assert.equal((await f.make().review('apply',true)).status,'error');
  assert.equal((await f.make().review('apply',true)).status,'error');
  assert.equal(f.calls.length,2);
  f.setDecision('retain');
  assert.equal((await f.make().review('apply')).status,'applied');
  assert.deepEqual(f.calls.map(c=>c.task),['memory-a','memory-b','memory-b']);
});

test('persisted preview can be reviewed and applied across restart without model calls',async t=>{
  const f=await fixture(t);f.add();
  assert.equal((await f.make().review('preview')).status,'preview');
  const reopened=f.make();
  assert.equal(reopened.snapshot().status,'preview');
  assert.equal((await reopened.review('preview')).status,'preview');
  assert.equal((await reopened.applyPreview()).status,'applied');
  assert.equal(f.calls.length,2);
  const journal=readFileSync(join(f.directory,'memory-review.json'),'utf8');
  assert.doesNotMatch(journal,/你安静听着|我在听|messages|harness/);
});

test('changed persona or model invalidates A and stale preview cannot be applied',async t=>{
  const f=await fixture(t);f.add();
  const reviewer=f.make();await reviewer.review('preview');
  f.settings.persona+=' 新人设';
  assert.equal((await reviewer.applyPreview()).status,'error');
  await reviewer.review('preview');assert.equal(f.calls.length,4);
  f.settings.model='changed-model';
  await reviewer.review('preview');assert.equal(f.calls.length,6);
});

test('source deletion purges persisted output before any reuse',async t=>{
  const f=await fixture(t);f.add();await f.make().review('preview');
  f.store.forgetEvents('owner',['user1'],'erase');
  assert.equal((await f.make().applyPreview()).status,'error');
  assert.doesNotMatch(readFileSync(join(f.directory,'memory-review.json'),'utf8'),/河边那一刻|安静散步/);
  assert.equal(f.calls.length,2);
});

for(const decision of ['noop','skip'] as const)test(`${decision} completes sources without repeated review`,async t=>{
  const f=await fixture(t);f.add();f.setDecision(decision);
  assert.equal((await f.make().review('apply',true)).status,'applied');
  assert.equal(f.store.companionMemory.listPending('owner').length,0);
  const count=f.calls.length;await f.make().review('apply',true);assert.equal(f.calls.length,count);
});

test('unchanged deferred sources stay quiet across restart and new evidence reopens them',async t=>{
  const f=await fixture(t);f.add();f.setDecision('defer');
  assert.equal((await f.make().review('apply',true)).status,'applied');
  const count=f.calls.length;
  await f.make().review('apply',true);assert.equal(f.calls.length,count);
  f.add('2');f.setDecision('noop');await f.make().review('apply',true);
  assert.equal(f.calls.length,count+2);
});
