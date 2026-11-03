import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { StateStore } from '../src/state/store.ts';
import { HindsightBackend, bankId } from '../src/memory/hindsight.ts';
import { ForgetLifecycle } from '../src/memory/lifecycle.ts';
import { OperationCoordinator, operationIdFor, retainPayloadHash } from '../src/memory/operations.ts';
import type { CompanionMemoryDraft, CompanionMemoryPlan, CompanionMemoryRevisionRef } from '../src/memory/companion-types.ts';

const cid = 'material-companion';
const source = (id: string) => ({ id, companionId: cid, sessionId: 'session', role: 'user' as const, visibility: 'private' as const, content: 'RAW PRIVATE UNREVIEWED SOURCE ' + id, occurredAt: '2026-10-28T01:00:00Z' });
const draft = (id: string): CompanionMemoryDraft => ({ summary: 'Enjoys tea.', meaning: 'Detailed refined interpretation: Enjoys tea.', anchors: ['tea'], view: 'user_understanding', certainty: 'explicit', reason: 'Approved interpretation.', useWhen: 'Choosing a drink.', avoidWhen: 'Unrelated.', sourceRefs: [{ eventId: id, sourceRevision: 1 }], parentRefs: [] });
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'material-index-')); const path = join(dir, 'state.sqlite');
  const connections: {close(): void}[] = [];
  const open = () => { const s = new StateStore(path); connections.push(s); return s; };
  const store = open(); store.ensureCompanion({ id: cid, name: 'Mira', anchors: {} });
  const sql = () => { const d = new Database(path); connections.push(d); return d; };
  t.after(() => { for (const c of connections) c.close(); rmSync(dir, { recursive: true, force: true }); });
  const plan = (operations: CompanionMemoryPlan['operations']) => ({ planId: randomUUID(), companionId: cid, expectedEpoch: store.currentEpoch(cid), reviewedSources: [], operations });
  const retain = (id: string) => { store.stageEvent(source(id)); return store.companionMemory.applyPlan(plan([{action:'retain',draft:draft(id)}])).memories[0]!; };
  return {store,open,sql,plan,retain};
}
function json(res: ServerResponse, value: unknown, status = 200) { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(value)); }
async function server(t: test.TestContext, handler: (req: IncomingMessage, res: ServerResponse, body: any) => void | Promise<void>) {
  const app = createServer(async (req,res) => { const chunks: Buffer[] = []; for await(const c of req) chunks.push(c); await handler(req,res,chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null); });
  app.listen(0,'127.0.0.1'); await once(app,'listening');
  t.after(() => { app.closeAllConnections(); app.close(); });
  const address = app.address(); assert.ok(address && typeof address !== 'string'); return 'http://127.0.0.1:' + address.port;
}
function gate() { let release!: () => void; const promise = new Promise<void>(r => {release=r;}); return {promise,release}; }
const goodConfig = {retain_extraction_mode:'chunks', enable_observations:false, retain_default_strategy:null};

test('material preparation is atomic, restart idempotent and has no fake source event', async t => {
  const {store,open,retain,sql} = fixture(t); const ref = retain('approved'); store.stageEvent(source('pending'));
  assert.equal(typeof (store as any).prepareMaterialOperation, 'function', 'atomic material preparation is required');
  const {MemoryMaterialIndex} = await import('../src/memory/material-index.ts');
  const index = new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:'http://127.0.0.1:1'}));
  const [op] = index.ensurePending(cid); assert.ok(op);
  const peer = open(); const restarted = new MemoryMaterialIndex(peer,new HindsightBackend({baseUrl:'http://127.0.0.1:1'}));
  assert.deepEqual(restarted.ensurePending(cid), [op]);
  const location = store.companionMemory.getIndexLocation(cid,op.documentId)!;
  assert.deepEqual(location.memory,ref); assert.equal(location.operationId,op.operationId); assert.equal(store.getEvent(cid,op.documentId),null);
  assert.equal(op.operationId,operationIdFor(cid,location.id,ref.revision,op.payloadHash!));
  assert.equal((sql().prepare('SELECT COUNT(*) AS n FROM events').get() as {n:number}).n,2);
  const hash = op.payloadHash; store.companionMemory.pinMemory(cid,ref,true); store.companionMemory.recordRetrieved(cid,[ref]); store.companionMemory.recordPresented(cid,[ref]);
  assert.equal(index.ensurePending(cid)[0]!.payloadHash,hash);
});

test('official SDK posts only selected immutable materials, checks resolved config and never adopts pending legacy rows', async t => {
  const {store,retain} = fixture(t); retain('approved'); store.stageEvent(source('pending'));
  for(let i=0;i<105;i++) { const e=source('legacy-'+i); store.ingest(e); const hash=retainPayloadHash(e); store.prepareOperation(cid,{documentId:e.id,sourceRevision:1,payloadHash:hash,operationId:operationIdFor(cid,e.id,1,hash)}); }
  const calls: {method:string;url:string;body:any}[]=[];
  const url=await server(t,(req,res,body) => { calls.push({method:req.method!,url:req.url!,body}); if(req.url!.endsWith('/config')) return json(res,{bank_id:'material',config:goodConfig,overrides:{}}); if(req.method==='POST') return json(res,{success:true,async:true,operation_id:body.operation_id}); return json(res,{status:'completed',child_operations:[]}); });
  const {MemoryMaterialIndex, materialBankId}=await import('../src/memory/material-index.ts'); const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));
  const result=await index.maintain(cid); assert.equal(result.submit.submitted,1);
  const posts=calls.filter(c=>c.method==='POST'); assert.equal(posts.length,1); const post=posts[0]!;
  assert.ok(post.url.includes(materialBankId(cid))); assert.equal(post.body.async,true); assert.equal(post.body.items[0].update_mode,'replace'); assert.equal('strategy' in post.body,false); assert.equal('strategy' in post.body.items[0],false);
  assert.equal(post.body.items[0].content,'Enjoys tea.'); assert.doesNotMatch(JSON.stringify(post.body),/RAW PRIVATE|pending|source_role|lastRetrieved|lastPresented|pinned/);
});

for(const config of [{}, {...goodConfig,retain_extraction_mode:'concise'}, {...goodConfig,enable_observations:true}, {...goodConfig,retain_default_strategy:'legacy'}]) test('unknown or incompatible config prevents material POST: '+JSON.stringify(config),async t=>{
  const {store,retain}=fixture(t);retain('a');let posts=0;
  const url=await server(t,(req,res)=>{if(req.method==='POST')posts++; json(res,{bank_id:'x',config,overrides:{}});});
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));
  await index.maintain(cid);assert.equal(posts,0);
});

test('claim revalidates source and payload within its SQLite transaction across connections',async t=>{
  const {store,open,retain,sql}=fixture(t);retain('a');const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');
  const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:'http://127.0.0.1:1'}));const [op]=index.ensurePending(cid);assert.ok(op);
  const peer=open(); peer.forgetEvents(cid,['a'],'erase');
  assert.equal(store.claimOperationSubmission(cid,op.operationId,10,()=>index.documentPort.allowed(op)),null);
  assert.equal(store.getOperation(cid,op.operationId)?.attempts,0);
  assert.equal(store.companionMemory.getIndexLocation(cid,op.documentId)?.cleanupState,'pending');
  assert.equal(store.getOperation(cid,op.operationId)?.state,'cleanup_pending');
  assert.equal((sql().prepare('SELECT COUNT(*) AS n FROM backend_operations').get() as {n:number}).n,1);
});

test('summary retrieval accepts only semantic matches above the floor and never fills to 24',async t=>{
  const {store,retain}=fixture(t);for(let i=0;i<30;i++)retain('relevant-'+i);
  let documents:string[]=[],allStrong=false;
  const url=await server(t,(_req,res,body)=>{
    assert.equal(body.min_scores?.semantic,.6);
    json(res,{results:documents.map((documentId,i)=>({id:String(i),document_id:documentId,type:'world',text:'UNTRUSTED',
      scores:{final:1,semantic:allStrong?.9:i===0?.9:i===1?.6:i===2?.59:null}}))});
  });
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));
  for(const op of index.ensurePending(cid)){
    documents.push(store.companionMemory.getIndexLocation(cid,op.documentId)!.documentId);
    store.updateOperation(cid,op.operationId,{state:'completed',completedAt:1});store.companionMemory.updateIndexLocation(cid,op.documentId,{indexState:'indexed'});
  }
  const hits=await index.recall(cid,'query',10000,{minimumSimilarity:.6,limit:24});
  assert.equal(hits.length,2);assert.deepEqual(hits.map(h=>h.similarity),[.9,.6]);
  allStrong=true;assert.equal((await index.recall(cid,'query',10000,{minimumSimilarity:.6,limit:100})).length,24);
});

test('recall maps bank/document to local memory, deduplicates and rejects forged metadata and remote text',async t=>{
  const {store,retain}=fixture(t);const ref=retain('a');let documentId='';
  const url=await server(t,(req,res,body)=>{assert.equal(body.max_tokens,400);assert.equal(body.include.entities,null);assert.equal('limit' in body,false);assert.equal('metadataFilter' in body,false);json(res,{results:[{id:'1',document_id:documentId,text:'REMOTE INJECTED',type:'world',scores:{semantic:.85,final:.95},metadata:{memory_id:'forged'}},{id:'2',document_id:documentId,text:'duplicate',type:'world',scores:{semantic:.85,final:.95}},{id:'3',document_id:'unknown',text:'forged',type:'world',scores:{semantic:.85,final:.95},metadata:{memory_id:ref.memoryId}}]});});
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));const [op]=index.ensurePending(cid);documentId=store.companionMemory.getIndexLocation(cid,op!.documentId)!.documentId;
  store.updateOperation(cid,op!.operationId,{state:'completed',completedAt:1});store.companionMemory.updateIndexLocation(cid,op!.documentId,{indexState:'indexed'});
  const hits=await index.recall(cid,'tea',400);assert.equal(hits.length,1);assert.equal(hits[0]!.memory.memoryId,ref.memoryId);assert.equal(hits[0]!.memory.revision,ref.revision);assert.match(hits[0]!.text,/Enjoys tea/);assert.doesNotMatch(hits[0]!.text,/REMOTE|INJECTED/);
});

for(const change of ['erase','epoch','revision'] as const) test('in-flight recall rejects changed '+change,async t=>{
  const {store,retain,open,plan}=fixture(t);const ref=retain('a');const waiting=gate(),release=gate();let documentId='';
  const url=await server(t,async(_req,res)=>{waiting.release();await release.promise;json(res,{results:[{id:'1',document_id:documentId,text:'old',type:'world',scores:{semantic:.85,final:.95}}]});});
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));const [op]=index.ensurePending(cid);documentId=store.companionMemory.getIndexLocation(cid,op!.documentId)!.documentId;
  store.updateOperation(cid,op!.operationId,{state:'completed',completedAt:1});store.companionMemory.updateIndexLocation(cid,op!.documentId,{indexState:'indexed'});
  const pending=index.recall(cid,'tea',400);await waiting.promise;const peer=open();if(change==='erase')peer.forgetEvents(cid,['a'],'erase');else if(change==='epoch')peer.bumpEpoch(cid);else peer.companionMemory.applyPlan(plan([{action:'condense',target:ref,draft:{...draft('a'),sourceRefs:[],meaning:'New meaning.'}}]));release.release();assert.deepEqual(await pending,[]);
});

test('forget expands all source revisions, historical DAG locations and both banks before declaring done',async t=>{
  const {store,retain,plan,sql}=fixture(t);const first=retain('a');
  const child=store.companionMemory.applyPlan(plan([{action:'condense',target:first,draft:{...draft('a'),sourceRefs:[],meaning:'Condensed tea.'}}])).memories[0]!;
  const locations=[store.companionMemory.registerIndexLocation(cid,{bank:'old-a',bankKind:'legacy',documentId:'same-doc',source:{eventId:'a',sourceRevision:1}}),
    store.companionMemory.registerIndexLocation(cid,{bank:'new-b',bankKind:'companion',documentId:'same-doc',memory:first}),
    store.companionMemory.registerIndexLocation(cid,{bank:'new-c',bankKind:'companion',documentId:'history',memory:child})];
  sql().prepare('UPDATE event_metadata SET revision=2 WHERE companion_id=? AND event_id=?').run(cid,'a');
  locations.push(store.companionMemory.registerIndexLocation(cid,{bank:'old-rev2',bankKind:'legacy',documentId:'rev2',source:{eventId:'a',sourceRevision:2}}));
  const deleted:string[]=[];
  const url=await server(t,(req,res)=>{assert.equal(req.method,'DELETE');deleted.push(req.url!);json(res,{success:true});});
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));
  const outcome=store.forgetEvents(cid,['a'],'erase');const receipt=await index.lifecycle.advance(outcome.requestId);
  assert.equal(receipt.backend,'done');assert.equal(receipt.operationPayloads,'done');
  assert.equal(deleted.length,5);for(const location of locations){assert.ok(deleted.includes('/v1/default/banks/'+location.bank+'/documents/'+location.documentId));assert.equal(store.companionMemory.getIndexLocation(cid,location.id)?.cleanupState,'done');}
});

test('known operations route status cancellation payload and explicit deletion by bank despite same remote document ID',async t=>{
  const {store,retain}=fixture(t);const ref=retain('a');const calls:string[]=[];
  for(const [bank,id] of [['bank-a',randomUUID()],['bank-b',randomUUID()]] as const){const l=store.companionMemory.registerIndexLocation(cid,{bank,bankKind:'companion',documentId:'same',memory:ref,operationId:id});store.prepareOperation(cid,{documentId:l.id,sourceRevision:1,payloadHash:'known',operationId:id});store.updateOperation(cid,id,{state:'completed',submittedAt:1,completedAt:2});}
  const url=await server(t,(req,res)=>{calls.push(req.method+' '+req.url);json(res,req.method==='GET'?{status:'completed',child_operations:[]}:{success:true});});
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const backend=new HindsightBackend({baseUrl:url});new MemoryMaterialIndex(store,backend);
  for(const l of store.companionMemory.listIndexLocations(cid)){await backend.operationStatus(cid,l.operationId!);await backend.cancelOperation(cid,l.operationId!);await backend.deleteOperationPayload(cid,l.operationId!);await backend.deleteLocatedDocument(l);}
  for(const bank of ['bank-a','bank-b'])assert.equal(calls.filter(c=>c.includes('/banks/'+bank+'/')).length,5);
  const before=calls.length;await assert.rejects(backend.operationStatus(cid,randomUUID()),/route/);await assert.rejects(backend.deleteDocument(cid,randomUUID()),/route/);assert.equal(calls.length,before);
});

test('a late location reopens completed source erasure and stale done patches cannot hide it',async t=>{
  const {store,retain}=fixture(t);const ref=retain('a');const url=await server(t,(_req,res)=>json(res,{success:true}));
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));const o=store.forgetEvents(cid,['a'],'erase');
  assert.equal((await index.lifecycle.advance(o.requestId)).backend,'done');
  const late=store.companionMemory.registerIndexLocation(cid,{bank:'late-bank',bankKind:'companion',documentId:'late',memory:ref});
  assert.equal(store.forgetReceipt(o.requestId).backend,'pending');
  store.updateForgetRequest(o.requestId,{backend:'done',operationPayloads:'done'});
  assert.notEqual(store.forgetReceipt(o.requestId).backend,'done');
  assert.equal((await index.lifecycle.advance(o.requestId)).backend,'done');assert.equal(store.companionMemory.getIndexLocation(cid,late.id)?.cleanupState,'done');
});

test('remote operation discovered without local attempted proof cannot become never-attempted erasure',async t=>{
  const {store,retain}=fixture(t);const ref=retain('a');const remoteId=randomUUID();const l=store.companionMemory.registerIndexLocation(cid,{bank:'external',bankKind:'companion',documentId:'remote',operationId:remoteId,memory:ref});
  const url=await server(t,(req,res)=>json(res,req.method==='GET'?{status:'not_found'}:{success:true},req.method==='GET'?404:200));
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));const o=store.forgetEvents(cid,['a'],'erase');const receipt=await index.lifecycle.advance(o.requestId);
  assert.notEqual(receipt.backend,'done');assert.notEqual(receipt.operationPayloads,'done');const op=store.getOperation(cid,remoteId);assert.ok(op);assert.ok(op.attempts>0);assert.notEqual(op.state,'erased');assert.notEqual(store.companionMemory.getIndexLocation(cid,l.id)?.cleanupState,'done');
});

for(const outcome of ['late-success','timeout'] as const)test('forget during material POST waits for '+outcome+' settlement and final document DELETE',async t=>{
  const {store,retain}=fixture(t);retain('a');const arrived=gate(),release=gate();const calls:string[]=[];let status='processing';let payloadFailure=true;
  const url=await server(t,async(req,res,body)=>{
    calls.push(req.method+' '+req.url);
    if(req.url!.endsWith('/config'))return json(res,{bank_id:'x',config:goodConfig});
    if(req.method==='POST'){arrived.release();await release.promise;status='completed';if(outcome==='timeout'){req.socket.destroy();return;}return json(res,{success:true,async:true,operation_id:body.operation_id});}
    if(req.method==='GET')return json(res,{status,child_operations:[]});
    if(req.url!.includes('/operations/') && req.method==='DELETE' && payloadFailure)return json(res,{detail:'unavailable'},503);
    if(req.url!.endsWith('/cancel'))return json(res,{detail:'completed'},409);
    return json(res,{success:true});
  });
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));const [op]=index.ensurePending(cid);assert.ok(op);const submission=index.coordinator.submitPending(cid,100);
  await arrived.promise;const request=store.forgetEvents(cid,['a'],'erase');const before=await index.lifecycle.advance(request.requestId);assert.notEqual(before.backend,'done');assert.notEqual(before.operationPayloads,'done');assert.ok(!calls.some(c=>c.includes('/documents/')));
  release.release();await submission;const failed=await index.lifecycle.advance(request.requestId);assert.notEqual(failed.operationPayloads,'done');
  payloadFailure=false;const final=await index.lifecycle.advance(request.requestId);assert.equal(final.backend,'done');assert.equal(final.operationPayloads,'done');assert.equal(store.getOperation(cid,op.operationId)?.state,'erased');
  const last=calls.at(-1)!;assert.ok(last.includes('/documents/'));const location=store.companionMemory.getIndexLocation(cid,op.documentId)!;assert.ok(calls.some(c=>c==='DELETE /v1/default/banks/'+location.bank+'/documents/'+location.documentId));
});

test('old backend without explicit location deletion capability reports blocked',async t=>{
  const {store,retain}=fixture(t);const ref=retain('a');store.companionMemory.registerIndexLocation(cid,{bank:'new',bankKind:'companion',documentId:'doc',memory:ref});
  const backend={retain:async()=>{},recall:async()=>[],deleteDocument:async()=>{},health:async()=>true,submitRetain:async(_e:unknown,id:string)=>({operationId:id,state:'submitted' as const}),operationStatus:async()=>({state:'completed' as const}),cancelOperation:async()=>true,deleteOperationPayload:async()=>true};
  const request=store.forgetEvents(cid,['a'],'erase');const receipt=await new ForgetLifecycle(store,backend).advance(request.requestId);assert.equal(receipt.backend,'blocked');
});

test('legacy rollback requires the current deletion watermark and all known tombstones applied',async t=>{
  const {store,retain}=fixture(t);retain('a');const url=await server(t,(_req,res)=>json(res,{success:true}));const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));
  const before=index.verifyLegacyRollback(cid);store.stageEvent(source('append'));const appended=index.verifyLegacyRollback(cid);assert.equal(appended.deletionWatermark,before.deletionWatermark);assert.ok(appended.stateEpoch>before.stateEpoch);
  const request=store.forgetEvents(cid,['a'],'erase');assert.throws(()=>index.verifyLegacyRollback(cid),/tombstone|cleanup/);await index.lifecycle.advance(request.requestId);const fence=index.verifyLegacyRollback(cid);assert.ok(fence.deletionWatermark>before.deletionWatermark);assert.deepEqual(fence,store.memoryFence(cid));
});

test('first material bank is created only in the app namespace with chunks and observations disabled, then config is rechecked',async t=>{
  const {store,retain}=fixture(t);retain('a');let created=false;const calls:string[]=[];
  const url=await server(t,(req,res,body)=>{calls.push(req.method+' '+req.url);if(req.url!.endsWith('/config'))return json(res,created?{bank_id:'new',config:goodConfig}:{detail:'missing'},created?200:404);
    if(req.method==='PUT'){assert.equal(body.retain_extraction_mode,'chunks');assert.equal(body.enable_observations,false);created=true;return json(res,{bank_id:'new'});}
    if(req.method==='POST')return json(res,{success:true,async:true,operation_id:body.operation_id});json(res,{status:'completed',child_operations:[]});
  });
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));const result=await index.maintain(cid);assert.equal(result.submit.submitted,1);assert.deepEqual(calls.map(s=>s.split(' ')[0]),['GET','PUT','GET','POST']);
});

test('forget before material POST during config await prevents the write and preserves never-attempted proof',async t=>{
  const {store,retain}=fixture(t);retain('a');const arrived=gate(),release=gate();let posts=0;
  const url=await server(t,async(req,res,body)=>{if(req.url!.endsWith('/config')){arrived.release();await release.promise;return json(res,{bank_id:'x',config:goodConfig});}if(req.method==='POST'){posts++;return json(res,{success:true,async:true,operation_id:body.operation_id});}if(req.url!.endsWith('/cancel'))return json(res,{},404);if(req.method==='GET')return json(res,{},404);json(res,{success:true});});
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));const [op]=index.ensurePending(cid);const submission=index.coordinator.submitPending(cid,100);await arrived.promise;const request=store.forgetEvents(cid,['a'],'erase');release.release();await submission;
  const receipt=await index.lifecycle.advance(request.requestId);assert.equal(posts,0);assert.equal(receipt.operationPayloads,'done');assert.equal(receipt.backend,'done');assert.equal(store.getOperation(cid,op!.operationId)?.state,'erased');
});

test('two material workers share one atomic claim and restart preserves an abandoned owner without replay',async t=>{
  const {store,open,retain}=fixture(t);retain('a');const arrived=gate(),release=gate();let posts=0;
  const url=await server(t,async(req,res,body)=>{if(req.url!.endsWith('/config'))return json(res,{bank_id:'x',config:goodConfig});if(req.method==='POST'){posts++;arrived.release();await release.promise;return json(res,{success:true,async:true,operation_id:body.operation_id});}json(res,{status:'completed',child_operations:[]});});
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const one=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));const peer=open();const two=new MemoryMaterialIndex(peer,new HindsightBackend({baseUrl:url}));const [op]=one.ensurePending(cid);const submitted=one.coordinator.submitPending(cid,100);await arrived.promise;
  assert.equal((await two.coordinator.submitPending(cid,100)).submitted,0);release.release();await submitted;assert.equal(posts,1);assert.equal(peer.getOperation(cid,op!.operationId)?.state,'submitted');
  const second=retain('b');const other=one.ensurePending(cid).find(o=>store.companionMemory.getIndexLocation(cid,o.documentId)?.memory?.memoryId===second.memoryId)!;
  const claim=store.claimOperationSubmission(cid,other.operationId,200,o=>one.documentPort.allowed(o));assert.ok(claim);
  const resumed=new MemoryMaterialIndex(open(),new HindsightBackend({baseUrl:url}));assert.equal((await resumed.coordinator.submitPending(cid,claim.operation.nextCheckAt)).submitted,0);await resumed.coordinator.pollDue(claim.operation.nextCheckAt);assert.equal(posts,1);assert.equal(store.getOperation(cid,other.operationId)?.operationId,other.operationId);assert.equal(store.getOperation(cid,other.operationId)?.errorCode,claim.token);
});

test('source suppression keeps material body and remote document while recall becomes unavailable',async t=>{
  const {store,retain}=fixture(t);const ref=retain('a');let doc='';let deletes=0;const url=await server(t,(req,res)=>{if(req.method==='DELETE')deletes++;json(res,{results:[{id:'h',document_id:doc,text:'old',type:'world',scores:{semantic:.85,final:.95}}]});});
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));const [op]=index.ensurePending(cid);doc=store.companionMemory.getIndexLocation(cid,op!.documentId)!.documentId;store.updateOperation(cid,op!.operationId,{state:'completed',completedAt:1});store.companionMemory.updateIndexLocation(cid,op!.documentId,{indexState:'indexed'});
  const request=store.forgetEvents(cid,['a'],'suppress');await index.lifecycle.advance(request.requestId);assert.deepEqual(await index.recall(cid,'tea',200),[]);assert.equal(store.companionMemory.getMemory(cid,ref)?.meaning,'Detailed refined interpretation: Enjoys tea.');assert.equal(deletes,0);
});

test('late registration during a final DELETE reopens cleanup and unproven external submission stays blocked',async t=>{
  const {store,retain}=fixture(t);const ref=retain('a');const deleting=gate(),release=gate();let completed=false;const remoteOp=randomUUID();const calls:string[]=[];let first=true;
  const url=await server(t,async(req,res)=>{calls.push(req.method+' '+req.url);if(req.url!.includes('/documents/a') && first){first=false;deleting.release();await release.promise;}
    if(req.method==='GET')return json(res,{status:completed?'completed':'processing',child_operations:[]});if(req.url!.endsWith('/cancel'))return json(res,{},409);return json(res,{success:true});});
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));const request=store.forgetEvents(cid,['a'],'erase');const advancing=index.lifecycle.advance(request.requestId);await deleting.promise;
  const late=store.companionMemory.registerIndexLocation(cid,{bank:'late',bankKind:'companion',documentId:'late-doc',memory:ref,operationId:remoteOp});release.release();const before=await advancing;
  assert.notEqual(before.backend,'done');assert.notEqual(before.operationPayloads,'done');assert.ok(!calls.some(c=>c.includes('/documents/late-doc')));
  completed=true;const receipt=await index.lifecycle.advance(request.requestId);assert.equal(receipt.backend,'blocked');assert.equal(receipt.operationPayloads,'blocked');assert.equal(store.companionMemory.getIndexLocation(cid,late.id)?.cleanupState,'blocked');
});

test('a location handle equal to an event ID never crosses the explicit legacy/location namespaces',async t=>{
  const {store,retain}=fixture(t);const ref=retain('a');const l=store.companionMemory.registerIndexLocation(cid,{bank:'material-other',bankKind:'companion',documentId:'material-document',memory:ref});store.ingest(source(l.id));
  const paths:string[]=[];const url=await server(t,(req,res)=>{paths.push(req.url!);json(res,{success:true});});
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const backend=new HindsightBackend({baseUrl:url});new MemoryMaterialIndex(store,backend);
  await backend.deleteDocument(cid,l.id);await backend.deleteLocatedDocument(l);assert.deepEqual(paths,['/v1/default/banks/'+bankId(cid)+'/documents/'+l.id,'/v1/default/banks/material-other/documents/material-document']);
});

test('binding a newly discovered operation to an already erased location reopens its receipt',async t=>{
  const {store,retain}=fixture(t);const ref=retain('a');const l=store.companionMemory.registerIndexLocation(cid,{bank:'external',bankKind:'companion',documentId:'doc',memory:ref});const url=await server(t,(_req,res)=>json(res,{success:true}));
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));const request=store.forgetEvents(cid,['a'],'erase');assert.equal((await index.lifecycle.advance(request.requestId)).backend,'done');
  store.companionMemory.updateIndexLocation(cid,l.id,{operationId:randomUUID()});assert.equal(store.forgetReceipt(request.requestId).backend,'blocked');assert.equal(store.forgetReceipt(request.requestId).operationPayloads,'blocked');assert.equal(store.companionMemory.getIndexLocation(cid,l.id)?.cleanupState,'blocked');
});

test('cancelling an active material does not make repeated maintain conflict with an erased operation hash',async t=>{
  const {store,retain}=fixture(t);retain('a');const url=await server(t,(req,res)=>json(res,req.url!.endsWith('/config')?{config:goodConfig}:req.method==='GET'?{status:'completed',child_operations:[]}:{success:true}));
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));const [op]=index.ensurePending(cid);index.coordinator.cancel(cid,op!.operationId);await index.coordinator.cleanupDue();assert.equal(store.getOperation(cid,op!.operationId)?.state,'erased');await index.maintain(cid);assert.deepEqual(index.ensurePending(cid),[]);
});

test('forgetting a legacy event whose ID equals an unrelated material handle does not revoke the material operation',async t=>{
  const {store,retain}=fixture(t);retain('a');const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:'http://127.0.0.1:1'}));const [material]=index.ensurePending(cid);assert.ok(material);
  const raw={...source(material.documentId),revision:2};store.ingest(raw);const hash=retainPayloadHash(raw);const legacy=store.prepareOperation(cid,{documentId:raw.id,sourceRevision:2,payloadHash:hash,operationId:operationIdFor(cid,raw.id,2,hash)});
  assert.ok(store.claimOperationSubmission(cid,legacy.operationId,100));
  const request=store.forgetEvents(cid,[raw.id],'erase');assert.equal(store.getOperation(cid,material.operationId)?.state,'pending');assert.equal(store.getOperation(cid,legacy.operationId)?.state,'cleanup_pending');assert.ok(!store.operationsForForget(cid,[raw.id]).some(o=>o.operationId===material.operationId));assert.equal(store.forgetRequest(request.requestId)?.backend,'pending');
});

test('rollback refuses unclean operation payloads even when legacy source erasure had no receipt',async t=>{
  const {store}=fixture(t);const e=source('legacy');store.ingest(e);const hash=retainPayloadHash(e);const op=store.prepareOperation(cid,{documentId:e.id,sourceRevision:1,payloadHash:hash});store.updateOperation(cid,op.operationId,{state:'failed',attempts:1});store.forgetEvent(cid,[e.id][0]!);store.acknowledgeForgetDocumentDeletion(cid,e.id);
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:'http://127.0.0.1:1'}));assert.throws(()=>index.verifyLegacyRollback(cid),/cleanup|tombstone/);
});

test('an unproven external operation bound during its location DELETE cannot inherit full-family proof',async t=>{
  const {store,retain}=fixture(t);const ref=retain('a');const l=store.companionMemory.registerIndexLocation(cid,{bank:'late-bind',bankKind:'companion',documentId:'doc',memory:ref});const deleting=gate(),release=gate();let deletes=0;let first=true;
  const url=await server(t,async(req,res)=>{if(req.url!.includes('/documents/doc')){deletes++;if(first){first=false;deleting.release();await release.promise;}}json(res,req.method==='GET'?{status:'completed',child_operations:[]}:{success:true});});
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));const request=store.forgetEvents(cid,['a'],'erase');const pending=index.lifecycle.advance(request.requestId);await deleting.promise;store.companionMemory.updateIndexLocation(cid,l.id,{operationId:randomUUID()});release.release();const before=await pending;
  assert.notEqual(before.backend,'done');assert.notEqual(store.companionMemory.getIndexLocation(cid,l.id)?.cleanupState,'done');const receipt=await index.lifecycle.advance(request.requestId);assert.equal(receipt.backend,'blocked');assert.equal(receipt.operationPayloads,'blocked');assert.equal(deletes,1);
});

test('legacy and registered aliases of the same bank/document are deleted once',async t=>{
  const {store,retain}=fixture(t);retain('a');const l=store.companionMemory.registerIndexLocation(cid,{bank:bankId(cid),bankKind:'legacy',documentId:'a',source:{eventId:'a',sourceRevision:1}});let deletes=0;const url=await server(t,(_req,res)=>{deletes++;json(res,{success:true});});
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));const request=store.forgetEvents(cid,['a'],'erase');assert.equal((await index.lifecycle.advance(request.requestId)).backend,'done');assert.equal(deletes,1);assert.equal(store.companionMemory.getIndexLocation(cid,l.id)?.cleanupState,'done');
});

test('a material revision replaced during POST is rechecked after HTTP and never becomes an indexed current fact',async t=>{
  const {store,retain,plan}=fixture(t);const ref=retain('a');const arrived=gate(),release=gate();const url=await server(t,async(req,res,body)=>{if(req.url!.endsWith('/config'))return json(res,{config:goodConfig});if(req.method==='POST'){arrived.release();await release.promise;return json(res,{success:true,async:true,operation_id:body.operation_id});}json(res,{status:'completed',success:true,child_operations:[]});});
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));const [op]=index.ensurePending(cid);const pending=index.coordinator.submitPending(cid,100);await arrived.promise;store.companionMemory.applyPlan(plan([{action:'condense',target:ref,draft:{...draft('a'),sourceRefs:[],meaning:'Current revision.'}}]));release.release();await pending;
  assert.equal(store.getOperation(cid,op!.operationId)?.state,'cleanup_pending');assert.equal(index.documentPort.read(store.getOperation(cid,op!.operationId)!),null);assert.notEqual(store.companionMemory.getIndexLocation(cid,op!.documentId)?.indexState,'indexed');
});

for(const mode of ['material','legacy'] as const)for(const arrival of ['live-claim','timeout'] as const)test(`R1: ${mode} ${arrival} never replays an uncertain POST after the lease deadline`,async t=>{
  const {store,open,retain}=fixture(t);if(mode==='material')retain('a');else store.ingest(source('a'));
  const arrived=gate(),release=gate(),written=gate();let posts=0,record=false,document=false,deletes=0;
  const url=await server(t,async(req,res,body)=>{
    if(req.url!.endsWith('/config'))return json(res,{config:goodConfig});
    if(req.method==='POST'){
      if(++posts===1){arrived.release();await release.promise;}
      if(!record){record=true;document=true;}
      written.release();if(!res.destroyed)json(res,{success:true,async:true,operation_id:body.operation_id});return;
    }
    if(req.method==='GET')return json(res,record?{status:'completed',child_operations:[]}:{detail:'missing'},record?200:404);
    deletes++;if(req.url!.endsWith('/delete'))record=false;else if(req.url!.includes('/documents/'))document=false;json(res,{success:true});
  });
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const backend=new HindsightBackend({baseUrl:url,timeoutMs:arrival==='timeout'?120:30000});
  const index=mode==='material'?new MemoryMaterialIndex(store,backend):null;
  const prepared=index?.ensurePending(cid)[0] ?? store.prepareOperation(cid,{documentId:'a',sourceRevision:1,payloadHash:retainPayloadHash(source('a')),operationId:operationIdFor(cid,'a',1,retainPayloadHash(source('a')))});
  const first=index?.coordinator ?? new OperationCoordinator(store,backend);const peer=open();const peerBackend=new HindsightBackend({baseUrl:url});const second=mode==='material'?new MemoryMaterialIndex(peer,peerBackend).coordinator:new OperationCoordinator(peer,peerBackend);
  const sending=first.submitPending(cid,100);await arrived.promise;if(arrival==='timeout')await sending;const claim=store.getOperation(cid,prepared.operationId)!;
  await second.submitPending(cid,claim.nextCheckAt+1);const afterReplayAttempt=store.getOperation(cid,prepared.operationId)!;
  const request=store.forgetEvents(cid,['a'],'erase');const lifecycle=index?.lifecycle ?? new ForgetLifecycle(store,backend);const before=await lifecycle.advance(request.requestId);const prematureDeletes=deletes;
  release.release();await written.promise;await sending;
  assert.equal(posts,1,'an expired or timed-out claim cannot authorize another same-ID POST');
  if(arrival==='live-claim')assert.equal(afterReplayAttempt.errorCode,claim.errorCode,'the original still-flying owner must remain authoritative');
  assert.notEqual(before.backend,'done');assert.notEqual(before.operationPayloads,'done');assert.equal(prematureDeletes,0);assert.equal(document,true);
  const final=await lifecycle.advance(request.requestId);assert.equal(final.backend,'done');assert.equal(final.operationPayloads,'done');assert.equal(document,false);assert.equal(record,false);assert.equal(store.getOperation(cid,prepared.operationId)?.state,'erased');
});

test('R1: the public claim API rejects pending or unknown rows without explicit never-sent proof',t=>{
  const {store}=fixture(t);const e=source('guard');store.ingest(e);const operation=store.prepareOperation(cid,{documentId:e.id,sourceRevision:1,payloadHash:'approved'});
  for(const patch of [{state:'pending' as const,attempts:1,submittedAt:null,errorCode:null},{state:'pending' as const,attempts:0,submittedAt:1000,errorCode:null},{state:'unknown' as const,attempts:1,submittedAt:null,errorCode:null},{state:'unknown' as const,attempts:1,submittedAt:null,errorCode:'submit-claim:still-in-flight'}]){
    store.updateOperation(cid,operation.operationId,{...patch,nextCheckAt:0});assert.equal(store.claimOperationSubmission(cid,operation.operationId,86400000),null);
  }
});

test('R1: a material preflight proven not sent can retry with the same identity',async t=>{
  const {store,retain}=fixture(t);retain('a');let configAttempts=0,posts=0;
  const url=await server(t,(req,res,body)=>{if(req.url!.endsWith('/config'))return ++configAttempts===1?json(res,{},503):json(res,{config:goodConfig});posts++;json(res,{success:true,async:true,operation_id:body.operation_id});});
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}));const [operation]=index.ensurePending(cid);assert.equal((await index.coordinator.submitPending(cid,100)).unknown,1);const after=store.getOperation(cid,operation!.operationId)!;assert.equal(after.attempts,0);assert.equal(after.submittedAt,null);assert.ok(!after.errorCode?.startsWith('submit-claim:'));
  assert.equal((await index.coordinator.submitPending(cid,after.nextCheckAt)).submitted,1);assert.equal(posts,1);assert.equal(store.getOperation(cid,operation!.operationId)?.operationId,operation!.operationId);
});

test('R1: one uncertain material POST recovers by observing natural completion without another POST',async t=>{
  const {store,retain}=fixture(t);retain('a');let posts=0,now=100,documentId='';
  const url=await server(t,(req,res,body)=>{if(req.url!.endsWith('/config'))return json(res,{config:goodConfig});if(req.method==='POST' && req.url!.endsWith('/memories')){posts++;documentId=body.items[0].document_id;req.socket.destroy();return;}if(req.method==='GET')return json(res,{status:'completed',child_operations:[]});json(res,{results:[{id:'hit',text:'remote',type:'world',scores:{semantic:.85,final:.95},document_id:documentId}]});});
  const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:url}),{clock:()=>now});assert.equal((await index.maintain(cid)).submit.unknown,1);const [op]=index.ensurePending(cid);assert.ok(op);now=store.getOperation(cid,op.operationId)!.nextCheckAt;
  const result=await index.maintain(cid);assert.equal(posts,1);assert.equal(result.poll.completed,1);assert.equal(store.getOperation(cid,op.operationId)?.state,'completed');assert.equal((await index.recall(cid,'tea',300)).length,1);
});

test('N2: erasing a material does not adopt or erase an unrelated legacy operation whose event ID equals its handle',async t=>{
  const {store,retain}=fixture(t);retain('a');const {MemoryMaterialIndex}=await import('../src/memory/material-index.ts');const index=new MemoryMaterialIndex(store,new HindsightBackend({baseUrl:'http://127.0.0.1:1'}));const [material]=index.ensurePending(cid);assert.ok(material);
  const e={...source(material.documentId),revision:2};store.ingest(e);const legacy=store.prepareOperation(cid,{documentId:e.id,sourceRevision:2,payloadHash:retainPayloadHash(e),operationId:operationIdFor(cid,e.id,2,retainPayloadHash(e))});
  store.forgetEvents(cid,['a'],'erase');assert.equal(store.documentStatus(cid,e.id).source,'active');assert.equal(store.getOperation(cid,legacy.operationId)?.state,'pending');assert.deepEqual(store.operationsForForget(cid,['a']).map(o=>o.operationId),[material.operationId]);
});
