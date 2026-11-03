import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { HindsightBackend } from '../src/memory/hindsight.ts';
import type { SourceEvent } from '../src/contracts.ts';

const event: SourceEvent = { id: 'source-1', companionId: '小伴', sessionId: 'day-1', role: 'user', content: '我现在住杭州。', occurredAt: '2026-10-27T01:00:00Z', visibility: 'private' };
async function server(t: test.TestContext, handler: (req: IncomingMessage, res: ServerResponse, body: any) => void) {
  const app = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    handler(req, res, body);
  });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => { app.closeAllConnections(); app.close(); });
  const addr = app.address(); assert.ok(addr && typeof addr !== 'string');
  return `http://127.0.0.1:${addr.port}`;
}
function json(res: ServerResponse, value: unknown, status = 200) { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(value)); }

test('official SDK retains with stable document provenance and synchronous replacement', async t => {
  let calls = 0;
  const url = await server(t, (req, res, body) => {
    calls++; assert.equal(req.method, 'POST'); assert.match(req.url!, /^\/v1\/default\/banks\/companion-[a-f0-9]+\/memories$/);
    assert.equal(req.headers.authorization, 'Bearer test-key');
    assert.equal(body.async, false);
    assert.equal(body.items[0].document_id, event.id);
    assert.equal(body.items[0].content, event.content);
    assert.equal(body.items[0].update_mode, 'replace');
    assert.equal(body.items[0].metadata.source_role, 'user');
    assert.equal(body.items[0].metadata.session_id, event.sessionId);
    json(res, {success:true, bank_id:'test', items_count:1});
  });
  await new HindsightBackend({baseUrl:url,apiKey:'test-key'}).retain(event);
  assert.equal(calls, 1);
});

test('recall maps source ids, rejects unsupported or untraceable facts and caps backend budget', async t => {
  const url = await server(t, (_req, res, body) => {
    assert.equal(body.max_tokens, 800); assert.deepEqual(body.types, ['world', 'experience']);
    json(res, {results:[
      {id:'a',text:'用户住杭州',type:'world',document_id:'source-1'},
      {id:'b',text:'推演结果',type:'observation',document_id:'source-1'},
      {id:'c',text:'没有来源',type:'world'},
      {id:'d',text:'未知来源类型',type:'fiction',document_id:'source-1'}
    ]});
  });
  assert.deepEqual(await new HindsightBackend({baseUrl:url}).recall('小伴','住哪里',800),[
    {id:'a',text:'用户住杭州',type:'world',documentId:'source-1'}
  ]);
});

test('document deletion is idempotent on 404 but never swallows service errors', async t => {
  let count = 0;
  const url = await server(t, (req, res) => {
    assert.equal(req.method, 'DELETE'); assert.ok(req.url!.endsWith('/documents/source-1'));
    json(res, {detail:'sensitive backend payload'}, ++count === 1 ? 404 : 503);
  });
  const backend = new HindsightBackend({baseUrl:url});
  await backend.deleteDocument('小伴','source-1');
  await assert.rejects(backend.deleteDocument('小伴','source-1'), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /503/); assert.doesNotMatch(error.message,/sensitive/); return true;
  });
});

test('requests really abort on deadline and readiness fails closed', async t => {
  const url = await server(t, () => {});
  const backend = new HindsightBackend({baseUrl:url,timeoutMs:40});
  const start = Date.now();
  await assert.rejects(backend.retain(event), /timeout|failed/i);
  assert.ok(Date.now()-start < 1500);
  assert.equal(await backend.health(), false);
});

test('assistant text and group messages cannot be sent to private long-term memory', async t => {
  let calls = 0;
  const url = await server(t, (_req,res) => { calls++; json(res,{}); });
  const backend = new HindsightBackend({baseUrl:url});
  await assert.rejects(backend.retain({...event,role:'assistant'}), /source/i);
  await assert.rejects(backend.retain({...event,visibility:'group'}), /source/i);
  assert.equal(calls,0);
});

test('cooperative cancel success acknowledges the request without advertising worker quiescence',async t=>{
  const url=await server(t,(_req,res)=>json(res,{success:true,status:'cancelled'}));const backend=new HindsightBackend({baseUrl:url});
  assert.equal(await backend.cancelOperation(event.companionId,'d1109529-a84a-4401-a14d-736ce1fb62bd'),true);
  assert.equal(backend.cancellationGuarantee,'cooperative');
});

test('operation failure responses expose a stable code without persisting upstream input or credentials',async t=>{
  const canary='PRIVATE_SOURCE_AND_BEARER_CANARY';const url=await server(t,(_req,res)=>json(res,{status:'failed',error_message:canary}));
  const backend=new HindsightBackend({baseUrl:url});const status=await backend.operationStatus(event.companionId,'d1109529-a84a-4401-a14d-736ce1fb62bd');
  assert.deepEqual(status,{state:'failed',errorCode:'backend-failed'});assert.ok(!JSON.stringify(status).includes(canary));
});

test('P3: payload erasure deletes every completed child before its parent using the parent bank',async t=>{
  const parent='d1109529-a84a-4401-a14d-736ce1fb62bd',child1='c1109529-a84a-4401-a14d-736ce1fb62bd',child2='b1109529-a84a-4401-a14d-736ce1fb62bd';const payloads=new Map([[child1,'CHILD_PRIVATE_CANARY'],[child2,'CHILD_PRIVATE_CANARY']]);const deletes:string[]=[];
  const url=await server(t,(req,res)=>{assert.ok(req.url!.includes('/banks/material-family/'));if(req.method==='GET')return json(res,{operation_id:parent,status:'completed',child_operations:[...payloads.keys()].map(operation_id=>({operation_id,status:'completed'}))});const id=req.url!.split('/').at(-2)!;deletes.push(id);payloads.delete(id);json(res,{success:true});});
  const backend=new HindsightBackend({baseUrl:url,routing:{operation:(cid,id)=>id===parent?{kind:'location',location:{companionId:cid,id:'handle',bank:'material-family',bankKind:'companion',documentId:'memory',operationId:parent,source:null,memory:{memoryId:'memory',revision:1},indexState:'indexed',cleanupState:'pending'}}:null,legacyDocument:()=>false}});
  assert.equal(await backend.deleteOperationPayload(event.companionId,parent),true);assert.deepEqual(deletes,[child1,child2,parent]);assert.equal(payloads.size,0);
});

test('P3: a failed child deletion retains its parent so retry can discover remaining children',async t=>{
  const parent='d1109529-a84a-4401-a14d-736ce1fb62bd',first='c1109529-a84a-4401-a14d-736ce1fb62bd',second='b1109529-a84a-4401-a14d-736ce1fb62bd';const remaining=new Set([first,second]);let fail=true,parentPresent=true;const calls:string[]=[];
  const url=await server(t,(req,res)=>{if(req.method==='GET')return json(res,{operation_id:parent,status:'completed',child_operations:[...remaining].map(operation_id=>({operation_id,status:'completed'}))});const id=req.url!.split('/').at(-2)!;calls.push(id);if(id===second && fail)return json(res,{detail:'transient'},503);remaining.delete(id);if(id===parent)parentPresent=false;json(res,{success:true});});
  const backend=new HindsightBackend({baseUrl:url});await assert.rejects(backend.deleteOperationPayload(event.companionId,parent));assert.equal(parentPresent,true);assert.deepEqual([...remaining],[second]);fail=false;assert.equal(await backend.deleteOperationPayload(event.companionId,parent),true);assert.equal(parentPresent,false);assert.deepEqual(calls,[first,second,second,parent]);
});

for(const children of [undefined,null,{},[{operation_id:'invalid',status:'completed'}],[{operation_id:'D1109529-A84A-4401-A14D-736CE1FB62BD',status:'completed'}],[{operation_id:'c1109529-a84a-4401-a14d-736ce1fb62bd',status:'completed'},{operation_id:'C1109529-A84A-4401-A14D-736CE1FB62BD',status:'completed'}],[{operation_id:'c1109529-a84a-4401-a14d-736ce1fb62bd',status:'processing'}],[{operation_id:'c1109529-a84a-4401-a14d-736ce1fb62bd',status:'cancelled'}],[{operation_id:'c1109529-a84a-4401-a14d-736ce1fb62bd',status:'failed'}]])test('P3: missing or unproved child coverage refuses payload completion '+JSON.stringify(children),async t=>{
  let deletes=0;const parent='d1109529-a84a-4401-a14d-736ce1fb62bd';const url=await server(t,(req,res)=>{if(req.method==='GET')return json(res,{operation_id:parent,status:'completed',child_operations:children});deletes++;json(res,{success:true});});const backend=new HindsightBackend({baseUrl:url});await assert.rejects(backend.deleteOperationPayload(event.companionId,parent));assert.equal(deletes,0);
});

for(const status of [200,404])test(`P3: missing parent (${status}) cannot hide orphan children without local never-sent proof`,async t=>{
  const url=await server(t,(_req,res)=>json(res,{status:'not_found'},status));const backend=new HindsightBackend({baseUrl:url});await assert.rejects(backend.deleteOperationPayload(event.companionId,'d1109529-a84a-4401-a14d-736ce1fb62bd'));
  assert.equal(await backend.deleteOperationPayload(event.companionId,'d1109529-a84a-4401-a14d-736ce1fb62bd',{neverAttempted:true}),true);
});

test('U1: uppercase local parent routes by its original ID but every HTTP UUID path is canonical',async t=>{
  const parent='D1109529-A84A-4401-A14D-736CE1FB62BD',canonical=parent.toLowerCase(),child='c1109529-a84a-4401-a14d-736ce1fb62bd';let childPayload=true;const paths:string[]=[];const routed:string[]=[];
  const url=await server(t,(req,res)=>{paths.push(req.url!);const id=req.url!.split('/').at(-1)==='delete'?req.url!.split('/').at(-2)!:req.url!.split('/').at(-1)!;if(req.method==='GET')return json(res,{status:'completed',child_operations:id===canonical?[{operation_id:child,status:'completed'}]:[]});if(id===child)childPayload=false;json(res,{success:true});});
  const backend=new HindsightBackend({baseUrl:url,routing:{operation:(cid,id)=>{routed.push(id);return id===parent?{kind:'location',location:{companionId:cid,id:'handle',bank:'upper-bank',bankKind:'companion',documentId:'doc',operationId:parent,source:null,memory:{memoryId:'memory',revision:1},indexState:'indexed',cleanupState:'pending'}}:null;},legacyDocument:()=>false}});
  await backend.operationStatus(event.companionId,parent);await backend.cancelOperation(event.companionId,parent);assert.equal(await backend.deleteOperationPayload(event.companionId,parent),true);assert.equal(childPayload,false);assert.ok(routed.every(id=>id===parent));assert.ok(paths.every(path=>!/[A-F]/.test(path)));assert.ok(paths.every(path=>path.includes('/banks/upper-bank/')));
});

for(const parent of ['d1109529a84a4401a14d736ce1fb62bd','{d1109529-a84a-4401-a14d-736ce1fb62bd}','urn:uuid:d1109529-a84a-4401-a14d-736ce1fb62bd'])test('U1: unsupported UUID representation cannot prove empty children '+parent,async t=>{
  let calls=0;const url=await server(t,(_req,res)=>{calls++;json(res,{status:'completed',child_operations:[],success:true});});const backend=new HindsightBackend({baseUrl:url});await assert.rejects(backend.deleteOperationPayload(event.companionId,parent));assert.equal(calls,0);
});

for (const [label, extra] of [['temporary', { learning: 'temporary' }], ['roleplay', { contentMode: 'roleplay' }]] as const) {
  for (const mode of ['retain', 'submitRetain'] as const) {
    test(`A1: direct SDK ${mode} rejects ${label} before making any HTTP request`, async t => {
      let calls=0;
      const operationId='d1109529-a84a-4401-a14d-736ce1fb62bd';
      const url=await server(t, (_req,res,body)=>{
        calls++;
        json(res,{success:true,async:body.async,operation_id:operationId});
      });
      const backend=new HindsightBackend({baseUrl:url});
      const source={...event,...extra};
      await assert.rejects(mode==='retain' ? backend.retain(source) : backend.submitRetain(source,operationId), /source/i);
      assert.equal(calls,0);
    });
  }
}

test('A1: direct SDK sync and async retain preserve private user tool and quotation compatibility', async t => {
  const requests: {documentId:string;async:boolean}[]=[];
  const operationId='d1109529-a84a-4401-a14d-736ce1fb62bd';
  const url=await server(t, (_req,res,body)=>{
    requests.push({documentId:body.items[0].document_id,async:body.async});
    json(res,{success:true,async:body.async,operation_id:operationId});
  });
  const backend=new HindsightBackend({baseUrl:url});
  const sources: SourceEvent[]=[event,{...event,id:'tool',role:'tool',toolVerified:true},
    {...event,id:'real',contentMode:'real',learning:'enabled'},
    ...(['quotation','hypothetical','unknown'] as const).map(contentMode=>({...event,id:contentMode,contentMode})),
  ];
  for(const source of sources) { await backend.retain(source); await backend.submitRetain(source,operationId); }
  assert.deepEqual(requests,sources.flatMap(source=>[{documentId:source.id,async:false},{documentId:source.id,async:true}]));
});
