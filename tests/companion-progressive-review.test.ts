import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MessageId,ToolCallId} from '@deepseek-ai/dsh-llm';
import Database from 'better-sqlite3';
import {StateStore} from '../src/state/store.ts';
import {CompanionMemoryReviewer} from '../src/memory/reviewer.ts';
import {parseStageBRead,parseStageB} from '../src/memory/reflection.ts';
import {readCompanionMemory} from '../src/memory/disclosure.ts';
import type {PromptPrefix} from '../src/demo/prompt-cache.ts';
import type {CompanionMemoryDraft,CompanionMemoryRevisionRef} from '../src/memory/companion-types.ts';
import type {MemoryMaterialIndex} from '../src/memory/material-index.ts';
import type {ProfileModel,ProfileModelRequest} from '../src/profile/model-types.ts';
import type {HarnessBranch} from '../src/runtime/harness-context.ts';

const cid='progressive-review';
const sourceRef=(eventId:string)=>({eventId,sourceRevision:1});
const read=(target:CompanionMemoryRevisionRef,level:'refined'|'raw',offset?:number)=>JSON.stringify({read:[{...target,level,...(offset===undefined?{}:{offset})}]});
const final=(operations:unknown[]=[])=>JSON.stringify({operations});
function fixture(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'progressive-review-'));
  const store=new StateStore(join(directory,'state.sqlite'));store.ensureCompanion({id:cid,name:'伙伴',anchors:{}});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const calls:ProfileModelRequest[]=[];
  const settings={persona:'伙伴',provider:'fake',baseUrl:'https://example.invalid',model:'fake',maintenanceMode:'auto' as const,candidateBudget:24,minimumSimilarity:.55};
  const add=(id:string,role:'user'|'assistant',content:string)=>store.stageEvent({id,companionId:cid,sessionId:id.startsWith('new')?'new-chat':id,role,content,visibility:'private',occurredAt:new Date().toISOString(),revision:1});
  const draft=(id:string,extra:Partial<CompanionMemoryDraft>={}):CompanionMemoryDraft=>({meaning:'HIDDEN_REFINED_'+id,summary:'SHORT_'+id,anchors:['unique-anchor'],view:'shared_episode',certainty:'explicit',reason:'明确表达',useWhen:'自然回想',avoidWhen:'不要反复提起',sourceRefs:[sourceRef(id)],parentRefs:[],...extra});
  const seed=(id='old',extra:Partial<CompanionMemoryDraft>={})=>{
    add(id,'user','RAW_SECRET_'+id+' unique-anchor');
    return store.companionMemory.applyPlan({planId:randomUUID(),companionId:cid,expectedEpoch:store.currentEpoch(cid),reviewedSources:[sourceRef(id)],operations:[{action:'retain',draft:draft(id,extra)}]}).memories[0]!;
  };
  const exchange=()=>{add('new-user','user','新的聊天内容');add('new-assistant','assistant','我在听');};
  const hits=new Map<string,number>();let indexEnabled=true;
  const index={recall:async(_cid:string,query:string)=>store.companionMemory.listMemories(cid).flatMap(memory=>{
    const score=hits.get(query+':'+memory.memoryId)??hits.get(memory.memoryId);return score===undefined?[]:[{memory,similarity:score,text:memory.summary??''}];
  }),maintain:async()=>{}} as unknown as MemoryMaterialIndex;
  let answer:ProfileModel=async()=>({model:'fake',text:final()});
  const model:ProfileModel=async request=>{calls.push(structuredClone(request));if(request.task==='memory-a')return {model:'fake',text:'{"needsReview":true,"topics":["topic-one","topic-two"]}',harness:branch('a')};return answer(request);};
  const make=(allowMaterial?:(r:ProfileModelRequest)=>boolean,prefix?:PromptPrefix)=>new CompanionMemoryReviewer({store,companionId:cid,model,getSettings:()=>settings,index:()=>indexEnabled?index:undefined,persistenceDir:directory,allowMaterial,getPrefix:()=>prefix});
  return {store,directory,calls,settings,hits,seed,exchange,draft,make,setAnswer:(model:ProfileModel)=>{answer=model;},disableIndex:()=>{indexEnabled=false;}};
}
const branch=(sessionId:string):HarnessBranch=>({sessionId,system:'native system',messages:[],events:[],tools:[]});
const visible=(request:ProfileModelRequest)=>request.messages!.map(message=>message.content).join('\n');

function nativePrefix(f:ReturnType<typeof fixture>,ref:CompanionMemoryRevisionRef):PromptPrefix{
  const native=branch('native-chat');
  const messages:HarnessBranch['messages'][number][]=[],projected:PromptPrefix['messages']=[];
  for(const level of ['refined','raw'] as const){
    const callId=ToolCallId('call-'+level),payload=readCompanionMemory({store:f.store,companionId:cid,reference:ref,level});
    messages.push({id:MessageId(randomUUID()),role:'assistant',source:{kind:'model',provider:'fake',model:'fake'},content:[{type:'tool-call',id:callId,name:'read_memory',arguments:JSON.stringify({...ref,level})}]});
    messages.push({id:MessageId(randomUUID()),role:'tool',toolCallId:callId,source:{kind:'tool',callId},isError:false,content:[{type:'text',text:JSON.stringify(payload)}]});
    projected.push({role:'user',content:JSON.stringify(payload)});
  }
  return {system:'native system',messages:projected,harness:{...native,messages}};
}

test('native chat read receipts authorize an inherited target and read raw anchors without another model read',async t=>{
  const f=fixture(t),ref=f.seed();f.exchange();f.hits.set(ref.memoryId,.9);const prefix=nativePrefix(f,ref);
  f.setAnswer(async request=>{
    assert.match(request.messages!.at(-1)!.content,/后台记忆整理任务 B/);assert.match(request.messages!.at(-1)!.content,/已核验的历史记忆读取/);
    assert.match(request.messages!.at(-1)!.content,/SHORT_old/);assert.match(visible(request),/"action":"condense"/);
    return {model:'fake',text:final([{action:'condense',target:ref,draft:f.draft('new-user',{anchors:['RAW_SECRET_old'],parentRefs:[ref]})}])};
  });
  assert.equal((await f.make(undefined,prefix).review('preview')).status,'preview');assert.equal(f.calls.length,2);
  const journal=readFileSync(join(f.directory,'memory-review.json'),'utf8');
  assert.ok(JSON.parse(journal).entry.inheritedReads.length===2);assert.doesNotMatch(journal,/HIDDEN_REFINED_old|RAW_SECRET_old unique-anchor/);
  assert.equal((await f.make().applyPreview()).status,'applied');assert.equal(f.calls.length,2);
});

test('native read receipts survive B failure and reconstruct only the previously requested layers',async t=>{
  const f=fixture(t),ref=f.seed();f.exchange();f.hits.set(ref.memoryId,.9);const prefix=nativePrefix(f,ref);
  f.setAnswer(async()=>{throw new Error('B provider failed');});assert.equal((await f.make(undefined,prefix).review('preview')).status,'error');
  f.setAnswer(async request=>{assert.match(visible(request),/RAW_SECRET_old/);return {model:'fake',text:final([{action:'condense',target:ref,draft:f.draft('new-user',{anchors:['RAW_SECRET_old']})}])};});
  assert.equal((await f.make().review('apply')).status,'applied');assert.equal(f.calls.length,3);assert.equal(f.calls.filter(c=>c.task==='memory-a').length,1);
});

for(const kind of ['user-text','failed-tool','mismatched-result'] as const)test(`unproven native read context cannot authorize a candidate: ${kind}`,async t=>{
  const f=fixture(t),ref=f.seed();f.exchange();f.hits.set(ref.memoryId,.9);const prefix=nativePrefix(f,ref);
  if(kind==='user-text')prefix.harness!.messages=[];
  else prefix.harness!.messages=prefix.harness!.messages.map(message=>message.role!=='tool'?message:kind==='failed-tool'?{...message,isError:true}:{...message,content:[{type:'text',text:'{"memoryId":"forged","revision":1,"level":"refined"}'}]});
  f.setAnswer(async()=>({model:'fake',text:final([{action:'discard',target:ref}])}));
  assert.equal((await f.make(undefined,prefix).review('apply')).status,'error');assert.equal(f.store.companionMemory.getMemory(cid,ref)!.status,'active');
});

test('changed raw source bytes invalidate an older native read receipt even at the same revision',async t=>{
  const f=fixture(t),ref=f.seed();f.exchange();f.hits.set(ref.memoryId,.9);const prefix=nativePrefix(f,ref);
  const sql=new Database(join(f.directory,'state.sqlite'));
  try{sql.prepare('UPDATE events SET content=? WHERE companion_id=? AND id=?').run('NEW_RAW unique-anchor',cid,'old');}finally{sql.close();}
  f.setAnswer(async()=>({model:'fake',text:final([{action:'condense',target:ref,draft:f.draft('new-user',{anchors:['RAW_SECRET_old']})}])}));
  assert.equal((await f.make(undefined,prefix).review('apply')).status,'error');
  const journal=JSON.parse(readFileSync(join(f.directory,'memory-review.json'),'utf8'));
  assert.equal(journal.entry.inheritedReads.length,1,'only unchanged refined contents may be reused');
  assert.equal(JSON.parse(journal.entry.inheritedReads[0]).read[0].level,'refined');
});

test('provider messages disclose short summary, refined memory, and raw source only when requested',async t=>{
  const f=fixture(t),ref=f.seed();f.exchange();f.hits.set(ref.memoryId,.9);
  let step=0;
  f.setAnswer(async request=>{
    if(step++===0){
      assert.match(visible(request),/SHORT_old/);assert.doesNotMatch(visible(request),/HIDDEN_REFINED_old|RAW_SECRET_old|unique-anchor/);
      assert.equal(request.harness?.branch.sessionId,'a');return {model:'fake',text:read(ref,'refined'),harness:branch('refined')};
    }
    if(step===2){assert.match(visible(request),/HIDDEN_REFINED_old/);assert.doesNotMatch(visible(request),/RAW_SECRET_old/);assert.equal(request.harness?.branch.sessionId,'refined');return {model:'fake',text:read(ref,'raw'),harness:branch('raw')};}
    assert.match(visible(request),/RAW_SECRET_old/);assert.equal(request.harness?.branch.sessionId,'raw');return {model:'fake',text:final([{action:'deprioritize',target:ref}])};
  });
  assert.equal((await f.make().review('preview')).status,'preview');assert.equal(f.calls.length,4);
  const journal=readFileSync(join(f.directory,'memory-review.json'),'utf8');assert.doesNotMatch(journal,/HIDDEN_REFINED|RAW_SECRET|unique-anchor|messages|harness/);
  assert.equal((await f.make().applyPreview()).status,'applied');assert.equal(f.calls.length,4);
});

test('failed continuation replays saved reads on restart without paying A or successful read decisions again',async t=>{
  const f=fixture(t),ref=f.seed();f.exchange();f.hits.set(ref.memoryId,.9);let step=0;
  f.setAnswer(async()=>{step++;if(step===1)return {model:'fake',text:read(ref,'refined')};if(step===2)return {model:'fake',text:read(ref,'raw')};throw new Error('provider failed after reads');});
  assert.equal((await f.make().review('preview',true)).status,'error');assert.equal(f.calls.length,4);
  assert.equal((await f.make().review('preview',true)).status,'error');assert.equal(f.calls.length,4);
  f.setAnswer(async request=>{assert.match(visible(request),/RAW_SECRET_old/);assert.match(visible(request),/HIDDEN_REFINED_old/);assert.equal(request.harness,undefined);return {model:'fake',text:final()};});
  assert.equal((await f.make().review('preview')).status,'preview');assert.equal(f.calls.length,5);
  assert.equal(f.calls.filter(c=>c.task==='memory-a').length,1);
});

for(const mutation of ['discard','parent'] as const)test(`unread candidate cannot authorize ${mutation}`,async t=>{
  const f=fixture(t),ref=f.seed();f.exchange();f.hits.set(ref.memoryId,.9);
  const operation=mutation==='discard'?{action:'discard',target:ref}:{action:'retain',draft:f.draft('new-user',{sourceRefs:[],parentRefs:[ref],anchors:[]})};
  f.setAnswer(async()=>({model:'fake',text:final([operation])}));
  assert.equal((await f.make().review('apply')).status,'error');assert.equal(f.store.companionMemory.getMemory(cid,ref)!.status,'active');
});

test('a one-slot candidate budget globally selects the highest topic score and never fills an index miss',async t=>{
  const f=fixture(t),low=f.seed('low'),high=f.seed('high'),below=f.seed('below');f.exchange();f.settings.candidateBudget=1;
  f.hits.set('topic-one:'+low.memoryId,.7);f.hits.set('topic-two:'+high.memoryId,.95);f.hits.set(below.memoryId,.54);
  assert.equal((await f.make().review('preview')).status,'preview');
  assert.deepEqual(JSON.parse(f.calls[1]!.prompt).memories.map((m:CompanionMemoryRevisionRef)=>m.memoryId),[high.memoryId]);
  f.disableIndex();f.settings.minimumSimilarity=.56;
  assert.equal((await f.make().review('preview')).status,'preview');assert.deepEqual(JSON.parse(f.calls[3]!.prompt).memories,[]);
});

test('read replay and saved previews reject erased sources before any more provider calls',async t=>{
  const f=fixture(t),ref=f.seed();f.exchange();f.hits.set(ref.memoryId,.9);let step=0;
  f.setAnswer(async()=>({model:'fake',text:step++===0?read(ref,'refined'):final([{action:'deprioritize',target:ref}])}));
  assert.equal((await f.make().review('preview')).status,'preview');f.store.forgetEvents(cid,['old'],'erase');
  assert.equal((await f.make().applyPreview()).status,'error');assert.equal(f.calls.length,3);
  assert.doesNotMatch(readFileSync(join(f.directory,'memory-review.json'),'utf8'),new RegExp(ref.memoryId));
});

test('each continuation is budget checked and a saved read can resume after replenishment',async t=>{
  const f=fixture(t),ref=f.seed();f.exchange();f.hits.set(ref.memoryId,.9);let step=0;
  f.setAnswer(async()=>({model:'fake',text:step++===0?read(ref,'raw'):final()}));
  assert.equal((await f.make(request=>!visible(request).includes('RAW_SECRET_old')).review('preview',true)).status,'budget-exceeded');
  assert.equal(f.calls.length,2);
  assert.equal((await f.make().review('preview',true)).status,'preview');assert.equal(f.calls.length,3);
});

test('refined source identities do not authorize quoting raw text that was never read',async t=>{
  const f=fixture(t),ref=f.seed();f.exchange();f.hits.set(ref.memoryId,.9);let step=0;
  f.setAnswer(async()=>({model:'fake',text:step++===0?read(ref,'refined'):final([{action:'condense',target:ref,draft:f.draft('old',{anchors:['RAW_SECRET_old']})}])}));
  assert.equal((await f.make().review('apply')).status,'error');
  assert.equal(f.store.companionMemory.getMemory(cid,ref)!.revision,1);
  assert.doesNotMatch(visible(f.calls[2]!),/RAW_SECRET_old/);
});

test('read loops stop after eight rounds, quiet automatic retries, and allow a final manual response',async t=>{
  const f=fixture(t),ref=f.seed();f.exchange();f.hits.set(ref.memoryId,.9);f.setAnswer(async()=>({model:'fake',text:read(ref,'refined')}));
  assert.equal((await f.make().review('preview',true)).status,'error');assert.equal(f.calls.length,10);
  assert.equal((await f.make().review('preview',true)).status,'error');assert.equal(f.calls.length,10);
  f.setAnswer(async()=>({model:'fake',text:final()}));assert.equal((await f.make().review('preview')).status,'preview');assert.equal(f.calls.length,11);
});

test('missing summaries backfill with no new events, preserve pinned revision, and never send old raw text',async t=>{
  const f=fixture(t),ref=f.seed('legacy',{summary:undefined});f.store.companionMemory.pinMemory(cid,ref,true);
  f.setAnswer(async request=>{assert.match(visible(request),/HIDDEN_REFINED_legacy/);assert.doesNotMatch(visible(request),/RAW_SECRET_legacy/);return {model:'fake',text:final([{action:'summarize',target:ref,summary:'模型归纳的简短总结'}])};});
  assert.equal((await f.make().review('apply',true)).status,'applied');assert.equal(f.calls.length,2);
  const memory=f.store.companionMemory.getMemory(cid,ref)!;assert.equal(memory.summary,'模型归纳的简短总结');assert.equal(memory.revision,ref.revision);assert.equal(memory.pinned,true);
  await f.make().review('apply',true);assert.equal(f.calls.length,2);
});

test('noop summary backfill pages advance and become quiet across restart without empty plans',async t=>{
  const f=fixture(t);for(let n=0;n<25;n++)f.seed('legacy-'+n,{summary:undefined});
  const first=await f.make().review('apply',true);assert.equal(first.status,'applied');assert.equal(first.hasMore,true);assert.equal(f.calls.length,2);
  assert.equal(JSON.parse(f.calls[0]!.prompt).backfillMaterials.length,24);
  const last=await f.make().review('apply',true);assert.equal(last.status,'applied');assert.equal(last.hasMore,false);assert.equal(f.calls.length,4);
  assert.equal(JSON.parse(f.calls[2]!.prompt).backfillMaterials.length,1);
  assert.equal((await f.make().review('apply',true)).status,'idle');assert.equal(f.calls.length,4);
});

test('successful summary backfill keeps the next page eligible after applying a batch',async t=>{
  const f=fixture(t);for(let n=0;n<25;n++)f.seed('legacy-'+n,{summary:undefined});
  f.setAnswer(async request=>{
    const a=JSON.parse(f.calls.findLast(call=>call.task==='memory-a')!.prompt);
    return {model:'fake',text:final(a.backfillMaterials.map((item:{memory:CompanionMemoryRevisionRef})=>({action:'summarize',target:{memoryId:item.memory.memoryId,revision:item.memory.revision},summary:'模型补充的短总结'})))};
  });
  assert.equal((await f.make().review('apply',true)).status,'applied');assert.equal(f.calls.length,2);
  assert.equal(f.store.companionMemory.listMemoriesWithoutSummary(cid).length,1);
  assert.equal((await f.make().review('apply',true)).status,'applied');assert.equal(f.calls.length,4);
  assert.equal(f.store.companionMemory.listMemoriesWithoutSummary(cid).length,0);
});

test('new memory gets model summary alongside refined meaning in the same B response',async t=>{
  const f=fixture(t);f.exchange();f.setAnswer(async()=>({model:'fake',text:final([{action:'retain',draft:f.draft('new-user',{summary:'新交互的模型总结',anchors:[]})}])}));
  assert.equal((await f.make().review('apply')).status,'applied');assert.equal(f.calls.length,2);
  assert.equal(f.store.companionMemory.listMemories(cid)[0]!.summary,'新交互的模型总结');
});

for(const action of ['retain','condense','merge'] as const)test(`runtime ${action} drafts require a model summary before applying`,async t=>{
  const f=fixture(t),first=f.seed('first',{view:'user_understanding'}),second=f.seed('second',{view:'interaction_habit'});f.exchange();
  const makeOperation=(summary:string|undefined)=>{
    const draft=f.draft('new-user',{summary,anchors:[]});
    return action==='retain'?{action,draft}:action==='condense'?{action,target:first,draft}:{action,targets:[first,second],draft};
  };
  f.setAnswer(async()=>({model:'fake',text:final([makeOperation(undefined)])}));
  assert.equal((await f.make().review('apply')).status,'error');
  assert.equal(f.store.companionMemory.listMemories(cid).length,2);
  assert.equal(f.store.companionMemory.getMemory(cid,first.memoryId)!.revision,1);
  assert.equal(f.store.companionMemory.getMemory(cid,second.memoryId)!.revision,1);
  f.setAnswer(async()=>({model:'fake',text:final([makeOperation('模型概括的新短总结')])}));
  assert.equal((await f.make().review('apply')).status,'applied');
  assert.equal(f.calls.length,3,'manual correction reuses saved A');
  assert.ok(f.store.companionMemory.listMemories(cid).some(memory=>memory.summary==='模型概括的新短总结'));
});

test('read JSON validates scope, raw offsets, batch size and exact fields',()=>{
  const target={memoryId:'known',revision:1};assert.deepEqual(parseStageBRead(read(target,'raw',4),[target]),[{...target,level:'raw',offset:4}]);
  assert.throws(()=>parseStageBRead(read(target,'refined',1),[target]),/Offset/);
  assert.throws(()=>parseStageBRead(read({...target,memoryId:'unknown'},'raw'),[target]),/not presented/);
  assert.throws(()=>parseStageBRead(JSON.stringify({read:Array.from({length:9},()=>({...target,level:'raw'}))}),[target]),/array/);
  assert.throws(()=>parseStageBRead(JSON.stringify({read:[{...target,level:'raw',content:'injected'}]}),[target]),/fields/);
  assert.throws(()=>parseStageB(final([{action:'retain',draft:{meaning:'new',summary:'x'.repeat(321),anchors:[],view:'shared_episode',certainty:'explicit',reason:'',useWhen:'',avoidWhen:'',sourceRefs:[],parentRefs:[]}}]),[],[]));
});
