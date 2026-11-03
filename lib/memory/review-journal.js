import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export class ReviewJournal {
    path;
    data;
    constructor(directory, companionId) {
        mkdirSync(directory, { recursive: true });
        this.path = join(directory, 'memory-review.json');
        this.data = { version: 1, companionId, cursor: 0 };
        if (existsSync(this.path))
            try {
                const raw = JSON.parse(readFileSync(this.path, 'utf8'));
                if (raw.version !== 1 || raw.companionId !== companionId || !Number.isSafeInteger(raw.cursor) || raw.cursor < 0)
                    throw new Error('Invalid journal');
                if (raw.entry && (!/^[a-f0-9]{64}$/.test(raw.entry.key) || !Number.isSafeInteger(raw.entry.epoch) || typeof raw.entry.planId !== 'string' || ['a', 'b'].some(k => raw.entry[k] !== undefined && typeof raw.entry[k] !== 'string')))
                    throw new Error('Invalid entry');
                if (raw.entry?.reads && (!Array.isArray(raw.entry.reads) || raw.entry.reads.length > 8 || raw.entry.reads.some(read => typeof read !== 'string')))
                    throw new Error('Invalid read history');
                if (raw.entry?.inheritedReads && (!Array.isArray(raw.entry.inheritedReads) || raw.entry.inheritedReads.length > 64 || raw.entry.inheritedReads.some(read => typeof read !== 'string')))
                    throw new Error('Invalid inherited reads');
                for (const refs of [raw.entry?.materialRefs, raw.entry?.initialRefs, raw.entry?.backfillRefs])
                    if (refs !== undefined && (!Array.isArray(refs) || refs.some(ref => !ref || typeof ref.memoryId !== 'string' || !Number.isSafeInteger(ref.revision) || ref.revision < 1)))
                        throw new Error('Invalid material references');
                if (raw.checkedBackfill && (!Number.isSafeInteger(raw.checkedBackfill.epoch) || !Array.isArray(raw.checkedBackfill.refs) || raw.checkedBackfill.refs.some(ref => !ref || typeof ref.memoryId !== 'string' || !Number.isSafeInteger(ref.revision) || ref.revision < 1)))
                    throw new Error('Invalid backfill history');
                this.data = raw;
            }
            catch {
                this.save();
            }
    }
    save() { writeFileSync(this.path + '.tmp', JSON.stringify(this.data), 'utf8'); renameSync(this.path + '.tmp', this.path); }
    clear() { this.data = { version: 1, companionId: this.data.companionId, cursor: this.data.cursor }; this.save(); }
}
