const DEFAULT_WINDOW_MS = 30_000;
/** Heartbeat bookkeeping: which TUI clients have checked in recently at this location. */
export class Presence {
    windowMs;
    #clients = new Map();
    constructor(windowMs = DEFAULT_WINDOW_MS) {
        this.windowMs = windowMs;
    }
    attach(clientID, now, sessionIDs) {
        this.#clients.set(clientID, sessionIDs === undefined ? { lastSeen: now } : { lastSeen: now, sessionIDs });
        this.prune(now);
    }
    detach(clientID) {
        this.#clients.delete(clientID);
    }
    /** A client counts when it was seen within the window and either lists no sessions or lists this one. */
    attached(now, sessionID) {
        for (const client of this.#clients.values()) {
            if (now - client.lastSeen > this.windowMs)
                continue;
            if (sessionID === undefined || client.sessionIDs === undefined || client.sessionIDs.includes(sessionID))
                return true;
        }
        return false;
    }
    prune(now) {
        for (const [id, client] of this.#clients)
            if (now - client.lastSeen > this.windowMs)
                this.#clients.delete(id);
    }
    get size() {
        return this.#clients.size;
    }
}
