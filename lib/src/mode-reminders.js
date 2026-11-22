/**
 * Mode reminders for primary agents, modelled on OpenCode core's plan mode.
 *
 * A mode is a primary agent whose restrictions the model must keep in mind. On entering one
 * the session gets an inline `<system-reminder>` as a synthetic user message, and on leaving
 * it the reminder is withdrawn by a second one. Compaction and reverts can strip those
 * messages while the agent stays put, so each request is also reconciled: the missing
 * reminder is spliced in before the last user prompt and persisted once.
 *
 * Reminder text is static per mode (no session state), so the prompt cache prefix holds.
 * Core's Plan plugin also rewrites refused-edit errors; that needs `Permission.BlockedError`,
 * which the public plugin API does not export, so it is not done here.
 */
const wrap = (text) => `<system-reminder>\n${text}\n</system-reminder>`;
/** Build a mode with the standard enter and leave text. */
export function defineMode(spec) {
    const enter = wrap([
        `You are in ${spec.name} mode: ${spec.purpose}`,
        `You may edit files only in: ${spec.allowed}. Do not modify any other files or ask a subagent to.`,
        `You remain in ${spec.name} mode until the user switches agents. If the user asks for work outside it, do not do it; tell them to ${spec.redirect}.`,
    ].join("\n\n"));
    const leave = wrap(`You are NO LONGER in ${spec.name} mode. The previous ${spec.name} restrictions no longer apply. Any ${spec.name} mode instructions from earlier in this conversation are no longer active.`);
    return { id: spec.id, name: spec.name, enter, leave, allowed: spec.allowed };
}
export const enterReminder = (mode) => mode.enter;
export const leaveReminder = (mode) => mode.leave;
/**
 * The reminders to inject when a session's agent changes from `previous` to `next`
 * (`previous` is undefined for a new session): the leave text of a mode being left, then
 * the enter text of a mode being entered. Unrelated switches give none.
 */
export function reminderFor(previous, next, modes) {
    if (previous === next)
        return [];
    const left = modes.find((mode) => mode.id === previous);
    const entered = modes.find((mode) => mode.id === next);
    return [...(left ? [leaveReminder(left)] : []), ...(entered ? [enterReminder(entered)] : [])];
}
/** The text of a message that is exactly one text part, else undefined. */
function soleText(message) {
    const { role, content } = message;
    if (role !== "user" || !Array.isArray(content) || content.length !== 1)
        return undefined;
    const part = content[0];
    return part.type === "text" && typeof part.text === "string" ? part.text : undefined;
}
/**
 * The reminders a request is missing: compares the last reminder in `messages` with the mode
 * of `agent`. Gives the enter text when `agent` is a mode whose enter text is not the last
 * reminder, and the leave text when the last reminder is an enter text of a mode `agent` is not.
 */
export function missingReminders(agent, messages, modes) {
    const known = new Set(modes.flatMap((mode) => [mode.enter, mode.leave]));
    const last = messages.map(soleText).findLast((text) => text !== undefined && known.has(text));
    const current = modes.find((mode) => mode.id === agent);
    const active = modes.find((mode) => mode.enter === last);
    if (active === current)
        return [];
    return [...(active ? [leaveReminder(active)] : []), ...(current ? [enterReminder(current)] : [])];
}
/**
 * Where to add corrections: before a trailing real user prompt, else after the history (so
 * after any trailing reminders, which keeps the newest reminder last and reconciliation idempotent).
 */
export function insertionIndex(messages, modes) {
    const last = messages.at(-1);
    if (last?.role !== "user")
        return messages.length;
    const text = soleText(last);
    const reminder = text !== undefined && modes.some((mode) => mode.enter === text || mode.leave === text);
    return reminder ? messages.length : messages.length - 1;
}
/**
 * Wire reminders for `modes` into a plugin context: a synthetic message on `session.created`
 * and `session.agent.selected`, and a per-request reconcile in the `context` hook. Returns a
 * disposer for every registration.
 */
export async function registerModeReminders(ctx, modes, options = {}) {
    const controller = new AbortController();
    const report = options.onError ?? (() => { });
    const synthetic = (sessionID, text) => ctx.session.synthetic({ sessionID, text, resume: false }).catch(report);
    const hook = await ctx.session.hook("context", async (event) => {
        // A payload without a history has nothing to reconcile.
        if (!Array.isArray(event.messages))
            return;
        const missing = missingReminders(event.agent, event.messages, modes);
        if (missing.length === 0)
            return;
        const at = insertionIndex(event.messages, modes);
        event.messages.splice(at, 0, ...missing.map((text) => ({ role: "user", content: [{ type: "text", text }] })));
        for (const text of missing)
            await synthetic(event.sessionID, text);
    });
    void (async () => {
        for await (const raw of ctx.event.subscribe({
            types: ["session.created", "session.agent.selected"],
            signal: controller.signal,
        })) {
            if (controller.signal.aborted)
                break;
            const event = raw;
            const data = event.data;
            if (typeof data?.sessionID !== "string" || typeof data.agent !== "string")
                continue;
            const previous = event.type === "session.created" ? undefined : data.previous;
            for (const text of reminderFor(previous, data.agent, modes))
                await synthetic(data.sessionID, text);
        }
    })().catch(report);
    return async () => {
        controller.abort();
        await hook.dispose();
    };
}
