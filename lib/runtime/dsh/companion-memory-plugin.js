import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { BlockAssembler, createAssistantMessage, createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope';
import Schema from '@deepseek-ai/schemastery';
import { StateStore } from '../../state/store.js';
import { CompanionMemoryReviewer } from '../../memory/reviewer.js';
import { recallCompanionMemories, MEMORY_USAGE_GUIDANCE } from '../../memory/recall.js';
import { memorySummaryItems, readCompanionMemory } from '../../memory/disclosure.js';
import { ReviewTiming } from '../../memory/review-timing.js';
import { retrievalOptions } from '../../memory/retrieval-policy.js';
import { readCompanionUserProfile } from '../../memory/user-profile.js';
import { MemoryMaterialIndex } from '../../memory/material-index.js';
import { HindsightBackend } from '../../memory/hindsight.js';
import { SessionBindings } from './sessions.js';
import { mapSessionEvent } from './events.js';
export const Config = Schema.object({
    dataDir: Schema.string().required(), companionId: Schema.string().default('default'), name: Schema.string(), persona: Schema.string(),
    idleReviewSeconds: Schema.number().min(0).default(15), reviewMaxDelaySeconds: Schema.number().min(10).max(300).default(60), minimumSimilarity: Schema.number().min(0).max(1).default(.55), contextTokens: Schema.natural().default(600), candidateBudget: Schema.natural().max(24).default(24),
    maintenanceMode: Schema.union(['off', 'preview', 'auto']).default('auto'), hindsightUrl: Schema.string(), provider: Schema.string(), model: Schema.string(),
});
export const name = 'companion-memory';
export const inject = ['agents', 'systemPrompt', 'tools', 'llm'];
const textOf = (message) => message.content.flatMap(b => b.type === 'text' ? [b.text ?? ''] : []).join('\n');
// Branches carry schemas for cache compatibility; background review never gains tool execution.
const inertTools = (schemas) => schemas.map(schema => ({ ...schema, output: { schema: {}, render: () => [] }, execute: async () => { throw new Error('Memory review cannot execute tools'); } }));
/** Loader entry and programmatic host integration share the same owned lifecycle. */
export function createCompanionMemoryPlugin(options) {
    if (!options || !isAbsolute(options.dataDir))
        throw new Error('dataDir must be an absolute path');
    retrievalOptions({ limit: options.candidateBudget, minimumSimilarity: options.minimumSimilarity });
    for (const [key, value] of Object.entries({ idleReviewSeconds: options.idleReviewSeconds ?? 15, reviewMaxDelaySeconds: options.reviewMaxDelaySeconds ?? 60, contextTokens: options.contextTokens ?? 600, candidateBudget: options.candidateBudget ?? 24 })) {
        if (!Number.isFinite(value) || value < 0)
            throw new Error(`Invalid ${key}`);
    }
    return { name, inject, apply: (ctx) => lifecycle(ctx, options) };
}
async function* lifecycle(ctx, options) {
    const owner = options.ownerScope ?? scopeOf(ctx);
    const accepts = (agent) => owner === undefined || scopeChainOf(agent).includes(owner);
    if (ctx.agents.list().some(accepts))
        throw new Error('Load companion-memory before its host Agents are created or resumed');
    mkdirSync(options.dataDir, { recursive: true });
    const companionId = options.companionId ?? 'default';
    const ownStore = options.store === undefined;
    const store = options.store ?? new StateStore(join(options.dataDir, 'companion-memory.sqlite'));
    let disposed = false;
    const lifetime = new AbortController();
    const jobs = new Set();
    const listeners = [];
    const mounts = new Map();
    const native = new WeakMap();
    let timer;
    let indexTimer, indexMaintaining = false;
    const reviewTiming = new ReviewTiming();
    let prefix;
    let prefixEpoch;
    let review;
    let route;
    const routeFile = join(options.dataDir, 'host-route-' + createHash('sha256').update(companionId).digest('hex').slice(0, 24) + '.json');
    const live = () => { if (disposed)
        throw new Error('Companion memory plugin is disposed'); };
    const track = (work) => { jobs.add(work); void work.then(() => jobs.delete(work), () => jobs.delete(work)); return work; };
    // One disposer owns ordering: detach first, cancel work, drain, then close only our store.
    yield async () => {
        disposed = true;
        if (timer)
            clearTimeout(timer);
        if (indexTimer)
            clearInterval(indexTimer);
        lifetime.abort(new Error('Companion memory plugin is disposed'));
        for (const stop of listeners.splice(0).reverse())
            stop();
        prefix = undefined;
        await Promise.allSettled([...mounts.values()].map(async (m) => { m.snapshot = ''; await m.child?.dispose(); }));
        mounts.clear();
        while (jobs.size)
            await Promise.allSettled([...jobs]);
        if (ownStore)
            store.close();
    };
    if (disposed)
        return;
    store.ensureCompanion({ id: companionId, name: options.name ?? companionId, anchors: {} });
    try {
        const saved = JSON.parse(readFileSync(routeFile, 'utf8'));
        if (typeof saved.provider === 'string' && typeof saved.model === 'string')
            route = { provider: saved.provider, model: saved.model, ...(typeof saved.reasoningEffort === 'string' ? { reasoningEffort: saved.reasoningEffort } : {}) };
    }
    catch { /* First installation has no captured route. */ }
    if (options.provider && options.model)
        route = { provider: options.provider, model: options.model };
    const index = options.index ?? (options.hindsightUrl ? new MemoryMaterialIndex(store, new HindsightBackend({ baseUrl: options.hindsightUrl })) : undefined);
    // Async embedding submissions need later polls, even when there is no new paid review.
    const maintainIndex = () => {
        if (disposed || !index || indexMaintaining || jobs.size)
            return;
        indexMaintaining = true;
        void track(index.maintain(companionId)).catch(() => ctx.logger.warn('Companion memory index maintenance will retry')).finally(() => { indexMaintaining = false; });
    };
    if (index) {
        indexTimer = setInterval(maintainIndex, 5000);
        indexTimer.unref();
        maintainIndex();
    }
    const contextTokens = options.contextTokens ?? 600;
    const epoch = () => store.memoryFence(companionId).stateEpoch;
    const clearContext = () => { prefix = undefined; prefixEpoch = undefined; for (const m of mounts.values()) {
        m.snapshot = '';
        m.turn = undefined;
        m.epoch = undefined;
        m.allowPrefix = false;
    } };
    const saveRoute = (r) => {
        const next = { provider: r.provider, model: r.model, ...(r.reasoningEffort ? { reasoningEffort: r.reasoningEffort } : {}) };
        if (JSON.stringify(route) === JSON.stringify(next))
            return;
        route = next;
        writeFileSync(routeFile + '.tmp', JSON.stringify(route), 'utf8');
        renameSync(routeFile + '.tmp', routeFile);
    };
    const nativeModel = async (request) => {
        live();
        if (!route)
            throw new Error('No host LLM route captured; complete a host turn first or configure provider/model');
        const branch = request.harness?.branch;
        const prior = branch ? native.get(branch) : undefined;
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(120_000), ...(request.signal ? [request.signal] : [])]);
        const tail = request.messages?.at(-1)?.content ?? request.prompt;
        const messages = branch ? [...branch.messages, createUserMessage({ content: [{ type: 'text', text: tail }], source: { kind: 'user' } })]
            : (request.messages ?? [{ role: 'user', content: request.prompt }]).map(m => m.role === 'user' ? createUserMessage({ content: [{ type: 'text', text: m.content }], source: { kind: 'user' } }) : createAssistantMessage({ content: [{ type: 'text', text: m.content }], source: { provider: route.provider, model: route.model } }));
        const generate = { ...(prior ?? route), messages, signal, maxTokens: request.maxOutputTokens,
            ...(branch ? { tools: prior?.tools ?? branch.tools.map(({ name, description, parameters, deferLoading }) => ({ name, description, parameters, ...(deferLoading ? { deferLoading } : {}) })) } : { system: request.system, tools: [] }) };
        const assembler = new BlockAssembler();
        let bytes = 0;
        let terminal = false;
        for await (const chunk of ctx.llm.stream(generate)) {
            live();
            signal.throwIfAborted();
            bytes += JSON.stringify(chunk).length;
            if (bytes > 2_000_000)
                throw new Error('Memory review output exceeds capacity');
            assembler.push(chunk);
            if (chunk.type === 'finish')
                terminal = true;
        }
        live();
        signal.throwIfAborted();
        if (!terminal || assembler.finish.kind !== 'stop' || assembler.blocks().some(b => b.type === 'tool-call'))
            throw new Error('Memory review must finish with structured text and cannot execute tools');
        const answer = assembler.message({ provider: generate.provider, model: generate.model });
        const nextBranch = { sessionId: branch?.sessionId ?? 'companion-review', system: branch?.system ?? request.system, events: [], messages: [...messages, answer], tools: branch?.tools ?? [] };
        native.set(nextBranch, generate);
        const usage = assembler.usage;
        return { text: textOf(answer), model: generate.model, harness: nextBranch, ...(usage ? { usage: { inputTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0), uncachedInputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens } } : {}) };
    };
    const model = async (request) => {
        live();
        const input = { ...request, signal: AbortSignal.any([lifetime.signal, ...(request.signal ? [request.signal] : [])]) };
        const result = await (options.runModel ? options.runModel(input, nativeModel) : nativeModel(input));
        live();
        return result;
    };
    review = new CompanionMemoryReviewer({ store, companionId, model, index: () => index, persistenceDir: options.dataDir,
        getSettings: () => ({ persona: options.persona ?? '', provider: route?.provider ?? '', model: route?.model ?? '', baseUrl: 'host-managed', maintenanceMode: options.maintenanceMode ?? 'auto', candidateBudget: Math.min(24, options.candidateBudget ?? 24), minimumSimilarity: options.minimumSimilarity ?? .55 }),
        getPrefix: () => prefixEpoch === epoch() ? prefix : undefined, isBudgetError: options.isBudgetError, paused: () => disposed });
    const controller = {
        reviewNow: mode => { live(); return track(review.review(mode)); },
        applyPreview: () => { live(); return track(review.applyPreview()); },
        snapshot: () => { live(); return review.snapshot(); },
        userProfile: () => { live(); return readCompanionUserProfile(store, companionId); },
        invalidate: () => { live(); review.invalidate(); clearContext(); },
        forget: async (eventIds) => {
            live();
            const outcome = store.forgetEvents(companionId, eventIds, 'erase');
            review.invalidate();
            clearContext();
            if (index)
                await track(index.maintain(companionId));
            return { outcome, hostHistoryErased: false };
        },
    };
    ctx.provide('companionMemory', controller);
    const schedule = () => {
        if (timer)
            clearTimeout(timer);
        const at = reviewTiming.dueAt(options.idleReviewSeconds ?? 15, options.reviewMaxDelaySeconds ?? 60);
        if (at === null || options.maintenanceMode === 'off')
            return;
        timer = setTimeout(() => {
            if (disposed)
                return;
            if ([...mounts.values()].some(m => m.active)) {
                timer = setTimeout(schedule, 1000);
                timer.unref();
                return;
            }
            reviewTiming.reset();
            void track(review.review(undefined, true)).then(result => {
                if (disposed)
                    return;
                if (result.status === 'applied' && result.hasMore) {
                    reviewTiming.complete();
                    schedule();
                }
                else if (result.status === 'budget-exceeded') {
                    reviewTiming.retryAfter(60000);
                    schedule();
                }
            }).catch(() => ctx.logger.warn('Companion memory background review failed'));
        }, Math.max(0, at - Date.now()));
        timer.unref();
    };
    for (const source of store.companionMemory.listPending(companionId, { limit: 1000 }))
        if (source.event.role === 'assistant')
            reviewTiming.complete(Date.parse(source.event.occurredAt));
    if (store.companionMemory.listMemoriesWithoutSummary(companionId, 1).length)
        reviewTiming.complete();
    schedule();
    // llm/stream is service-scoped in rc.2, not agent-scoped. Only explicitly mounted
    // session IDs and official live-loop requests are captured; review calls pass through untouched.
    listeners.push(ctx.on('llm/stream', async function* (request, next) {
        const m = request.sessionId ? mounts.get(request.sessionId) : undefined;
        if (!disposed && m && isAgentLoopRequest(request)) {
            m.request = request;
            saveRoute(request);
        }
        yield* next();
    }, { global: true }));
    listeners.push(ctx.on('agent/created', async ({ agent }) => {
        if (disposed || !accepts(agent) || mounts.has(agent.id))
            return;
        const deletionWatermark = store.memoryFence(companionId).deletionWatermark;
        // A resumed host log may still contain erased content. Its history belongs to
        // the host; only fresh source material is eligible for our background calls.
        const m = { agent, sources: new Map(), snapshot: '', query: '', deletionWatermark, allowPrefix: !(deletionWatermark > 0 && agent.session.firstLiveSeq > 0) };
        mounts.set(agent.id, m);
        const bindings = new SessionBindings([{ hostSessionId: agent.id, companionId, logicalChatId: agent.id }]);
        m.child = agent.ctx.plugin({ name: 'companion-memory-session', apply(child) {
                child.systemPrompt.context({ name: 'companion:memory', order: 130, text: () => disposed ? '' : m.snapshot, interpolate: false });
                child.tools.register({ name: 'read_memory', description: '按需展开一条记忆：refined 返回提炼内容与使用边界，raw 返回原始来源。原文 nextOffset 可继续翻页。',
                    parameters: { type: 'object', properties: { memoryId: { type: 'string' }, revision: { type: 'integer' }, level: { type: 'string', enum: ['refined', 'raw'] }, offset: { type: 'integer' } }, required: ['memoryId', 'revision', 'level'], additionalProperties: false },
                    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
                    execute: async (args, exec) => {
                        live();
                        exec.signal.throwIfAborted();
                        const input = args;
                        const reference = { memoryId: input.memoryId, revision: input.revision };
                        const result = readCompanionMemory({ store, companionId, reference, level: input.level, offset: input.offset });
                        store.companionMemory.recordPresented(companionId, [reference]);
                        return result;
                    },
                });
                child.tools.register({ name: 'recall_memory', description: '回忆与当前话题相关的相处记忆，保留独特原话和使用边界。', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
                    output: { schema: { type: 'object', properties: { guidance: { type: 'string' }, memories: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['guidance', 'memories'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
                    execute: async (args, exec) => track((async () => {
                        live();
                        exec.signal.throwIfAborted();
                        const before = epoch();
                        const memories = await recallCompanionMemories({ store, companionId, index, query: args.query, tokenBudget: contextTokens, limit: options.candidateBudget, minimumSimilarity: options.minimumSimilarity });
                        live();
                        exec.signal.throwIfAborted();
                        if (before !== epoch())
                            throw new Error('Memory changed during recall');
                        const items = memorySummaryItems(memories, contextTokens);
                        if (items.length)
                            store.companionMemory.recordPresented(companionId, items.map(({ memoryId, revision }) => ({ memoryId, revision })));
                        return { guidance: MEMORY_USAGE_GUIDANCE, memories: items };
                    })()),
                });
                child.on('agent/pre-step', async (payload, next) => {
                    live();
                    if (payload.agent !== agent)
                        return next();
                    m.active = true;
                    for (const message of payload.messages)
                        if (message.source.kind === 'user')
                            m.query = textOf(message);
                    if (m.turn === payload.turn && m.epoch === epoch())
                        return next();
                    const before = epoch();
                    m.snapshot = '';
                    const memories = await track(recallCompanionMemories({ store, companionId, index, query: m.query, tokenBudget: contextTokens, limit: options.candidateBudget, minimumSimilarity: options.minimumSimilarity }));
                    live();
                    payload.signal.throwIfAborted();
                    if (before !== epoch())
                        throw new Error('Memory changed during context preparation');
                    const items = memorySummaryItems(memories, contextTokens);
                    if (items.length)
                        store.companionMemory.recordPresented(companionId, items.map(({ memoryId, revision }) => ({ memoryId, revision })));
                    m.snapshot = items.length ? MEMORY_USAGE_GUIDANCE + '\n' + JSON.stringify(items) : '';
                    m.turn = payload.turn;
                    m.epoch = before;
                    return next();
                });
                child.on('session/event', (session, event) => {
                    if (disposed || session !== agent.session)
                        return;
                    if (event.type === 'turn/end')
                        m.active = false;
                    const source = mapSessionEvent(bindings, session, event);
                    if (source && source.role !== 'tool') {
                        const accepted = store.stageEvent(source);
                        const message = event.type === 'user/message' ? event.data : event.type === 'assistant/message' ? event.data.message : undefined;
                        if (message)
                            m.sources.set(message.id, source.id);
                        if (accepted && source.role === 'assistant') {
                            reviewTiming.complete(Date.parse(source.occurredAt));
                            schedule();
                        }
                    }
                    if (m.allowPrefix && m.deletionWatermark === store.memoryFence(companionId).deletionWatermark && event.type === 'assistant/message' && !event.data.interrupted && event.surfaceOp === 'append' && event.sourceEventSeqs === undefined && event.seq >= session.firstLiveSeq && m.request) {
                        const r = m.request;
                        // Native requests include system/developer/tool messages and replay metadata.
                        // Keep all of them byte-for-byte; the text projection only indexes source references.
                        const messages = [...r.messages, event.data.message];
                        const projection = [];
                        const sources = [];
                        for (const message of messages) {
                            if (message.role === 'system')
                                continue;
                            const id = m.sources.get(message.id);
                            if (id)
                                sources.push({ id, messageIndex: projection.length });
                            projection.push({ role: message.role === 'user' ? 'user' : 'assistant', content: textOf(message) });
                        }
                        const branch = { sessionId: agent.id, system: r.system ?? messages.filter(m => m.role === 'system').map(textOf).join('\n'), events: [], messages, tools: inertTools(r.tools ?? []) };
                        native.set(branch, r);
                        prefix = { system: branch.system, messages: projection, sources, harness: branch };
                        prefixEpoch = epoch();
                    }
                });
            } });
        await m.child;
    }));
    listeners.push(ctx.on('agent/disposed', ({ agent }) => { const m = mounts.get(agent.id); if (!m)
        return; mounts.delete(agent.id); if (m.child)
        track(Promise.resolve(m.child.dispose())); }));
    options.onReady?.(controller);
}
// Cordis treats constructible functions as classes; an arrow keeps the returned
// async-generator lifecycle on its effect runner, including initialization/disposal.
export const apply = (ctx, config) => lifecycle(ctx, config);
export default { name, inject, Config, apply };
