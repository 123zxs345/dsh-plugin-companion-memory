import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk} from '@deepseek-ai/dsh-llm';
import type {Agent} from '@deepseek-ai/dsh-agent';
import {bindScopeParent,createScope,scopeTarget,type Scope} from '@deepseek-ai/dsh-scope';
import {SessionId,SessionLogOffset,SessionSeq,type SessionEvent} from '@deepseek-ai/dsh-session';
import type {MemoryMaterialIndex} from '../src/memory/material-index.ts';
import {StateStore} from '../src/state/store.ts';
import {createCompanionMemoryPlugin, type CompanionMemoryController, type CompanionMemoryPluginOptions} from '../src/runtime/dsh/companion-memory-plugin.ts';
import {createAgentRuntime, registerFixtureTools,TEST_MODEL,TEST_PROVIDER} from './fixtures/runtime/agent-runtime.ts';

const anchor='那盏路灯像留给我的一小块月亮';
const requestText=(r:GenerateOptions)=>r.messages.flatMap(m=>m.content.map(b=>b.type==='text'?b.text:'')).join('\n');
function chunks(text:string):StreamChunk[]{return [{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text},{type:'block-end',index:0,block:{type:'text',text}},{type:'finish',reason:{kind:'stop'}}];}
async function fixture(t:test.TestContext,extra:Partial<CompanionMemoryPluginOptions>={}){
  const dir=mkdtempSync(join(tmpdir(),'native-companion-'));const store=new StateStore(join(dir,'state.sqlite'));
  const runtime=await createAgentRuntime();registerFixtureTools(runtime.root);
  runtime.root.logger.exporter({levels:{default:3},export:m=>t.diagnostic(m.args.map(String).join(' '))});
  const requests:GenerateOptions[]=[];let controller!:CompanionMemoryController;let hops=false;let hopDone=false;
  runtime.adapter.stream=async function*(r){
    requests.push(r);const last=r.messages.at(-1);const content=last?.content.map(b=>b.type==='text'?b.text:'').join('')??'';
    if(content.startsWith('【后台记忆整理任务 A】')){yield* chunks(JSON.stringify({needsReview:true,topics:['shared quiet moment']}));return;}
    if(content.startsWith('【后台记忆整理任务 B】')){
      const source=store.companionMemory.listPending('friend',{limit:100}).find(s=>s.event.role==='user')!;
      yield* chunks(JSON.stringify({operations:[{action:'retain',draft:{summary:'路灯与安静陪伴的共同回忆',meaning:'用户珍视被惦记的安静瞬间。',anchors:[anchor],reason:'用户用月亮形容为自己亮着的路灯。',view:'shared_episode',certainty:'explicit',useWhen:'用户重提散步时',avoidWhen:'不要每次主动提起',sourceRefs:[{eventId:source.event.id,sourceRevision:source.metadata.revision}],parentRefs:[]}}]}));return;
    }
    if(hops&&!hopDone){hopDone=true;yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('recall-1'),name:'recall_memory',arguments:JSON.stringify({query:'散步'})}};yield {type:'finish',reason:{kind:'tool-calls'}};return;}
    yield* chunks('我记得你说的那种安静。');
  };
  const index={recall:async(cid:string)=>store.companionMemory.listMemories(cid).filter(memory=>memory.summary).map(memory=>({memory,similarity:.9})),maintain:async()=>{}} as unknown as MemoryMaterialIndex;
  let mount=await runtime.root.plugin(createCompanionMemoryPlugin({dataDir:dir,companionId:'friend',store,index,idleReviewSeconds:0,...extra,onReady:c=>{controller=c;}}));
  t.after(async()=>{await mount.dispose();await runtime.dispose();store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,store,runtime,requests,get controller(){return controller;},hop(){hops=true;},async reload(){await mount.dispose();mount=await runtime.root.plugin(createCompanionMemoryPlugin({dataDir:dir,companionId:'friend',store,index,idleReviewSeconds:0,onReady:c=>{controller=c;}}));},unload:()=>mount.dispose()};
}
const say=async(agent:Agent,text:string)=>{
  agent.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));await agent.whenIdle();
};

test('native index maintenance recovers and polls without new exchanges or paid reviews, then stops on unload',async t=>{
  t.mock.timers.enable({apis:['setInterval']});let passes=0;
  const index={maintain:async()=>{passes++;},recall:async()=>[]} as unknown as MemoryMaterialIndex;
  const f=await fixture(t,{index,maintenanceMode:'off'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(passes,1);
  t.mock.timers.tick(5000);await new Promise(resolve=>setImmediate(resolve));assert.equal(passes,2);
  assert.equal(f.requests.length,0);await f.unload();t.mock.timers.tick(10000);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(passes,2);
});

test('native plugin stages live events once, reuses exact host prefix/tools for A/B, recalls only short summaries in a new session',async t=>{
  const f=await fixture(t);const first=await f.runtime.createAgent('first');await say(first.agent,anchor);
  assert.equal(f.store.listEvents('friend','first').length,2);
  const chat=f.requests[0]!;assert.ok(chat.tools?.some(t=>t.name==='unrelated_only'));
  const review=await f.controller.reviewNow('apply');assert.equal(review.status,'applied');
  const a=f.requests[1]!,b=f.requests[2]!;
  assert.deepEqual(a.messages.slice(0,chat.messages.length),chat.messages);
  assert.equal(a.messages[chat.messages.length]?.role,'assistant');
  assert.deepEqual(a.tools,chat.tools);assert.deepEqual(b.tools,a.tools);
  assert.deepEqual(b.messages.slice(0,a.messages.length),a.messages);
  assert.match(requestText(a),/historyMessageIndex/);
  assert.equal(f.store.listEvents('friend','first').length,2,'review messages never become evidence');
  await first.dispose();const second=await f.runtime.createAgent('second');f.hop();await say(second.agent,'还记得那晚吗？');
  const live=f.requests.filter(r=>r.sessionId==='second');assert.equal(live.length,2);
  assert.match(requestText(live[0]!),/路灯与安静陪伴的共同回忆/);assert.match(requestText(live[1]!),/路灯与安静陪伴的共同回忆/);assert.doesNotMatch(requestText(live[0]!),new RegExp(anchor));
  const assembly=await f.runtime.root.systemPrompt.assemble({scope:second.agent,agent:second.agent});
  assert.equal(assembly.contexts.filter(c=>c.name==='companion:memory').length,1);
  assert.equal(requestText({...live[1]!,messages:live[1]!.messages.filter(m=>m.role!=='tool')}).split('记忆是理解相处的背景').length-1,1,'tool hops reuse one context snapshot');
  assert.ok(f.runtime.root.tools.schemas(second.agent).some(t=>t.name==='unrelated_only'));
});

test('native plugin opens refined and raw memory only when the model requests each layer',async t=>{
  const f=await fixture(t);const first=await f.runtime.createAgent('layer-source');await say(first.agent,anchor+'，旁边有个编号A17。');
  assert.equal((await f.controller.reviewNow('apply')).status,'applied');
  const memory=f.store.companionMemory.listMemories('friend')[0]!;const requests:GenerateOptions[]=[];let step=0;
  f.runtime.adapter.stream=async function*(request){
    requests.push(request);
    if(step<2){const level=step++===0?'refined':'raw';yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('read-'+level),name:'read_memory',arguments:JSON.stringify({memoryId:memory.memoryId,revision:memory.revision,level})}};yield {type:'finish',reason:{kind:'tool-calls'}};return;}
    yield* chunks('找到了那句原话。');
  };
  const next=await f.runtime.createAgent('layer-recall');await say(next.agent,'请核对那次散步的原话');
  assert.equal(requests.length,3);
  assert.doesNotMatch(requestText(requests[0]!),/A17|用户用月亮形容/);
  assert.match(requestText(requests[1]!),/用户用月亮形容/);assert.doesNotMatch(requestText(requests[1]!),/A17/);
  assert.match(requestText(requests[2]!),/A17/);
});

test('native controller exposes model-authored profile and erases it with its source',async t=>{
  const f=await fixture(t);
  assert.equal(typeof f.controller.userProfile,'function','Native plugin must expose its maintained user profile');
  assert.deepEqual(f.controller.userProfile().entries,[]);
  const first=await f.runtime.createAgent('profile');await say(first.agent,anchor);
  const source=f.store.listEvents('friend','profile').find(e=>e.role==='user')!;
  f.store.companionMemory.applyPlan({planId:'profile-seed',companionId:'friend',expectedEpoch:f.store.memoryFence('friend').stateEpoch,
    reviewedSources:[],operations:[{action:'retain',draft:{meaning:'用户珍惜有人为自己留灯的安静陪伴。',anchors:[anchor],view:'user_understanding',certainty:'inferred',
      reason:'从用户的比喻暂时理解，尚未确认适用于所有情境。',useWhen:'谈及安静陪伴',avoidWhen:'不要断言其所有情感需求',sourceRefs:[{eventId:source.id,sourceRevision:1}],parentRefs:[]}}]});
  const profile=f.controller.userProfile();assert.equal(profile.entries.length,1);assert.equal(profile.entries[0]!.certainty,'inferred');
  assert.equal(profile.entries[0]!.sourceRefs[0]!.eventId,source.id);
  await f.controller.forget([source.id]);assert.deepEqual(f.controller.userProfile().entries,[]);
  await f.unload();assert.throws(()=>f.controller.userProfile(),/disposed/i);
});

test('persisted preview applies after unload/reload without a paid call, and unloaded handlers cannot write',async t=>{
  const f=await fixture(t);const first=await f.runtime.createAgent('first');await say(first.agent,anchor);
  assert.equal((await f.controller.reviewNow('preview')).status,'preview');await first.dispose();
  const count=f.requests.length;await f.reload();assert.equal(f.controller.snapshot().status,'preview');
  assert.equal((await f.controller.applyPreview()).status,'applied');assert.equal(f.requests.length,count);
  const second=await f.runtime.createAgent('second');await f.unload();await say(second.agent,'不要再被卸载的插件写入');
  assert.equal(f.store.listEvents('friend','second').length,0);
  assert.throws(()=>f.controller.snapshot(),/disposed/i);
});

test('explicit forgetting invalidates cached review and memory context without claiming host history removal',async t=>{
  const f=await fixture(t);const first=await f.runtime.createAgent('first');await say(first.agent,anchor);
  assert.equal((await f.controller.reviewNow('apply')).status,'applied');
  const source=f.store.listEvents('friend','first').find(e=>e.role==='user')!;
  const outcome=await f.controller.forget([source.id]);assert.equal(outcome.hostHistoryErased,false);
  const next=await f.runtime.createAgent('fresh');await say(next.agent,'你好');
  assert.equal(requestText(f.requests.at(-1)!).includes(anchor),false);
  await say(first.agent,'今天是另一个安静的时刻');
  const index=f.requests.length;await f.controller.reviewNow('preview');
  assert.equal(requestText(f.requests[index]!).includes(anchor),false,'a forgotten host prefix is not reused by later background review');
});

test('configured owner scope excludes neighbors and replayed input is not ingested or duplicated',async t=>{
  const owner={};const f=await fixture(t,{ownerScope:owner});let scope!:Scope;
  const scopePlugin=await f.runtime.root.plugin({name:'owner-fixture',inject:['agents'],apply(ctx){scope=createScope(ctx,owner);}});t.after(()=>scopePlugin.dispose());t.after(()=>scope.dispose());
  const seed:SessionEvent<'user/message'>={type:'user/message',seq:SessionSeq(0),time:Date.now()-1000,surfaceOp:'append',data:createUserMessage({content:[{type:'text',text:'old replay'}],source:{kind:'user'}})};
  const handle=await scope.ctx.agents.create({sessionId:SessionId('owned'),agentOptions:{provider:TEST_PROVIDER,model:TEST_MODEL},seed:[seed],meta:{isSeeded:true},inheritedEventCount:SessionLogOffset(1),setup:(_ctx,agent)=>{bindScopeParent(agent,owner);}});t.after(()=>handle.dispose());
  let event:SessionEvent|undefined;handle.agent.ctx.on('session/event',(_s,e)=>{if(e.type==='user/message')event=e;});
  await say(handle.agent,anchor);assert.ok(event);
  handle.agent.ctx.emit(scopeTarget(handle.agent.session,handle.agent),'session/event',handle.agent.session,event);
  assert.equal(f.store.listEvents('friend','owned').length,2);
  assert.equal(f.store.listEvents('friend','owned').some(e=>e.content==='old replay'),false);
  const other=await f.runtime.createAgent('neighbor');await say(other.agent,'outside owner');
  assert.equal(f.store.listEvents('friend','neighbor').length,0);
  assert.equal(f.runtime.root.tools.schemas(other.agent).some(t=>t.name==='recall_memory'),false);
});

test('budget wrapper can refuse before provider I/O, and native calls retain host metering hooks',async t=>{
  let deny=true;let charges=0;const budgetError=new Error('host budget exhausted');
  const f=await fixture(t,{runModel:async(request,next)=>{charges++;if(deny)throw budgetError;return next(request);},isBudgetError:error=>error===budgetError});
  let metered=0;f.runtime.root.on('llm/stream',async function*(r,next){metered++;yield* next();});
  const agent=await f.runtime.createAgent('metered');await say(agent.agent,anchor);
  assert.equal((await f.controller.reviewNow()).status,'budget-exceeded');assert.equal(metered,1);
  deny=false;assert.equal((await f.controller.reviewNow('apply')).status,'applied');assert.equal(metered,3);assert.equal(charges,3);
});

test('automatic budget recovery resumes pending review without another user message', {timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});let deny=true,charges=0;
  const budgetError=new Error('temporarily exhausted');
  const f=await fixture(t,{idleReviewSeconds:.01,runModel:async(request,next)=>{charges++;if(deny)throw budgetError;return next(request);},isBudgetError:error=>error===budgetError});
  const agent=await f.runtime.createAgent('recover-auto');await say(agent.agent,anchor);
  t.mock.timers.tick(11);for(let n=0;n<10;n++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(charges,1);assert.equal(f.requests.length,1);
  deny=false;t.mock.timers.tick(60000);for(let n=0;n<30;n++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(charges,3);assert.equal(f.controller.snapshot().status,'applied');
  assert.equal(f.store.companionMemory.listMemories('friend').length,1);
});

test('unloading cancels and drains an in-flight review before returning',async t=>{
  let entered!:()=>void;const waiting=new Promise<void>(resolve=>entered=resolve);
  const f=await fixture(t,{runModel:async request=>{entered();await new Promise((_,reject)=>request.signal!.addEventListener('abort',()=>reject(request.signal!.reason),{once:true}));throw new Error('unreachable');}});
  const agent=await f.runtime.createAgent('active');await say(agent.agent,anchor);
  const reviewing=f.controller.reviewNow('apply');await waiting;await f.unload();await reviewing;
  assert.equal(f.store.companionMemory.listMemories('friend',{limit:100}).length,0);
  await say(agent.agent,'after unload');assert.equal(f.store.listEvents('friend','active').length,2);
});
