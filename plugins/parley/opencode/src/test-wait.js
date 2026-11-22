// State-driven waits for parley tests: poll an observable effect on macrotask turns, with a bound.
const turn = () => new Promise((resolve) => setImmediate(resolve));
/** Resolves once `check` is true. Fails with `what` after `limitMs` (a hung test fails here, not at the suite timeout). */
export async function until(check, what, limitMs = 2000) {
    const deadline = Date.now() + limitMs;
    while (!check()) {
        if (Date.now() > deadline)
            throw new Error(`timed out after ${limitMs} ms waiting for ${what}`);
        await turn();
    }
}
/** Lets already-queued work run: a few event-loop turns, for asserting that something did NOT happen yet. */
export async function quiet(turns = 3) {
    for (let i = 0; i < turns; i++)
        await turn();
}
/** The id of the first pending round, once there is one. */
export async function opened(service) {
    await until(() => service.pending({}).rounds.length > 0, "a round to open");
    return service.pending({}).rounds[0]?.roundID ?? "";
}
