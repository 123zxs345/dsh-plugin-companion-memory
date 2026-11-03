import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {StateStore} from '../src/state/store.ts';
import {CompanionMemoryReviewer} from '../src/memory/reviewer.ts';
import type {CompanionMemoryDraft,CompanionMemoryOperation,CompanionSourceRef} from '../src/memory/companion-types.ts';
import type {ProfileModel,ProfileModelRequest} from '../src/profile/model-types.ts';
import type {MemoryMaterialIndex} from '../src/memory/material-index.ts';
import type {PromptPrefix} from '../src/demo/prompt-cache.ts';

const cid='owner';
const sr=(eventId:string):CompanionSourceRef=>({eventId,sourceRevision:1});
const draft=(eventId:string,extra:Partial<CompanionMemoryDraft>={}):CompanionMemoryDraft=>({summary:'重视安静陪伴',meaning:'用户把安静陪伴看得很重要。',anchors:[],view:'user_understanding',certainty:'explicit',reason:'用户说安静陪伴让自己感到被关心。',useWhen:'理解用户如何感受陪伴。',avoidWhen:'不要据此拒绝新的经历。',sourceRefs:[sr(eventId)],parentRefs:[],...extra});
async function profileApi(){
  assert.ok(existsSync(new URL('../src/memory/user-profile.ts',import.meta.url)),'shared user profile projection must exist');
  return import('../src/memory/user-profile.ts');
}
function fixture(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'companion-user-profile-')),path=join(directory,'state.sqlite');
  const store=new StateStore(path);store.ensureCompanion({id:cid,name:'小伴',anchors:{}});
  const sql=new Database(path);
  t.after(()=>{sql.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const add=(id:string,content='安静陪伴让我感到被关心。',role:'user'|'assistant'='user')=>store.stageEvent({id,companionId:cid,sessionId:'chat',role,content,visibility:'private',occurredAt:new Date().toISOString(),revision:1});
  const apply=(operations:CompanionMemoryOperation[],reviewedSources:CompanionSourceRef[]=[])=>store.companionMemory.applyPlan({planId:randomUUID(),companionId:cid,expectedEpoch:store.currentEpoch(cid),operations,reviewedSources});
  const retain=(id:string,extra:Partial<CompanionMemoryDraft>={})=>{add(id);return apply([{action:'retain',draft:draft(id,extra)}],[sr(id)]).memories[0]!;};
  const seed=()=>[retain('understanding'),retain('habit',{meaning:'用户希望先被听完再得到建议。',view:'interaction_habit'})];
  const calls:ProfileModelRequest[]=[];let failB=false;
  let operations:CompanionMemoryOperation[]=[];
  const model:ProfileModel=async request=>{calls.push(request);if(request.task==='memory-a')return {model:'fake',text:'{"needsReview":true,"topics":["平静的散步"]}'};if(failB)throw new Error('temporary B failure');return {model:'fake',text:JSON.stringify({operations})};};
  const settings={persona:'小伴',provider:'fake',baseUrl:'https://example.invalid',model:'fake',maintenanceMode:'preview' as const,candidateBudget:1};
  const index={recall:async()=>[],maintain:async()=>{}} as unknown as MemoryMaterialIndex;
  const make=(prefix?:PromptPrefix,allowMaterial?:(request:ProfileModelRequest)=>boolean)=>new CompanionMemoryReviewer({store,companionId:cid,model,getSettings:()=>settings,index:()=>index,persistenceDir:directory,getPrefix:()=>prefix,...(allowMaterial?{allowMaterial}:{})});
  const exchange=()=>{add('new-user','今天我自己在河边走了走，感觉终于有一点属于自己的时间。');add('new-assistant','听着，你找回了一点自己的节奏。','assistant');};
  const crowd=()=>{add('crowd-source');for(let start=0;start<1001;start+=100)apply(Array.from({length:Math.min(100,1001-start)},(_,n)=>({action:'retain',draft:draft('crowd-source',{view:'shared_episode',meaning:'普通经历 '+(start+n)})})),[sr('crowd-source')]);sql.prepare("UPDATE companion_memories SET created_at='2000-01-01T00:00:00Z' WHERE view!='shared_episode'").run();};
  return {directory,store,sql,add,apply,retain,seed,calls,make,exchange,crowd,setFailure:(value:boolean)=>{failB=value;},setOperations:(value:CompanionMemoryOperation[])=>{operations=value;}};
}

test('user profile projects model views deterministically and ignores retrieval accounting',async t=>{
  const f=fixture(t),refs=f.seed();f.retain('episode',{view:'shared_episode'});
  const {readCompanionUserProfile}=await profileApi();
  const before=readCompanionUserProfile(f.store,cid);
  assert.equal(before.entries.length,2);assert.deepEqual(before.entries.map(e=>e.memoryId),refs.map(r=>r.memoryId).sort());
  assert.deepEqual(before.entries.flatMap(e=>e.sourceRefs).map(s=>s.eventId).sort(),['habit','understanding']);
  f.store.companionMemory.recordRetrieved(cid,refs);f.store.companionMemory.recordPresented(cid,refs);
  assert.deepEqual(readCompanionUserProfile(f.store,cid),before);
  f.apply([{action:'deprioritize',target:refs[0]!}]);
  const deprioritized=readCompanionUserProfile(f.store,cid);assert.equal(deprioritized.entries.length,2);assert.notEqual(deprioritized.revision,before.revision);
  f.store.companionMemory.pinMemory(cid,refs[1]!,true);
  assert.equal(readCompanionUserProfile(f.store,cid).entries.find(e=>e.memoryId===refs[1]!.memoryId)?.pinned,true);
});

test('correction and erase withdraw derived profile while evidence revision validity is checked',async t=>{
  const f=fixture(t);const parent=f.retain('understanding');
  f.apply([{action:'retain',draft:draft('understanding',{meaning:'由旧理解推导的相处方式',view:'interaction_habit',certainty:'inferred',sourceRefs:[],parentRefs:[parent]})}]);
  const {readCompanionUserProfile}=await profileApi();assert.equal(readCompanionUserProfile(f.store,cid).entries.length,2);
  f.store.forgetEvents(cid,['understanding'],'suppress');assert.equal(readCompanionUserProfile(f.store,cid).entries.length,0);
  f.retain('correction',{meaning:'用户目前需要明确回应，不是一味安静。'});assert.equal(readCompanionUserProfile(f.store,cid).entries.length,1);
  f.store.forgetEvents(cid,['correction'],'erase');assert.equal(readCompanionUserProfile(f.store,cid).entries.length,0);
  f.retain('changed');f.sql.prepare('UPDATE event_metadata SET revision=2 WHERE event_id=?').run('changed');
  assert.equal(readCompanionUserProfile(f.store,cid).entries.length,0);
});

test('profile remains complete behind more than a thousand ordinary episodes',async t=>{
  const f=fixture(t),refs=f.seed();f.crowd();
  assert.ok(f.store.companionMemory.listMemories(cid,{limit:1000}).every(m=>m.view==='shared_episode'));
  const {readCompanionUserProfile}=await profileApi();assert.deepEqual(readCompanionUserProfile(f.store,cid).entries.map(e=>e.memoryId),refs.map(r=>r.memoryId).sort());
});

test('A and B receive full editable profile despite index miss and one ordinary candidate slot',async t=>{
  const f=fixture(t),refs=f.seed();const episode=f.retain('episode',{view:'shared_episode'});f.exchange();
  const status=await f.make().review('preview');assert.equal(status.status,'preview');
  const a=JSON.parse(f.calls[0]!.prompt),b=JSON.parse(f.calls[1]!.prompt);
  assert.deepEqual(a.userProfile?.entries.map((e:{memoryId:string})=>e.memoryId).sort(),refs.map(r=>r.memoryId).sort());
  assert.deepEqual(b.memories,[],'an index miss never fills a candidate slot from the catalog');
  assert.deepEqual(b.userProfile.entries.map((entry:{memoryId:string})=>entry.memoryId).sort(),refs.map(r=>r.memoryId).sort());
  assert.ok(!f.calls[1]!.messages!.at(-1)!.content.includes(episode.memoryId));
  for(const ref of refs)assert.ok(f.calls[0]!.messages!.at(-1)!.content.includes(ref.memoryId));
  assert.match(f.calls[0]!.system+f.calls[0]!.messages!.at(-1)!.content,/用户画像/);
});

test('one B plan updates understanding and retains meaningful new episode with only two model calls',async t=>{
  const f=fixture(t),refs=f.seed();f.exchange();
  f.setOperations([{action:'condense',target:refs[0]!,draft:draft('new-user',{meaning:'用户需要自己选择陪伴和独处，目前找回自己的时间很重要。'})},{action:'retain',draft:draft('new-user',{view:'shared_episode',meaning:'独自在河边散步，让用户重新找回属于自己的时间。',reason:'用户明确说终于有属于自己的时间；结合本批新理解，这是自主感的具体经历。'})}]);
  assert.equal((await f.make().review('apply')).status,'applied');assert.deepEqual(f.calls.map(c=>c.task),['memory-a','memory-b']);
  const updated=f.store.companionMemory.getMemory(cid,refs[0]!.memoryId)!;assert.equal(updated.revision,2);
  assert.ok(f.store.companionMemory.listMemories(cid).some(m=>m.view==='shared_episode'));assert.equal(f.store.companionMemory.listPending(cid).length,0);
  const {readCompanionUserProfile}=await profileApi();assert.ok(readCompanionUserProfile(f.store,cid).entries.some(e=>e.meaning===updated.meaning));
});

test('native A preserves chat prefix and B inherits profile once; restart reconstructs profile without paying A again',async t=>{
  const f=fixture(t),refs=f.seed();f.exchange();
  const prefix:PromptPrefix={system:'unchanged chat system',messages:[{role:'user',content:'unchanged chat message'}],harness:{sessionId:'chat',system:'unchanged chat system',messages:[],events:[],tools:[]}};
  const original=structuredClone(prefix);f.setFailure(true);assert.equal((await f.make(prefix).review('preview')).status,'error');
  const a=f.calls[0]!,b=f.calls[1]!;assert.deepEqual(prefix,original);assert.equal(a.system,original.system);assert.deepEqual(a.messages!.slice(0,1),original.messages);assert.equal(a.harness?.branch,prefix.harness);
  for(const ref of refs){assert.ok(a.messages!.at(-1)!.content.includes(ref.memoryId));assert.equal(b.messages!.at(-1)!.content.includes(ref.memoryId),false,'profile is inherited, not resent in B append');}
  f.setFailure(false);assert.equal((await f.make().review('preview')).status,'preview');assert.deepEqual(f.calls.map(c=>c.task),['memory-a','memory-b','memory-b']);
  const rebuilt=f.calls[2]!;assert.equal(rebuilt.harness,undefined);for(const ref of refs)assert.ok(rebuilt.messages![0]!.content.includes(ref.memoryId));
});

test('review cache depends on profile evidence outside the ordinary thousand item catalog',async t=>{
  const f=fixture(t);f.seed();f.crowd();f.exchange();assert.equal((await f.make().review('preview')).status,'preview');
  f.sql.prepare('UPDATE events SET content=? WHERE id=?').run('用户纠正了安静陪伴的意义。','understanding');
  assert.equal((await f.make().review('preview')).status,'preview');assert.equal(f.calls.length,4,'changed profile evidence invalidates paid A and B');
});

test('source validity changes invalidate saved A while retrieval accounting keeps the review reusable',async t=>{
  const f=fixture(t),refs=f.seed();f.exchange();assert.equal((await f.make().review('preview')).status,'preview');
  f.store.companionMemory.recordRetrieved(cid,refs);f.store.companionMemory.recordPresented(cid,refs);
  assert.equal((await f.make().review('preview')).status,'preview');assert.equal(f.calls.length,2);
  f.sql.prepare('UPDATE companion_staged_sources SET expires_at=? WHERE event_id=?').run('2000-01-01T00:00:00Z','understanding');
  assert.equal((await f.make().review('preview')).status,'preview');assert.equal(f.calls.length,4,'invalidated profile must be removed before A is paid or reused');
  assert.equal(JSON.parse(f.calls[2]!.prompt).userProfile.entries.length,1);
});

test('host capacity checks reject a whole full-profile request instead of silently pruning profile',async t=>{
  const f=fixture(t);f.seed();f.exchange();
  assert.equal((await f.make(undefined,request=>!JSON.stringify(request).includes('用户把安静陪伴看得很重要')).review('preview')).status,'budget-exceeded');
  assert.equal(f.calls.length,0);
});
