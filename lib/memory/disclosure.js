/** Only capacity and identity are checked here; relevance belongs to retrieval/the model. */
export function memorySummaryItems(memories, tokenBudget, maxItems = 24) {
    const result = [];
    const seen = new Set();
    if (!Number.isFinite(tokenBudget) || tokenBudget <= 0 || !Number.isFinite(maxItems) || maxItems <= 0)
        return result;
    const limit = Math.min(24, Math.floor(maxItems));
    for (const memory of memories) {
        if (result.length >= limit)
            break;
        if (typeof memory.summary !== 'string' || !memory.summary.trim())
            continue;
        const key = JSON.stringify([memory.memoryId, memory.revision]);
        if (seen.has(key))
            continue;
        const item = { memoryId: memory.memoryId, revision: memory.revision, summary: memory.summary,
            availableLayers: ['refined', 'raw'], ...(memory.detailsUnavailable ? { detailsUnavailable: true } : {}) };
        if (Math.ceil(Buffer.byteLength(JSON.stringify([...result, item]), 'utf8') / 3) > tokenBudget)
            continue;
        result.push(item);
        seen.add(key);
    }
    return result;
}
/** Raw pages contain at most four whole sources; numeric offsets count sources, never characters. */
export function readCompanionMemory(options) {
    if (options.level !== 'refined' && options.level !== 'raw')
        throw new Error('Invalid memory level');
    if (options.level === 'refined' && options.offset !== undefined)
        throw new Error('Offset is only supported for raw memory');
    const snapshot = options.store.companionMemory.disclosureSnapshot(options.companionId, options.reference, options.level === 'raw' ? options.offset ?? 0 : undefined);
    const memory = snapshot.memory;
    const identity = { memoryId: memory.memoryId, revision: memory.revision };
    if (options.level === 'raw')
        return { ...identity, level: 'raw', sources: snapshot.sources, detailsUnavailable: memory.detailsUnavailable, nextOffset: snapshot.nextOffset };
    return { ...identity, level: 'refined', summary: memory.summary ?? null, pinned: memory.pinned, meaning: memory.meaning, anchors: [...memory.anchors], reason: memory.reason, view: memory.view,
        status: memory.status, certainty: memory.certainty, useWhen: memory.useWhen, avoidWhen: memory.avoidWhen,
        detailsUnavailable: memory.detailsUnavailable, sourceRefs: snapshot.sourceRefs };
}
