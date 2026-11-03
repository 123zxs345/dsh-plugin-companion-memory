import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
test('complete exchanges coalesce but continuous messages cannot move the review deadline forever',async()=>{
  assert.ok(existsSync(new URL('../src/memory/review-timing.ts',import.meta.url)),'Shared cache-aware review scheduler must exist');
  const {ReviewTiming}=await import('../src/memory/review-timing.ts');
  const schedule=new ReviewTiming();assert.equal(schedule.dueAt(15,60),null);
  schedule.complete(1000);assert.equal(schedule.dueAt(15,60),16000);
  for(let at=11000;at<=51000;at+=10000)schedule.complete(at);
  assert.equal(schedule.dueAt(15,60),61000);
  assert.equal(schedule.due(60999,15,60),false);assert.equal(schedule.due(61000,15,60),true);
  assert.equal(schedule.due(100000,0,60),false,'Zero explicitly disables plugin automatic scheduling');
  schedule.reset();assert.equal(schedule.dueAt(15,60),null);
  schedule.complete(70000);assert.equal(schedule.dueAt(15,60),85000);
});

test('budget refusal keeps a delayed review eligible without busy retry or a new exchange',async()=>{
  const {ReviewTiming}=await import('../src/memory/review-timing.ts');
  const schedule=new ReviewTiming();schedule.complete(0);schedule.reset();schedule.retryAfter(60000,15000);
  assert.equal(schedule.due(74999,15,60),false);assert.equal(schedule.due(75000,15,60),true);
  assert.equal(schedule.due(80000,0,60),false);
  schedule.reset();assert.equal(schedule.dueAt(15,60),null);
});
