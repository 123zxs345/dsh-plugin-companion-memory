import { createHash } from 'node:crypto';
import type { BackendOperation, ForgetReceipt } from '../contracts.ts';
import { StateStore } from '../state/store.ts';
import type { CompanionMemory } from './companion-types.ts';
import { HindsightBackend } from './hindsight.ts';
import { ForgetLifecycle } from './lifecycle.ts';
import {retrievalOptions,type MemoryRetrievalOptions} from './retrieval-policy.ts';
import { OperationCoordinator, operationIdFor, type CleanupCounts, type MaterialDocument, type MaterialDocumentPort, type PollCounts, type SubmitCounts } from './operations.ts';

export function materialBankId(companionId: string): string {
  if(!companionId.trim()) throw new Error('Companion id is required');
  return 'companion-materials-v2-' + createHash('sha256').update(companionId).digest('hex').slice(0,32);
}
export interface MaterialRecallHit {
  similarity:number;
  memory: CompanionMemory;
  text: string;
  locationId: string;
  bank: string;
  documentId: string;
}
export interface MaterialMaintenanceResult {
  submit: SubmitCounts;
  poll: PollCounts;
  cleanup: CleanupCounts;
  forget: ForgetReceipt[];
}

/** Independent approved-material index. Runtime context budgeting and generation are separate callers. */
export class MemoryMaterialIndex {
  readonly documentPort: MaterialDocumentPort;
  readonly coordinator: OperationCoordinator;
  readonly lifecycle: ForgetLifecycle;
  private readonly store: StateStore;
  private readonly backend: HindsightBackend;
  private readonly clock: () => number;

  constructor(store: StateStore, backend: HindsightBackend, options: {clock?:()=>number} = {}) {
    this.store=store;this.backend=backend;this.clock=options.clock ?? Date.now;
    backend.setRouting({
      operation:(cid,id)=>{
        const location=store.companionMemory.indexLocationForOperation(cid,id);
        if(location !== null) return {kind:'location',location};
        const operation=store.getOperation(cid,id);
        return operation !== null && store.documentStatus(cid,operation.documentId).source !== 'missing' ? {kind:'legacy'} : null;
      },
      legacyDocument:(cid,id)=>store.documentStatus(cid,id).source !== 'missing',
    });
    this.documentPort={
      read:operation=>this.read(operation),allowed:operation=>this.read(operation)!==null,
      shouldErase:(cid,handle)=>{
        const location=store.companionMemory.getIndexLocation(cid,handle);
        return location !== null && (location.cleanupState!=='not-requested' || location.memory !== null && store.companionMemory.getMemory(cid,location.memory)?.status==='forgotten');
      },
      submit:async(document,operationId)=>{
        const valid=()=>{
          const operation=store.getOperation(document.companionId,operationId);
          const current=operation === null ? null : this.read(operation);
          return current !== null && current.content===document.content && current.payloadHash===document.payloadHash;
        };
        const receipt=await backend.submitMaterial(document,operationId,valid);
        if(!valid())store.updateOperation(document.companionId,operationId,{state:'cleanup_pending',cleanupState:'pending',nextCheckAt:0});
        return receipt;
      },
      deleteDocument:async(cid,handle)=>{
        const location=store.companionMemory.getIndexLocation(cid,handle);if(location===null)throw new Error('Unknown material location');await backend.deleteLocatedDocument(location);
      },
    };
    this.coordinator=new OperationCoordinator(store,backend,this.clock,this.documentPort);
    this.lifecycle=new ForgetLifecycle(store,backend,this.clock);
  }

  private read(operation: BackendOperation): MaterialDocument | null {
    const snapshot=this.store.materialOperationSnapshot(operation.companionId,operation.operationId);
    if(snapshot===null || snapshot.operation.documentId!==operation.documentId || snapshot.location.bank!==materialBankId(operation.companionId) || snapshot.payloadHash!==operation.payloadHash)return null;
    return {companionId:operation.companionId,handle:snapshot.location.id,bank:snapshot.location.bank,documentId:snapshot.location.documentId,revision:snapshot.memory.revision,content:snapshot.content,payloadHash:snapshot.payloadHash};
  }

  ensurePending(companionId: string): BackendOperation[] {
    return this.store.companionMemory.indexableMemoryRefs(companionId).flatMap(ref=>{
      const operation=this.store.prepareMaterialOperation(companionId,ref,materialBankId(companionId),'memory-'+ref.memoryId+'-r'+ref.revision,operationIdFor);
      return operation===null ? [] : [operation];
    });
  }

  async maintain(companionId: string): Promise<MaterialMaintenanceResult> {
    this.ensurePending(companionId);
    const counts=await this.coordinator.process(companionId,this.clock());
    for(const location of this.store.companionMemory.listIndexLocations(companionId)) {
      const operation=location.operationId===null ? null : this.store.getOperation(companionId,location.operationId);
      if(operation?.state==='completed') this.store.companionMemory.updateIndexLocation(companionId,location.id,{indexState:'indexed'});
      else if(operation?.state==='failed') this.store.companionMemory.updateIndexLocation(companionId,location.id,{indexState:'failed'});
      else if(operation?.state==='erased') this.store.companionMemory.updateIndexLocation(companionId,location.id,{indexState:'erased'});
    }
    const forget=await this.lifecycle.runBatch();
    return {...counts,forget};
  }

  async recall(companionId: string, query: string, tokenBudget: number, options:MemoryRetrievalOptions={}): Promise<MaterialRecallHit[]> {
    const {minimumSimilarity,limit}=retrievalOptions(options);if(!limit)return [];
    const fence=this.store.memoryFence(companionId);const bank=materialBankId(companionId);
    const remote=await this.backend.recallMaterials(bank,query,tokenBudget,minimumSimilarity);
    const after=this.store.memoryFence(companionId);
    if(after.stateEpoch!==fence.stateEpoch || after.deletionWatermark!==fence.deletionWatermark) return [];
    const seen=new Set<string>();const hits:MaterialRecallHit[]=[];
    // Bound result count locally; backend metadata/text never establishes local identity or facts.
    // Other hybrid retrieval arms can bypass a semantic floor upstream. Enforce it per result.
    const relevant=remote.filter(hit=>typeof hit.similarity==='number'&&Number.isFinite(hit.similarity)&&hit.similarity>=minimumSimilarity&&hit.similarity<=1)
      .sort((a,b)=>b.similarity!-a.similarity!||a.documentId.localeCompare(b.documentId));
    for(const hit of relevant) {
      const location=this.store.companionMemory.findIndexLocation(companionId,bank,hit.documentId);
      if(location===null || location.memory===null || location.indexState!=='indexed' || location.cleanupState!=='not-requested' || location.operationId===null || seen.has(location.id)) continue;
      const operation=this.store.getOperation(companionId,location.operationId);if(operation?.state!=='completed')continue;
      const document=this.read(operation);if(document===null)continue;
      const snapshot=this.store.companionMemory.materialSnapshot(companionId,location.memory);if(snapshot===null)continue;
      seen.add(location.id);hits.push({memory:snapshot.memory,similarity:hit.similarity!,text:document.content,locationId:location.id,bank,documentId:location.documentId});if(hits.length>=limit)break;
    }
    const finalFence=this.store.memoryFence(companionId);
    if(finalFence.stateEpoch!==fence.stateEpoch || finalFence.deletionWatermark!==fence.deletionWatermark)return [];
    if(hits.length)this.store.companionMemory.recordRetrieved(companionId,hits.map(hit=>({memoryId:hit.memory.memoryId,revision:hit.memory.revision})));
    return hits;
  }

  /** Call immediately before enabling a legacy reader, and compare this fence after its HTTP response. */
  verifyLegacyRollback(companionId: string): {stateEpoch:number;deletionWatermark:number} { return this.store.verifyLegacyRollback(companionId); }
}
