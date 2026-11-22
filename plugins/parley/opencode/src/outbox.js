import { isRecord, strings } from "./guards.ts";
/** Messages parley sends to a session for the TUI's fallback (a round the server never held), kept until the host admits them. */
export const OUTBOX_KEY_PREFIX = "outbox:";
/** A delivery that failed this many times stops retrying on its own and goes back to the user. */
export const MAX_ATTEMPTS = 3;
/** Admitted or pending fallback deliveries are remembered this long, so a retried request is recognised. */
export const SENT_TTL_MS = 60 * 60_000;
export const outboxKey = (key) => `${OUTBOX_KEY_PREFIX}${key}`;
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/**
 * A host message id: `msg_` plus 12 hex digits of time and a counter, then 14 characters, the shape the
 * host makes itself so the message sorts at the moment of creation. The host only checks the prefix.
 */
export function messageID(now) {
    const time = (BigInt(now) * 0x1000n + 1n).toString(16).padStart(12, "0").slice(-12);
    const bytes = crypto.getRandomValues(new Uint8Array(14));
    return `msg_${time}${Array.from(bytes, (byte) => CHARS[byte % 62]).join("")}`;
}
const STATUSES = new Set(["pending", "sent", "failed", "dismissed"]);
function base(value) {
    const { messageID: id, generation, description, status, attempts, created, updated } = value;
    if (typeof id !== "string" || !id.startsWith("msg_") || typeof description !== "string" || !STATUSES.has(status))
        return undefined;
    if (typeof attempts !== "number" || typeof created !== "number" || typeof updated !== "number")
        return undefined;
    return {
        messageID: id,
        generation: typeof generation === "number" ? generation : 0,
        description,
        status: status,
        attempts,
        ...(typeof value.error === "string" ? { error: value.error } : {}),
        created,
        updated,
    };
}
/** Reads a stored round delivery; anything unusable is undefined. Never throws. */
export function fromRoundDelivery(value) {
    if (!isRecord(value))
        return undefined;
    const head = base(value);
    if (!head)
        return undefined;
    const notes = {};
    if (isRecord(value.notes))
        for (const [id, lines] of Object.entries(value.notes))
            notes[id] = strings(lines);
    return {
        ...head,
        answerIDs: strings(value.answerIDs),
        notes,
        held: strings(value.held),
        ...(value.started === true ? { started: true } : {}),
    };
}
/** Reads a stored fallback delivery; anything unusable is undefined. Never throws. */
export function fromOutbox(value) {
    if (!isRecord(value))
        return undefined;
    const head = base(value);
    const { key, directory, sessionID, text } = value;
    if (!head || typeof key !== "string" || typeof directory !== "string")
        return undefined;
    if (typeof sessionID !== "string" || typeof text !== "string")
        return undefined;
    return { ...head, key, directory, sessionID, text };
}
