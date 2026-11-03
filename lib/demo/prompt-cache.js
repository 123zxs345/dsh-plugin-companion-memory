const equal = (a, b) => a.role === b.role && a.content === b.content && (!a.id || !b.id || a.id === b.id);
/** Mirrors DSH's append-only runtime-context projection. Request-local state only;
 * authoritative event revisions/deletion watermark control reuse. No second disk transcript. */
export class ConversationPromptCache {
    entries = new Map();
    prepare(request) {
        let data = {};
        try {
            data = JSON.parse(request.prompt);
        }
        catch { }
        const history = Array.isArray(data?.history) && data.history.every(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string') ? data.history : null;
        const id = request.conversation?.id, epoch = request.conversation?.epoch ?? 0, existing = id ? this.entries.get(id) : undefined;
        const reusable = history && existing && existing.epoch === epoch && existing.system === request.system && existing.history.length < history.length && existing.history.every((m, i) => equal(m, history[i]));
        const messages = reusable ? structuredClone(existing.messages) : [];
        const positions = reusable ? [...existing.positions] : [];
        const tail = history?.slice(reusable ? existing.history.length : 0) ?? [{ role: 'user', content: request.prompt }];
        const { history: _, ...context } = data ?? {};
        tail.forEach((message, index) => { positions.push(messages.length); messages.push({ role: message.role, content: index === tail.length - 1 && message.role === 'user' ? JSON.stringify({ message: message.content, currentContext: { ...context, currentTime: new Date().toISOString(), timezone: 'Asia/Shanghai' } }) : message.content }); });
        return { id, epoch, system: request.system, messages, positions, history: history ?? tail, retain: !request.images?.length };
    }
    complete(prepared, visibleReply) {
        if (!prepared.retain)
            return;
        const prefix = { system: prepared.system, messages: structuredClone(prepared.messages), sources: prepared.history.flatMap((m, index) => m.id ? [{ id: m.id, messageIndex: prepared.positions[index] }] : []) };
        if (prepared.id && JSON.stringify(prefix).length < 1_000_000) {
            this.entries.delete(prepared.id);
            this.entries.set(prepared.id, { ...prefix, epoch: prepared.epoch, positions: [...prepared.positions, prepared.messages.length - 1], history: [...prepared.history, { role: 'assistant', content: visibleReply }] });
            while (this.entries.size > 16)
                this.entries.delete(this.entries.keys().next().value);
        }
        return prefix;
    }
}
/** Rotate at a turn window boundary instead of dropping one leading message every turn. */
export function stableHistoryWindow(events) {
    let start = Math.max(0, Math.floor(Math.max(0, events.length - 1) / 64) * 64 - 16);
    while (start < events.length && events[start].role !== 'user')
        start++;
    return events.slice(start);
}
