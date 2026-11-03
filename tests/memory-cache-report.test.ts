import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
const event=(type:string,data:unknown,time=0)=>({type,time,data});
const user=(text:string)=>event('user/message',{content:[{type:'text',text}]});
const answer=(input:number,read:number,output=10,time=1)=>event('assistant/message',{usage:{inputTokens:input,cacheReadTokens:read,cacheWriteTokens:0,outputTokens:output}},time);
async function api(){assert.ok(existsSync(new URL('../src/memory/cache-report.ts',import.meta.url)),'Cache report module must exist');return import('../src/memory/cache-report.ts');}

test('nested native seed copies are excluded while previous measured usage supports a labelled prefix estimate',async()=>{
  const {analyzeMemoryCache}=await api();
  const chat=[user('chat'),answer(20,80,10,1)];
  const a=[...chat,event('session/end-seed',{}),user('【后台记忆整理任务 A】\nnew-a'),answer(30,100,10,2)];
  const b=[...a,event('session/end-seed',{}),user('【后台记忆整理任务 B】\nnew-b'),answer(10,130,10,3)];
  const report=analyzeMemoryCache([chat,a,b]);
  assert.equal(report.calls.length,3);assert.equal(report.byStage['memory-a'].calls,1);assert.equal(report.byStage['memory-b'].calls,1);
  assert.equal(report.total.inputTokens,370);assert.equal(report.total.cacheReadTokens,310);assert.equal(report.total.uncachedInputTokens,60);
  assert.equal(report.calls[1]!.priorPrefixTokensEstimate,110);assert.equal(report.calls[1]!.prefixReuseRateEstimate,100/110);
  assert.match(report.estimateNote,/估算/);assert.equal(report.calls[0]!.priorPrefixTokensEstimate,null);
  assert.equal(report.calls[2]!.appendedTextChars,'【后台记忆整理任务 B】\nnew-b'.length);
  assert.ok(!JSON.stringify(report).includes('new-a'),'Reports never copy prompt text');
});

test('unknown cache counts remain unknown and cannot inflate the measured denominator',async()=>{
  const {analyzeMemoryCache}=await api();
  const report=analyzeMemoryCache([[user('chat'),event('assistant/message',{usage:{inputTokens:99,outputTokens:5}},1),answer(10,0,5,2)]]);
  assert.equal(report.total.calls,2);assert.equal(report.total.measuredCalls,1);assert.equal(report.total.hitRate,0);
  assert.equal(report.calls[0]!.cacheReadTokens,null);assert.equal(report.calls[0]!.inputTokens,99);
  assert.equal(report.calls[1]!.priorPrefixTokensEstimate,null);
});

test('tool continuations count newly appended payload once without repeating the latest user task size',async()=>{
  const {analyzeMemoryCache}=await api();
  const report=analyzeMemoryCache([[user('request'),answer(20,80),event('tool/result',{message:{content:[{type:'text',text:'raw-result'}]}}),answer(10,110,10,2)]]);
  assert.equal(report.calls[0]!.appendedTextChars,7);assert.equal(report.calls[1]!.appendedTextChars,10);
  assert.equal(report.calls[1]!.priorPrefixTokensEstimate,110);
});
