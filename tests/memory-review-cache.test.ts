import test from 'node:test';
import assert from 'node:assert/strict';
import {stageARequest,stageBRequest,branchReviewA,branchReviewB} from '../src/memory/reflection.ts';

const build=()=>{
  const a=branchReviewA(stageARequest([],'persona'),[],{system:'unchanged native system',messages:[{role:'user',content:'cached user'},{role:'assistant',content:'cached answer'}]});
  const b=branchReviewB(stageBRequest([],[],{needsReview:true,topics:[]},'persona'),a,'{"needsReview":true,"topics":[]}',[]);
  return {a,b};
};

test('A carries shared judgement once and B appends only its operation contract and candidates',()=>{
  const {a,b}=build(),aTail=a.messages!.at(-1)!.content,bTail=b.messages!.at(-1)!.content;
  assert.doesNotMatch(aTail,/"action":"condense"/,'No-B batches should not pay for the operation schema');
  assert.match(aTail,/inferred/);assert.match(bTail,/"action":"condense"/);assert.match(bTail,/pinned/);
  assert.ok(bTail.length<2400,'B should append its contract without repeating shared judgement');
  assert.doesNotMatch(bTail,/一次平静小事|完整用户画像 userProfile|没有行动不能推断/);
  assert.ok(aTail.length+bTail.length<3300,'Shared instructions should actually shrink the combined new payload');
  assert.deepEqual(b.messages!.slice(0,a.messages!.length),a.messages);
  assert.equal(a.system,'unchanged native system');assert.equal(b.system,a.system);
});

test('cold/restored branches preserve both contracts without depending on live process state',()=>{
  const a=branchReviewA(stageARequest([],'current persona'),[]);
  const b=branchReviewB(stageBRequest([],[],{needsReview:true,topics:[]},'current persona'),a,'{"needsReview":true,"topics":[]}',[]);
  assert.match(a.messages!.at(-1)!.content,/needsReview/);
  assert.match(a.messages!.at(-1)!.content,/current persona/);
  assert.match(b.messages!.map(m=>m.content).join('\n'),/"action":"retain"/);
  assert.match(b.messages!.at(-1)!.content,/后台记忆整理任务 B/);
});
