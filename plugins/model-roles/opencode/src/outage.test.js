import { describe, expect, test } from "bun:test";
import { acquireNoticeState, claimContextNotice, claimEvent, claimToolContextNotice, decideFailureNotice, decideRecovery, forgetSession, MAX_STOPPED, MAX_TRACKED, newNoticeState, noticeResumes, recordRequest, releaseNoticeState, restoreOutages, settleRequest, snapshotOutages, toolContextNoticeLive } from "./outage.ts";
const bedrock = (id) => ({ providerID: "amazon-bedrock", id });
const openai = (id) => ({ providerID: "openai", id });
const report = (failed, kind, now, extra = {}) => ({
    failed,
    kind,
    cooldownMs: 60_000,
    target: undefined,
    now,
    notifyTo: "lead",
    ...extra,
});
describe("provider outage", () => {
    test("20 credential failures over 3 models of one provider give one outage notice and one recovery notice", () => {
        const state = newNoticeState();
        const models = [bedrock("a"), bedrock("b"), bedrock("c")];
        const notices = [];
        for (let i = 0; i < 20; i++) {
            const notice = decideFailureNotice(state, report(models[i % 3], "credentials", 1_000 + i * 10_000, { notifyTo: `s${i % 4}` }));
            if (notice !== undefined)
                notices.push(notice);
        }
        expect(notices).toHaveLength(1);
        expect(notices[0]?.sessionID).toBe("s0");
        expect(notices[0]?.text).toContain("Provider amazon-bedrock is down (credentials)");
        const recovered = decideRecovery(state, bedrock("b"));
        expect(recovered).toEqual([{ sessionID: "s0", text: "Provider amazon-bedrock recovered (credentials)." }]);
        // The outage is over: a second success says nothing, and a new failure is a new outage.
        expect(decideRecovery(state, bedrock("b"))).toEqual([]);
        expect(decideFailureNotice(state, report(bedrock("a"), "credentials", 402_000))).toBeDefined();
    });
    test("a failure of the first attempt that does not sit the provider out yet still opens the outage", () => {
        const state = newNoticeState();
        const notice = decideFailureNotice(state, report(bedrock("a"), "credentials", 0, { cooldownMs: 0 }));
        expect(notice?.text).toContain("Provider amazon-bedrock is failing (credentials)");
        expect(decideFailureNotice(state, report(bedrock("b"), "credentials", 1_000))).toBeUndefined();
    });
    test("a second provider's outage and a second class each get their own notice", () => {
        const state = newNoticeState();
        expect(decideFailureNotice(state, report(bedrock("a"), "credentials", 0))).toBeDefined();
        const other = decideFailureNotice(state, report(openai("x"), "credentials", 1_000));
        expect(other?.text).toContain("Provider openai is down (credentials)");
        expect(decideFailureNotice(state, report(bedrock("a"), "quota", 2_000))?.text).toContain("(quota)");
        // Only the provider that came back recovers.
        expect(decideRecovery(state, openai("y")).map((n) => n.text)).toEqual(["Provider openai recovered (credentials)."]);
        expect(decideFailureNotice(state, report(bedrock("b"), "credentials", 4_000))).toBeUndefined();
    });
    test("an outage nobody saw end is announced again once its failures have stopped for long enough", () => {
        const state = newNoticeState();
        decideFailureNotice(state, report(bedrock("a"), "credentials", 0));
        expect(decideFailureNotice(state, report(bedrock("a"), "credentials", 3_600_000))).toBeDefined();
    });
    test("a re-announced quiet outage keeps its resume list and does not repeat a child", () => {
        const state = newNoticeState();
        const sub = (id, now) => decideFailureNotice(state, report(bedrock("a"), "credentials", now, { subagent: { agent: "coder", sessionID: id } }));
        sub("c1", 0);
        const again = sub("c1", 3_600_000);
        expect(again?.text).toContain("Provider amazon-bedrock is down (credentials)");
        expect(again?.text).not.toContain("Subagent 'coder'");
        const fresh = sub("c2", 3_601_000);
        expect(fresh?.text).toContain("Subagent 'coder' stopped by the amazon-bedrock outage");
        expect(decideRecovery(state, bedrock("a"))[0]?.text).toContain("coder (c1), coder (c2)");
    });
    test("sessions that succeeded or were deleted leave the resume list", () => {
        const state = newNoticeState();
        for (const id of ["c1", "c2", "c3"])
            decideFailureNotice(state, report(bedrock("a"), "credentials", 0, { subagent: { agent: "coder", sessionID: id } }));
        forgetSession(state, "c1");
        forgetSession(state, "c3");
        expect(decideRecovery(state, bedrock("a"))[0]?.text).toBe("Provider amazon-bedrock recovered (credentials). Resume the stopped subagents: coder (c2).");
    });
    test("every new child is named once; the recovery summary names 20 and counts the rest", () => {
        const state = newNoticeState();
        const sub = (i) => decideFailureNotice(state, report(bedrock("a"), "credentials", i, { subagent: { agent: "coder", sessionID: `c${i}` } }));
        const notices = Array.from({ length: 25 }, (_, i) => sub(i)?.text ?? "");
        for (const [i, text] of notices.entries())
            expect(text).toContain(`sessionID c${i}`);
        expect(sub(24)).toBeUndefined();
        const text = decideRecovery(state, bedrock("a"))[0]?.text ?? "";
        expect(text).toContain(`coder (c${MAX_STOPPED - 1}), +5 more.`);
        expect(text).not.toContain(`c${MAX_STOPPED})`);
    });
    test("the remembered stopped sessions are bounded, dropping the oldest", () => {
        const state = newNoticeState();
        const sub = (i) => decideFailureNotice(state, report(bedrock("a"), "credentials", i, { subagent: { agent: "coder", sessionID: `c${i}` } }));
        for (let i = 0; i < MAX_TRACKED + 1; i++)
            sub(i);
        expect(sub(MAX_TRACKED)).toBeUndefined();
        expect(sub(0)?.text).toContain("sessionID c0");
    });
    test("subagent failures during an outage are one line per session, then folded into the recovery notice", () => {
        const state = newNoticeState();
        const sub = (sessionID, agent, now) => decideFailureNotice(state, report(bedrock("a"), "credentials", now, { subagent: { agent, sessionID }, plain: "unused" }));
        const first = sub("c1", "coder", 0);
        expect(first?.text).toContain("Provider amazon-bedrock is down (credentials)");
        expect(first?.text).toContain("Subagent 'coder' stopped: resume it with sessionID c1 when the provider is back.");
        for (let i = 1; i < 9; i++)
            expect(sub("c1", "coder", i * 1_000)).toBeUndefined();
        const second = sub("c2", "reviewer", 10_000);
        expect(second?.sessionID).toBe("lead");
        expect(second?.text).toBe("Subagent 'reviewer' stopped by the amazon-bedrock outage (credentials): resume it with sessionID c2 when the provider is back.");
        expect(sub("c2", "reviewer", 11_000)).toBeUndefined();
        const [recovery] = decideRecovery(state, bedrock("z"));
        expect(recovery?.text).toBe("Provider amazon-bedrock recovered (credentials). Resume the stopped subagents: coder (c1), reviewer (c2).");
    });
    test("a subagent that names no session is reported once per parent and agent", () => {
        const state = newNoticeState();
        const sub = (agent) => decideFailureNotice(state, report(bedrock("a"), "credentials", 0, { subagent: { agent, sessionID: undefined } }));
        expect(sub("coder")?.text).toContain("Subagent 'coder' stopped: spawn it again when the provider is back.");
        expect(sub("coder")).toBeUndefined();
        expect(sub("other")?.text).toContain("Subagent 'other' stopped by the amazon-bedrock outage");
    });
});
describe("model failure", () => {
    test("notifies once per model and class within the window, with the plain text", () => {
        const state = newNoticeState();
        const fail = (id, kind, now) => decideFailureNotice(state, report(bedrock(id), kind, now, { plain: `${id} ${kind}` }));
        expect(fail("a", "rate-limit", 0)?.text).toBe("a rate-limit");
        expect(fail("a", "rate-limit", 30_000)).toBeUndefined();
        expect(fail("b", "rate-limit", 30_000)?.text).toBe("b rate-limit");
        expect(fail("a", "server", 30_000)?.text).toBe("a server");
        expect(fail("a", "rate-limit", 61_000)?.text).toBe("a rate-limit");
    });
    test("the same model failing for two parents tells both", () => {
        const state = newNoticeState();
        const fail = (to) => decideFailureNotice(state, report(bedrock("a"), "rate-limit", 0, { notifyTo: to, plain: "x" }));
        expect(fail("p1")).toBeDefined();
        expect(fail("p2")).toBeDefined();
        expect(fail("p1")).toBeUndefined();
    });
    test("a context-length notice is claimed once per overflowing execution, expires and is forgotten", () => {
        const state = newNoticeState();
        expect(claimContextNotice(state, "c1", "e1", 0)).toBe(true);
        expect(claimContextNotice(state, "c2", "e1", 1_000)).toBe(true);
        // The event and the tool error of one execution claim once.
        expect(claimContextNotice(state, "c1", "e1", 2_000)).toBe(false);
        // A new execution of the same child (a resume) is its own overflow.
        expect(claimContextNotice(state, "c1", "e2", 3_000)).toBe(true);
        // With no known execution, the session alone is the key.
        expect(claimContextNotice(state, "c3", undefined, 3_000)).toBe(true);
        expect(claimContextNotice(state, "c3", undefined, 4_000)).toBe(false);
        // The window passes: stale entries go, the live ones stay.
        expect(claimContextNotice(state, "c1", "e1", 62_000)).toBe(true);
        expect(state.contextNotices.size).toBe(3);
        expect(claimContextNotice(state, "c1", "e2", 62_500)).toBe(false);
        forgetSession(state, "c1");
        expect(state.contextNotices.size).toBe(1);
        expect(claimContextNotice(state, "c1", "e1", 63_000)).toBe(true);
    });
    test("a tool-error context notice is claimed only when no live notice of the session exists", () => {
        const state = newNoticeState();
        expect(claimToolContextNotice(state, "c1", 0)).toBe(true);
        expect(claimToolContextNotice(state, "c1", 1_000)).toBe(false);
        // The event path sees the tool note and stays quiet; an event-only session has none.
        expect(toolContextNoticeLive(state, "c1", 1_500)).toBe(true);
        expect(toolContextNoticeLive(state, "c9", 1_500)).toBe(false);
        expect(toolContextNoticeLive(state, "c1", 61_000)).toBe(false);
        // The failure event of the execution is still its own claim.
        expect(claimContextNotice(state, "c1", "e1", 2_000)).toBe(true);
        // A live event notice silences the tool error of another child session's late report.
        expect(claimContextNotice(state, "c2", "e1", 3_000)).toBe(true);
        expect(claimToolContextNotice(state, "c2", 4_000)).toBe(false);
        // After the window, a tool error is noted again.
        expect(claimToolContextNotice(state, "c2", 64_000)).toBe(true);
        forgetSession(state, "c2");
        expect(claimToolContextNotice(state, "c2", 65_000)).toBe(true);
    });
    test("a model failure does not recover or open a provider outage", () => {
        const state = newNoticeState();
        decideFailureNotice(state, report(bedrock("a"), "rate-limit", 0, { plain: "x" }));
        expect(decideRecovery(state, bedrock("a"))).toEqual([]);
    });
});
describe("request log", () => {
    test("an end is credited to the latest request started by then; later requests stay for later ends", () => {
        const log = new Map();
        recordRequest(log, "s", bedrock("a"), 100);
        recordRequest(log, "s", openai("x"), 300);
        expect(settleRequest(log, "s", 200)).toEqual(bedrock("a"));
        expect(settleRequest(log, "s", 200)).toBeUndefined();
        expect(settleRequest(log, "s", 400)).toEqual(openai("x"));
        expect(log.size).toBe(0);
    });
    test("a request in the millisecond of an end belongs to the next execution", () => {
        const log = new Map();
        recordRequest(log, "s", bedrock("a"), 100);
        recordRequest(log, "s", openai("x"), 200);
        expect(settleRequest(log, "s", 200)).toEqual(bedrock("a"));
        expect(settleRequest(log, "s", 300)).toEqual(openai("x"));
    });
    test("an end with no earlier request, and another session's request, are credited to nobody", () => {
        const log = new Map();
        recordRequest(log, "s", bedrock("a"), 100);
        expect(settleRequest(log, "s", 50)).toBeUndefined();
        expect(settleRequest(log, "other", 500)).toBeUndefined();
        expect(settleRequest(log, "s", 500)).toEqual(bedrock("a"));
    });
    test("a backlog of unsettled requests stays bounded", () => {
        const log = new Map();
        for (let i = 0; i < 50; i++)
            recordRequest(log, "s", bedrock(`m${i}`), i);
        expect(log.get("s")?.length).toBeLessThanOrEqual(8);
        expect(settleRequest(log, "s", 1_000)).toEqual(bedrock("m49"));
    });
});
describe("noticeResumes", () => {
    test.each([
        ["subagent-fallback", true],
        ["recovery", true],
        ["fallback", false],
        ["context-length", false],
    ])("%s wakes its session: %p", (kind, expected) => {
        expect(noticeResumes(kind)).toBe(expected);
    });
});
describe("recovery reaches every parent", () => {
    const child = (id, parent) => report(bedrock("a"), "credentials", 0, { notifyTo: parent, subagent: { agent: "general", sessionID: id } });
    test("children stopped under two parents tell each parent only its own", () => {
        const state = newNoticeState();
        decideFailureNotice(state, child("c1", "p1"));
        decideFailureNotice(state, child("c2", "p2"));
        decideFailureNotice(state, child("c3", "p2"));
        const notices = decideRecovery(state, bedrock("z"));
        expect(notices).toEqual([
            { sessionID: "p1", text: "Provider amazon-bedrock recovered (credentials). Resume the stopped subagents: general (c1)." },
            { sessionID: "p2", text: "Provider amazon-bedrock recovered (credentials). Resume the stopped subagents: general (c2), general (c3)." },
        ]);
    });
    test("the session that heard the outage start is told too when none of its own children stopped", () => {
        const state = newNoticeState();
        decideFailureNotice(state, report(bedrock("a"), "credentials", 0, { notifyTo: "root" }));
        decideFailureNotice(state, child("c1", "p1"));
        expect(decideRecovery(state, bedrock("z")).map((n) => n.sessionID)).toEqual(["root", "p1"]);
    });
});
describe("persisted outages", () => {
    test("a restored state recovers the stopped children of the state that was saved", () => {
        const before = newNoticeState();
        decideFailureNotice(before, report(bedrock("a"), "credentials", 5, { notifyTo: "p1", subagent: { agent: "general", sessionID: "c1" } }));
        const after = newNoticeState();
        restoreOutages(after, JSON.parse(JSON.stringify(snapshotOutages(before))));
        expect(decideRecovery(after, bedrock("z"))[0]).toEqual({ sessionID: "p1", text: "Provider amazon-bedrock recovered (credentials). Resume the stopped subagents: general (c1)." });
    });
    test.each([[undefined], [null], ["x"], [[{ providerID: 1 }]], [[{ providerID: "p", kind: "nonsense", lastAt: 1, notifyTo: "s", stopped: [] }]]])("malformed stored data %p restores nothing", (raw) => {
        const state = newNoticeState();
        restoreOutages(state, raw);
        expect(state.outages.size).toBe(0);
    });
});
describe("process-global state", () => {
    test("two instances share one state, and it goes when the last releases", () => {
        const holder = {};
        const a = acquireNoticeState(holder);
        const b = acquireNoticeState(holder);
        expect(b.state).toBe(a.state);
        expect(a.first).toBe(true);
        expect(b.first).toBe(false);
        releaseNoticeState(holder);
        expect(acquireNoticeState(holder).state).toBe(a.state);
        releaseNoticeState(holder);
        releaseNoticeState(holder);
        expect(acquireNoticeState(holder).state).not.toBe(a.state);
    });
    test("a state left by an older build without the event map is backfilled, not replaced", () => {
        const holder = {};
        const old = { outages: new Map(), notices: new Map(), contextNotices: new Map() };
        holder[Symbol.for("srobroek.model-roles.notice-state")] = { state: old, refs: 1 };
        const { state } = acquireNoticeState(holder);
        expect(state).toBe(old);
        expect(claimEvent(state, "e1", 0)).toBe(true);
    });
    test("an event id is claimed once; no id is always claimed; the oldest ids are forgotten", () => {
        const state = newNoticeState();
        expect(claimEvent(state, "e1", 0)).toBe(true);
        expect(claimEvent(state, "e1", 1)).toBe(false);
        expect(claimEvent(state, undefined, 2)).toBe(true);
        expect(claimEvent(state, undefined, 3)).toBe(true);
        for (let i = 0; i < 1000; i++)
            claimEvent(state, `n${i}`, 4);
        expect(claimEvent(state, "e1", 5)).toBe(true);
    });
});
