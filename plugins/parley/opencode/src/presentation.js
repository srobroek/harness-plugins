/** Background questions must not replace a different session's unanswered question. */
export function canAutoPresent(target, current, pending) {
    return current === undefined || current === target || !pending.includes(current);
}
/** A late completion may close only its own session's panel, and never a newer round. */
export function canCloseRoundPanel(panel, name, sessionID, stillPending) {
    return panel?.name === name && panel.sessionID === sessionID && !stillPending;
}
