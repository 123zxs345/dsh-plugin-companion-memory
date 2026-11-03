import {createHash} from 'node:crypto';
import type {StateStore} from '../state/store.ts';
import type {CompanionSourceRef} from './companion-types.ts';
import type {CompanionMemoryContext} from './recall.ts';

export interface UserProfileEntry extends CompanionMemoryContext {
  pinned:boolean;
  sourceRefs:CompanionSourceRef[];
}
export interface UserProfileSnapshot {
  revision:string;
  entries:UserProfileEntry[];
}

/** A projection of model-authored memories, never a second independently stored profile. */
export function readCompanionUserProfile(store:StateStore,companionId:string):UserProfileSnapshot {
  const entries:UserProfileEntry[]=[];
  for(const candidate of store.companionMemory.listProfileMemories(companionId)){
    // Check the current revision, every source and the full derivation graph, including erased parents.
    const ref={memoryId:candidate.memoryId,revision:candidate.revision};
    const snapshot=store.companionMemory.materialSnapshot(companionId,ref);
    if(!snapshot)continue;
    const memory=snapshot.memory;
    entries.push({memoryId:memory.memoryId,revision:memory.revision,meaning:memory.meaning,anchors:[...memory.anchors],
      reason:memory.reason,view:memory.view,status:memory.status,certainty:memory.certainty,useWhen:memory.useWhen,
      avoidWhen:memory.avoidWhen,detailsUnavailable:memory.detailsUnavailable,pinned:memory.pinned,
      sourceRefs:store.companionMemory.evidenceFor(companionId,ref).map(({eventId,sourceRevision})=>({eventId,sourceRevision}))});
  }
  // Store queries use stable ID order. Accounting timestamps never enter the version or projection.
  return {revision:createHash('sha256').update(JSON.stringify(entries)).digest('hex'),entries};
}
