import { normaliseAnswer, publicAnswer } from "./answers.ts";
import { visibleQuestions } from "./conditions.ts";
import { validateQuestions } from "./questions.ts";
/** Cancel reason of a round closed because a waiting call's `timeout_s` passed. */
export const TIMEOUT = "timeout";
/** Reason of the `unavailable` result a waiting call gets when the plugin reloads under it. */
export const RELOADED_REASON = "parley reloaded; the round stays open and its answers will arrive as a message";
/** In-memory rounds for one plugin instance, keyed by session. One open round per session. */
export class Rounds {
    newID;
    #rounds = new Map();
    #counters = new Map();
    #listeners = new Set();
    constructor(newID = () => `rnd_${crypto.randomUUID().replaceAll("-", "")}`) {
        this.newID = newID;
    }
    /** Opens a round, or adds the questions to the session's open round. */
    open(sessionID, input, now) {
        const existing = this.current(sessionID);
        const errors = validateQuestions(input.questions, existing?.questions);
        if (errors.length > 0)
            return { errors };
        if (existing) {
            existing.questions.push(...input.questions);
            if (input.callID !== undefined)
                existing.callIDs.push(input.callID);
            if (input.title !== undefined)
                existing.title = input.title;
            existing.updated = now;
            this.#emit(existing);
            return { round: existing, joined: true };
        }
        const number = input.round ?? (this.#counters.get(sessionID) ?? 0) + 1;
        this.#counters.set(sessionID, Math.max(number, this.#counters.get(sessionID) ?? 0));
        const round = {
            id: this.newID(),
            sessionID,
            number,
            ...(input.title === undefined ? {} : { title: input.title }),
            questions: [...input.questions],
            answers: new Map(),
            delivered: new Set(),
            callIDs: input.callID === undefined ? [] : [input.callID],
            status: "open",
            created: now,
            updated: now,
        };
        this.#rounds.set(round.id, round);
        this.#emit(round);
        return { round, joined: false };
    }
    /** Records another tool call that waits on an open round, without changing its questions. */
    attach(roundID, callID, now) {
        const round = this.#rounds.get(roundID);
        if (round?.status !== "open")
            return;
        round.callIDs.push(callID);
        round.updated = now;
        this.#emit(round);
    }
    get(roundID) {
        return this.#rounds.get(roundID);
    }
    current(sessionID) {
        for (const round of this.#rounds.values())
            if (round.sessionID === sessionID && round.status === "open")
                return round;
        return undefined;
    }
    latest(sessionID) {
        let found;
        for (const round of this.#rounds.values())
            if (round.sessionID === sessionID)
                found = round;
        return found;
    }
    /** Every round, open or closed, in the order they were opened. */
    list() {
        return [...this.#rounds.values()];
    }
    pending(sessionID) {
        return [...this.#rounds.values()].filter((round) => round.status === "open" && (sessionID === undefined || round.sessionID === sessionID));
    }
    /** Records answers. Invalid entries are reported and skipped; `final` closes the round. */
    submit(roundID, submitted, final, now) {
        const round = this.#rounds.get(roundID);
        if (!round)
            return { ok: false, errors: [`unknown round ${roundID}`] };
        if (round.status !== "open")
            return { ok: false, errors: [`round ${roundID} is ${round.status}`] };
        const errors = [];
        const accepted = [];
        for (const item of submitted) {
            const question = round.questions.find((candidate) => candidate.id === item.id);
            if (!question) {
                errors.push(`unknown question ${item.id}`);
                continue;
            }
            const result = normaliseAnswer(question, item);
            if ("error" in result)
                errors.push(result.error);
            else
                accepted.push(result.answer);
        }
        // A submission with errors is rejected whole so the client can fix it and resend.
        if (errors.length > 0)
            return { ok: false, errors };
        const combined = new Map(round.answers);
        for (const answer of accepted)
            combined.set(answer.id, answer);
        const active = new Set(visibleQuestions(round.questions, (id) => combined.get(id)?.value).map((question) => question.id));
        for (const id of round.answers.keys())
            if (!active.has(id)) {
                round.answers.delete(id);
                round.delivered.delete(id);
            }
        for (const answer of accepted) {
            if (!active.has(answer.id))
                continue;
            round.answers.set(answer.id, answer);
            round.delivered.delete(answer.id);
        }
        if (final)
            round.status = "submitted";
        round.updated = now;
        this.#emit(round);
        return { ok: true, errors };
    }
    cancel(roundID, reason, now) {
        const round = this.#rounds.get(roundID);
        if (round?.status !== "open")
            return false;
        round.status = "cancelled";
        round.reason = reason;
        round.updated = now;
        this.#emit(round);
        return true;
    }
    /** Drops a session's rounds, cancelling any open one. */
    remove(sessionID, now) {
        for (const round of [...this.#rounds.values()]) {
            if (round.sessionID !== sessionID)
                continue;
            this.cancel(round.id, "ended", now);
            this.#rounds.delete(round.id);
        }
    }
    /** Forgets closed rounds older than `ttlMs`, and returns their ids. */
    sweep(now, ttlMs) {
        const dropped = [];
        for (const [id, round] of this.#rounds)
            if (round.status !== "open" && !awaitsDelivery(round) && now - round.updated > ttlMs) {
                this.#rounds.delete(id);
                dropped.push(id);
            }
        return dropped;
    }
    /** Puts back rounds read from storage after a reload. Ones already known are left alone. */
    restore(restored) {
        for (const round of [...restored].sort((a, b) => a.created - b.created)) {
            if (this.#rounds.has(round.id))
                continue;
            this.#rounds.set(round.id, round);
            this.#counters.set(round.sessionID, Math.max(round.number, this.#counters.get(round.sessionID) ?? 0));
        }
    }
    subscribe(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    #emit(round) {
        for (const listener of [...this.#listeners])
            listener(round);
    }
}
/** A closed round whose answers still have to reach the session (being sent, or back with the user after failing). */
export const awaitsDelivery = (round) => round.delivery?.status === "pending" || round.delivery?.status === "failed";
const scoped = (round, ids) => visibleQuestions(round.questions, (id) => round.answers.get(id)?.value).map((question) => question.id).filter((id) => ids === undefined || ids.includes(id));
/** Whether a wait in `mode` is satisfied for the given ids. */
export function settled(round, mode, ids) {
    if (round.status !== "open" || mode === "none")
        return true;
    const wanted = scoped(round, ids);
    if (wanted.length === 0)
        return true;
    if (mode === "any")
        return wanted.some((id) => round.answers.has(id) && !round.delivered.has(id));
    return wanted.every((id) => round.answers.has(id));
}
/** Builds a tool result and marks the returned answers as delivered. */
export function collect(round, options = {}) {
    const wanted = scoped(round, options.ids);
    const fresh = wanted.filter((id) => round.answers.has(id) && !round.delivered.has(id));
    // `keep`: the caller marks them delivered itself, once the answers have really reached the agent.
    if (options.keep !== true)
        for (const id of fresh)
            round.delivered.add(id);
    const answers = fresh.map((id) => round.answers.get(id));
    const pending = wanted.filter((id) => !round.answers.has(id));
    const status = round.status === "submitted"
        ? "submitted"
        : round.status === "cancelled"
            ? round.reason === TIMEOUT
                ? "timeout"
                : "cancelled"
            : options.timedOut
                ? "timeout"
                : round.answers.size > 0
                    ? "partial"
                    : "open";
    return {
        status,
        ...(round.reason === undefined ? {} : { reason: round.reason }),
        round: round.number,
        round_id: round.id,
        answers,
        pending,
    };
}
export function view(round) {
    return {
        roundID: round.id,
        sessionID: round.sessionID,
        number: round.number,
        ...(round.title === undefined ? {} : { title: round.title }),
        status: round.status,
        questions: round.questions,
        answers: [...round.answers.values()].map(publicAnswer),
        ...(round.deadline === undefined ? {} : { deadline: round.deadline }),
        ...(round.callIDs.length === 0 ? {} : { callIDs: [...round.callIDs] }),
        ...(round.delivery?.status === "failed" ? { undelivered: round.delivery.error ?? "the message was not admitted" } : {}),
    };
}
/**
 * Resolves when the round satisfies `mode`, the timeout passes (0 = never) or the signal aborts.
 */
export function waitFor(rounds, round, options) {
    if (settled(round, options.mode, options.ids))
        return Promise.resolve("settled");
    if (options.signal?.aborted)
        return Promise.resolve("aborted");
    return new Promise((resolve) => {
        let timer;
        const finish = (outcome) => {
            unsubscribe();
            if (timer !== undefined)
                clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            resolve(outcome);
        };
        const onAbort = () => finish("aborted");
        const unsubscribe = rounds.subscribe((changed) => {
            if (changed.id === round.id && settled(round, options.mode, options.ids))
                finish("settled");
        });
        if (options.timeoutMs > 0)
            timer = setTimeout(() => finish("timeout"), options.timeoutMs);
        options.signal?.addEventListener("abort", onAbort, { once: true });
    });
}
