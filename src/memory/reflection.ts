import type { SourceEvent } from '../contracts.ts';
import type { CompanionMemory, CompanionMemoryDraft, CompanionMemoryOperation, CompanionMemoryRevisionRef, CompanionSourceRef, PendingCompanionSource } from '../memory/companion-types.ts';
import type { ProfileModelRequest } from '../profile/model-types.ts';
import type {PromptPrefix} from '../demo/prompt-cache.ts';
import type {HarnessBranch} from '../runtime/harness-context.ts';
import type {UserProfileSnapshot} from './user-profile.ts';
import {memorySummaryItems} from './disclosure.ts';
import {MEMORY_REVIEW_INSTRUCTIONS,MEMORY_OPERATION_INSTRUCTIONS,REVIEW_STAGE_A,REVIEW_STAGE_B} from './review-instructions.ts';

export interface ReviewBlock { blockId: string; complete: true; sources: PendingCompanionSource[] }
export interface ReviewMaterial {
  memory: CompanionMemory;
  evidence: { eventId: string; sourceRevision: number; sourceRole: SourceEvent['role'] }[];
  parents: CompanionMemoryRevisionRef[];
  sources: { ref: CompanionSourceRef; event: SourceEvent | null; detailsUnavailable: boolean }[];
}
export const estimateTokens = (value: string): number => Math.ceil(Buffer.byteLength(value, 'utf8') / 3);
export function estimateRequestTokens(request:ProfileModelRequest):number{
  const body=request.messages?request.messages.map(m=>m.role+'\n'+m.content).join('\n'):request.prompt;
  if(request.images?.some(image=>!image||typeof image.data!=='string'))throw new Error('无效图片请求');
  return estimateTokens(request.system+body)+(request.images??[]).reduce((n,image)=>n+Math.max(1024,Math.ceil(image.data.length/4)),0);
}
export const REVIEW_POLICY_VERSION = 'companion-cache-memory-10';
export function stageARequest(blocks: ReviewBlock[], persona: string, userProfile?:UserProfileSnapshot, profileMaterials:ReviewMaterial[]=[], backfillMaterials:ReviewMaterial[]=[]): ProfileModelRequest {
  return { task:'memory-a',system:'DEMO_REVIEW_STAGE_A\n'+MEMORY_REVIEW_INSTRUCTIONS+'\n'+REVIEW_STAGE_A,
    prompt: JSON.stringify({ persona, blocks, ...(userProfile?{userProfile,profileEvidence:summaryMaterials(profileMaterials).map(({memory,...evidence})=>({memoryId:memory.memoryId,revision:memory.revision,...evidence}))}:{}),
      ...(backfillMaterials.length?{backfillMaterials:summaryMaterials(backfillMaterials),backfillInstruction:'这些旧记忆尚无短总结。即使没有新交互也请 needsReview=true，由 B 从既有提炼内容补充 summary；不重新评估重要性、不改变原有含义与证据。'}:{}) }), maxOutputTokens: 512 };
}
/** Reuse previously selected meaning and anchors; raw old transcripts stay local for validation. */
function summaryMaterials(materials:ReviewMaterial[]){
  return materials.map(({memory,evidence,parents,sources})=>({
    memory:{memoryId:memory.memoryId,revision:memory.revision,summary:memory.summary,meaning:memory.meaning,anchors:memory.anchors,view:memory.view,
      certainty:memory.certainty,reason:memory.reason,useWhen:memory.useWhen,avoidWhen:memory.avoidWhen,status:memory.status,
      pinned:memory.pinned,detailsUnavailable:memory.detailsUnavailable},
    evidence,parents,sources:sources.map(({ref,event,detailsUnavailable})=>({ref,detailsUnavailable,...(event?{occurredAt:event.occurredAt}:{})})),
  }));
}
export function stageBRequest(blocks: ReviewBlock[], memories: ReviewMaterial[], stageA: {needsReview: boolean; topics: string[]}, persona: string, userProfile?:UserProfileSnapshot): ProfileModelRequest {
  const profileRefs=new Set(userProfile?.entries.map(entry=>memoryKey(entry))??[]);
  return { task:'memory-b',system:'DEMO_REVIEW_STAGE_B\n'+MEMORY_REVIEW_INSTRUCTIONS+'\n'+MEMORY_OPERATION_INSTRUCTIONS+'\n'+REVIEW_STAGE_B,
    prompt: JSON.stringify({ persona, blocks, memories:memorySummaryItems(memories.filter(m=>!profileRefs.has(memoryKey(m.memory))).map(m=>m.memory),Number.MAX_SAFE_INTEGER), stageA, ...(userProfile?{userProfile}:{}) }), maxOutputTokens: 2048 };
}

export function branchReviewA(request:ProfileModelRequest,blocks:ReviewBlock[],prefix?:PromptPrefix):ProfileModelRequest{
  const byId=new Map(prefix?.sources?.map(s=>[s.id,s.messageIndex])??[]);
  const sourceBody=(event:SourceEvent)=>{
    const index=byId.get(event.id),message=index===undefined?undefined:prefix?.messages[index];
    if(message?.role===event.role){
      let body=message.content;
      try{const value=JSON.parse(body);const decoded=event.role==='user'?value?.message:value?.text;if(typeof decoded==='string')body=decoded;}catch{/* Older native messages contain plain text. */}
      if(body===event.content)return {historyMessageIndex:index};
    }
    return {content:event.content};
  };
  const compact=blocks.map(b=>({blockId:b.blockId,sources:b.sources.map(s=>({eventId:s.event.id,sourceRevision:s.metadata.revision,role:s.event.role,at:s.event.occurredAt,
    ...sourceBody(s.event),purpose:s.purpose,...(s.taskState?{taskState:s.taskState}:{})}))}));
  const {persona,blocks:_blocks,...context}=JSON.parse(request.prompt);
  const content='【后台记忆整理任务 A】\n'+request.system+'\n来源表中 historyMessageIndex 是此前消息列表的零起始序号（不含 system）；用户消息正文在 message 字段，助手正文在 text 字段，纯文本消息则直接使用正文。只引用来源表中的 eventId/sourceRevision；其他历史仅供理解，不充当新证据。\n'+JSON.stringify({...(prefix?{}:{persona}),blocks:compact,...context});
  return {...request,system:prefix?.system??'按任务中的记忆整理协议处理资料，只返回 JSON。',messages:[...(prefix?.messages??[]),{role:'user',content}],...(prefix?.harness?{harness:{branch:prefix.harness}}:{})};
}
export function branchReviewB(request:ProfileModelRequest,previous:ProfileModelRequest,answer:string,materials:ReviewMaterial[],branch?:HarnessBranch):ProfileModelRequest{
  const inherited:UserProfileSnapshot|undefined=JSON.parse(previous.prompt).userProfile;
  const profileRefs=new Set(inherited?.entries.map(entry=>JSON.stringify([entry.memoryId,entry.revision]))??[]);
  const extra=materials.filter(({memory})=>!profileRefs.has(JSON.stringify([memory.memoryId,memory.revision])));
  return {...request,system:previous.system,messages:[...previous.messages!,{role:'assistant',content:answer},{role:'user',content:'【后台记忆整理任务 B】\nDEMO_REVIEW_STAGE_B\n'+MEMORY_OPERATION_INSTRUCTIONS+'\n'+REVIEW_STAGE_B+'\n'+JSON.stringify(memorySummaryItems(extra.map(m=>m.memory),Number.MAX_SAFE_INTEGER))}],...(branch?{harness:{branch}}:{})};
}

type RecordValue = Record<string, unknown>;
function object(value: unknown, keys: string[]): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reflection object');
  const result = value as RecordValue;
  if (Object.keys(result).length !== keys.length || keys.some(k => !Object.hasOwn(result, k))) throw new Error('Invalid reflection fields');
  return result;
}
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0')) throw new Error('Invalid reflection text');
  return value;
}
function array(value: unknown, max = 1000, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error('Invalid reflection array');
  return value;
}
function number(value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error('Invalid reflection revision');
  return value;
}
const sourceKey = (r: CompanionSourceRef): string => JSON.stringify([r.eventId, r.sourceRevision]);
const memoryKey = (r: CompanionMemoryRevisionRef): string => JSON.stringify([r.memoryId, r.revision]);
function unique<T>(values: T[], key: (value: T) => string): T[] {
  if (new Set(values.map(key)).size !== values.length) throw new Error('Duplicate reflection reference');
  return values;
}
export function parseStageA(text: string): {needsReview: boolean; topics: string[]} {
  const value = object(JSON.parse(text), ['needsReview', 'topics']);
  if (typeof value.needsReview !== 'boolean') throw new Error('Invalid reflection decision');
  // These are retrieval hints, not evidence: extra valid hints must not reject the whole batch.
  return { needsReview: value.needsReview, topics: array(value.topics, 100).map(v => string(v, 500)).slice(0, 3) };
}
export interface ReviewRead extends CompanionMemoryRevisionRef {level:'refined'|'raw';offset?:number}
export interface ReviewDisclosure {refined:CompanionMemoryRevisionRef[];raw:CompanionSourceRef[]}
/** A bounded, scoped read decision; never accept content or arbitrary source identifiers. */
export function parseStageBRead(text:string,scope:CompanionMemoryRevisionRef[]):ReviewRead[]|undefined{
  const parsed:unknown=JSON.parse(text);
  if(!parsed||typeof parsed!=='object'||!Object.hasOwn(parsed,'read'))return undefined;
  const value=object(parsed,['read']),allowed=new Set(scope.map(memoryKey));
  return unique(array(value.read,8,1).map(raw=>{
    const hasOffset=raw!==null&&typeof raw==='object'&&Object.hasOwn(raw,'offset');
    const entry=object(raw,hasOffset?['memoryId','revision','level','offset']:['memoryId','revision','level']);
    if(entry.level!=='refined'&&entry.level!=='raw')throw new Error('Invalid memory read level');
    if(entry.level==='refined'&&hasOffset)throw new Error('Offset is only supported for raw memory');
    const ref:ReviewRead={memoryId:string(entry.memoryId,128),revision:number(entry.revision,1),level:entry.level,
      ...(hasOffset?{offset:number(entry.offset,0)}:{})};
    if(!allowed.has(memoryKey(ref)))throw new Error('Memory read was not presented');
    return ref;
  }),read=>JSON.stringify([read.memoryId,read.revision,read.level,read.offset??0]));
}
/** The runtime supplies disclosure and requires model summaries. Omission retains legacy direct-parser compatibility. */
export function parseStageB(text: string, blocks: ReviewBlock[], materials: ReviewMaterial[], disclosure?:ReviewDisclosure): CompanionMemoryOperation[] {
  const value = object(JSON.parse(text), ['operations']);
  const refined=disclosure?new Set(disclosure.refined.map(memoryKey)):undefined;
  const rawSources=disclosure?new Set(disclosure.raw.map(sourceKey)):undefined;
  const readMaterials=refined?materials.filter(m=>refined.has(memoryKey(m.memory))):materials;
  const pending = new Set(blocks.flatMap(b => b.sources.map(s => sourceKey({eventId: s.event.id, sourceRevision: s.metadata.revision}))));
  const sources = new Set([...pending, ...readMaterials.flatMap(m => m.evidence.map(sourceKey)),...(rawSources??[])]);
  const memories = new Map(readMaterials.map(m => [memoryKey(m.memory), m.memory]));
  const source = (raw: unknown, onlyPending = false): CompanionSourceRef => {
    const ref = object(raw, ['eventId', 'sourceRevision']);
    const result = { eventId: string(ref.eventId, 128), sourceRevision: number(ref.sourceRevision, 0) };
    if (!(onlyPending ? pending : sources).has(sourceKey(result))) throw new Error('Source was not presented');
    return result;
  };
  const memory = (raw: unknown): CompanionMemoryRevisionRef => {
    const ref = object(raw, ['memoryId', 'revision']);
    const result = { memoryId: string(ref.memoryId, 128), revision: number(ref.revision, 1) };
    if (!memories.has(memoryKey(result))) throw new Error('Memory was not presented');
    return result;
  };
  const consumed = new Set<string>();
  const consume = (refs: CompanionMemoryRevisionRef[]): void => {
    for (const ref of refs) {
      if (consumed.has(ref.memoryId) || memories.get(memoryKey(ref))!.pinned) throw new Error('Invalid or pinned reflection target');
      consumed.add(ref.memoryId);
    }
  };
  const draft = (raw: unknown, targets: CompanionMemoryRevisionRef[]): CompanionMemoryDraft => {
    // Omitting an empty parent list grants no evidence or authority; canonical storage still receives it explicitly.
    const normalized=raw!==null&&typeof raw==='object'&&!Array.isArray(raw)&&!Object.hasOwn(raw,'parentRefs')?{...raw,parentRefs:[]}:raw;
    const hasSummary=normalized!==null&&typeof normalized==='object'&&Object.hasOwn(normalized,'summary');
    if(disclosure&&!hasSummary)throw new Error('Model memory draft requires summary');
    const d = object(normalized, ['meaning', 'anchors', 'view', 'certainty', 'reason', 'useWhen', 'avoidWhen', 'sourceRefs', 'parentRefs',...(hasSummary?['summary']:[])]);
    if (!['user_understanding', 'shared_episode', 'interaction_habit'].includes(d.view as string) || !['explicit', 'inferred'].includes(d.certainty as string)) throw new Error('Invalid reflection classification');
    const sourceRefs = unique(array(d.sourceRefs).map(v => source(v)), sourceKey);
    const parentRefs = unique(array(d.parentRefs, 100).map(memory), memoryKey);
    if (!sourceRefs.length && !parentRefs.length && !targets.length) throw new Error('Reflection draft requires evidence');
    const anchors = array(d.anchors, 100).map(v => string(v, 1000));
    const inherited = [...parentRefs, ...targets].flatMap(ref => memories.get(memoryKey(ref))!.anchors);
    const original = sourceRefs.flatMap(ref => [
      ...blocks.flatMap(b => b.sources.filter(s => sourceKey({eventId: s.event.id, sourceRevision: s.metadata.revision}) === sourceKey(ref)).map(s => s.event.content)),
      ...materials.flatMap(m => m.sources.filter(s => sourceKey(s.ref) === sourceKey(ref) && s.event !== null&&(!rawSources||rawSources.has(sourceKey(s.ref)))).map(s => s.event!.content)),
    ]);
    // Merge/condense and parentRefs inherit their evidence. Raw quotes are reusable only for pages actually read.
    const inheritedRaw=materials.filter(m=>[...targets,...parentRefs].some(ref=>memoryKey(ref)===memoryKey(m.memory)))
      .flatMap(m=>m.sources.filter(s=>s.event!==null&&rawSources?.has(sourceKey(s.ref))).map(s=>s.event!.content));
    if (anchors.some(a => ![...original, ...inherited, ...inheritedRaw].some(text => text.includes(a)))) throw new Error('Anchor is not present in evidence');
    return { meaning: string(d.meaning, 16000), anchors, view: d.view as CompanionMemoryDraft['view'], certainty: d.certainty as CompanionMemoryDraft['certainty'],
      reason: string(d.reason, 8000, true), useWhen: string(d.useWhen, 4000, true), avoidWhen: string(d.avoidWhen, 4000, true), sourceRefs, parentRefs,
      ...(hasSummary?{summary:string(d.summary,320)}:{}) };
  };
  return array(value.operations, 100).map(raw => {
    if (raw === null || typeof raw !== 'object') throw new Error('Invalid reflection operation');
    const action = (raw as RecordValue).action;
    if(action==='summarize'){
      const op=object(raw,['action','target','summary']),target=memory(op.target);
      if(consumed.has(target.memoryId)||memories.get(memoryKey(target))!.summary)throw new Error('Summary already exists or target was consumed');
      consumed.add(target.memoryId);return {action,target,summary:string(op.summary,320)};
    }
    if (action === 'retain') { const op = object(raw, ['action', 'draft']); return { action, draft: draft(op.draft, []) }; }
    if (action === 'merge') { const op = object(raw, ['action', 'targets', 'draft']); const targets = unique(array(op.targets, 100, 2).map(memory), memoryKey); consume(targets); return { action, targets, draft: draft(op.draft, targets) }; }
    if (action === 'condense') { const op = object(raw, ['action', 'target', 'draft']); const target = memory(op.target); consume([target]); return { action, target, draft: draft(op.draft, [target]) }; }
    if (action === 'discard' || action === 'deprioritize') { const op = object(raw, ['action', 'target']); const target = memory(op.target); consume([target]); return { action, target }; }
    if (action === 'defer') { const op = object(raw, ['action', 'sourceRefs']); return { action, sourceRefs: unique(array(op.sourceRefs, 1000, 1).map(v => source(v, true)), sourceKey) }; }
    if (action === 'release_details') {
      const hasSummaries=Object.hasOwn(raw,'summaries');
      const op=object(raw,hasSummaries?['action','sourceRefs','summaries']:['action','sourceRefs']);
      return {action,sourceRefs:unique(array(op.sourceRefs,1000,1).map(v=>source(v)),sourceKey),
        ...(hasSummaries?{summaries:unique(array(op.summaries,100).map(memory),memoryKey)}:{})};
    }
    throw new Error('Invalid reflection action');
  });
}
