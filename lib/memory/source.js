/** Shared admission rule for long-term storage and recall. Missing mode metadata keeps legacy defaults. */
export function isLongTermSourceAllowed(event) {
    return event.visibility === 'private'
        && (event.role === 'user' || event.role === 'tool' && event.toolVerified === true)
        && event.learning !== 'temporary'
        && event.contentMode !== 'roleplay';
}
