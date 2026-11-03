import { CompanionMemoryStore } from '../../memory/companion-store.js';
/** Version old outbox evidence; this changes metadata only, never source bodies or fences. */
export function applyOperationProofs(db) {
    const columns = new Set(db.pragma('table_info(backend_operations)').map(column => column.name));
    if (!columns.has('submission_protocol_version'))
        db.exec('ALTER TABLE backend_operations ADD COLUMN submission_protocol_version INTEGER NOT NULL DEFAULT 0 CHECK (submission_protocol_version IN (0,1))');
    if (!columns.has('payload_erasure_version'))
        db.exec('ALTER TABLE backend_operations ADD COLUMN payload_erasure_version INTEGER NOT NULL DEFAULT 0 CHECK (payload_erasure_version IN (0,1))');
    // Only explicit local never-sent evidence can join the no-replay protocol.
    db.exec(`UPDATE backend_operations SET submission_protocol_version = 1 WHERE submission_protocol_version = 0
    AND submitted_at IS NULL AND attempts = 0 AND (error_code IS NULL OR error_code NOT GLOB 'submit-claim:*');
    UPDATE backend_operations SET state = 'cleanup_pending', cleanup_state = 'blocked', next_check_at = 9007199254740991,
      error_code = CASE WHEN error_code GLOB 'submit-claim:*' THEN error_code ELSE 'legacy-submit-proof-required' END
      WHERE submission_protocol_version = 0;
    UPDATE backend_operations SET state = 'cleanup_pending', cleanup_state = 'unknown', next_check_at = 0,
      error_code = 'legacy-family-proof-required' WHERE submission_protocol_version = 1 AND payload_erasure_version = 0
      AND (state = 'erased' OR cleanup_state = 'done');
    UPDATE memory_index_locations SET cleanup_state = CASE WHEN EXISTS (
      SELECT 1 FROM backend_operations o WHERE o.companion_id = memory_index_locations.companion_id
      AND o.operation_id = memory_index_locations.operation_id AND o.submission_protocol_version = 0) THEN 'blocked' ELSE 'unknown' END
      WHERE EXISTS (SELECT 1 FROM backend_operations o WHERE o.companion_id = memory_index_locations.companion_id
      AND o.operation_id = memory_index_locations.operation_id AND o.state = 'cleanup_pending' AND o.payload_erasure_version = 0);`);
    const domain = new CompanionMemoryStore(db);
    const receipts = db.prepare("SELECT id,companion_id,selector_json FROM forget_requests WHERE mode = 'erase'").all();
    for (const receipt of receipts) {
        const events = JSON.parse(receipt.selector_json);
        const locations = domain.indexLocationsForEvents(receipt.companion_id, events);
        const boundIds = locations.flatMap(location => location.operationId === null ? [] : [location.operationId]);
        const rows = db.prepare(`SELECT submission_protocol_version FROM backend_operations o WHERE companion_id = ? AND payload_erasure_version = 0 AND
      (operation_id IN (SELECT value FROM json_each(?)) OR (document_id IN (SELECT value FROM json_each(?)) AND NOT EXISTS
      (SELECT 1 FROM memory_index_locations l WHERE l.companion_id = o.companion_id AND l.operation_id = o.operation_id AND l.id = o.document_id AND l.memory_id IS NOT NULL)))`)
            .all(receipt.companion_id, JSON.stringify(boundIds), JSON.stringify(events));
        if (rows.length === 0)
            continue;
        const state = rows.some(row => row.submission_protocol_version === 0) ? 'blocked' : 'unknown';
        db.prepare('UPDATE forget_requests SET backend_status = ?,operation_payload_status = ? WHERE id = ?').run(state, state, receipt.id);
    }
}
