import type { StateStore } from '../state/store.ts';
import type { CompanionMemory } from './companion-types.ts';
import type { MemoryMaterialIndex,MaterialRecallHit } from './material-index.ts';
import {retrievalOptions,type MemoryRetrievalOptions} from './retrieval-policy.ts';

export interface CompanionMemoryContext {
  memoryId: string;
  revision: number;
  meaning: string;
  anchors: string[];
  reason: string;
  view: CompanionMemory['view'];
  status: CompanionMemory['status'];
  certainty: CompanionMemory['certainty'];
  useWhen: string;
  avoidWhen: string;
  detailsUnavailable: boolean;
}

/** Local model retrieval supplies relevance. This layer checks identity and validity only. */
export async function recallCompanionCandidates(options:{
  store:StateStore;companionId:string;query:string;tokenBudget:number;index?:MemoryMaterialIndex;
}&MemoryRetrievalOptions):Promise<MaterialRecallHit[]>{
  const {store,companionId,index,query,tokenBudget}=options;
  const {limit,minimumSimilarity}=retrievalOptions(options);
  if(tokenBudget<=0||!index||!query.trim()||!limit)return [];
  try{
    const seen=new Set<string>();
    return (await index.recall(companionId,query,Math.min(16384,Math.floor(tokenBudget)),{limit,minimumSimilarity}))
      .filter(hit=>Number.isFinite(hit.similarity)&&hit.similarity>=minimumSimilarity&&hit.similarity<=1)
      .sort((a,b)=>b.similarity-a.similarity||a.memory.memoryId.localeCompare(b.memory.memoryId))
      .flatMap(hit=>{
        const ref={memoryId:hit.memory.memoryId,revision:hit.memory.revision},key=JSON.stringify(ref);
        const snapshot=store.companionMemory.materialSnapshot(companionId,ref);
        if(seen.has(key)||!snapshot||!snapshot.memory.summary)return [];
        seen.add(key);return [{...hit,memory:snapshot.memory,text:snapshot.memory.summary}];
      }).slice(0,limit);
  }catch{return [];}
}

export async function recallCompanionMemories(options:Parameters<typeof recallCompanionCandidates>[0]):Promise<CompanionMemory[]>{
  return (await recallCompanionCandidates(options)).map(hit=>hit.memory);
}

/** Capacity limits bound a model request; no score/age/keyword rule assigns memory value. */
export function memoryContextItems(memories:readonly CompanionMemory[],tokenBudget:number,maxItems=100):CompanionMemoryContext[]{
  const result:CompanionMemoryContext[]=[];const seen=new Set<string>();
  for(const memory of memories){
    if(result.length>=maxItems)break;
    const key=JSON.stringify([memory.memoryId,memory.revision]);if(seen.has(key))continue;
    const item:CompanionMemoryContext={memoryId:memory.memoryId,revision:memory.revision,meaning:memory.meaning,
      anchors:[...memory.anchors],reason:memory.reason,view:memory.view,status:memory.status,certainty:memory.certainty,
      useWhen:memory.useWhen,avoidWhen:memory.avoidWhen,detailsUnavailable:memory.detailsUnavailable};
    if(Math.ceil(Buffer.byteLength(JSON.stringify([...result,item]),'utf8')/3)>tokenBudget)continue;
    result.push(item);seen.add(key);
  }
  return result;
}

export const MEMORY_USAGE_GUIDANCE='记忆是理解相处的背景，不必每次说出来。初始 memories 和 recall_memory 只提供与本次查询相似度达标的简短总结，最多24条，允许0条。需要使用某条时自行调用 read_memory(level:"refined") 查看提炼记忆、必要原话和适用边界；仍需核对具体过程或措辞时再读 level:"raw"，有 nextOffset 可继续翻页。无需机械展开所有候选，摘要已足够时也可不展开。相似度只表示本次查询相关，不代表长期重要性。推测不能当事实，遵守 useWhen/avoidWhen；原文已淡去时依照现存提炼内容，不补造细节。';
