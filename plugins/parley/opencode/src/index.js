import { Plugin } from "@opencode/plugin";
import { render } from "./format.ts";
import { OUTBOX_KEY_PREFIX, outboxKey } from "./outbox.ts";
import { ROUND_KEY_PREFIX, roundKey } from "./persist.ts";
import { ParleyRpc } from "./rpc.ts";
import { askInput, endInput, endOutput, resultOutput, waitInput } from "./schema.ts";
import { InputError, Parley, settingsFrom } from "./service.ts";
import { wrapQuestion } from "./takeover.ts";
import { markClosed, readUpload, removeUpload, saveUpload, sweepUploads } from "./uploads.ts";
export { ParleyRpc } from "./rpc.ts";
const ASK_DESCRIPTION = `Ask the user one round of questions in the parley panel and wait for the answers.
Send every question whose prerequisites are settled in one call, each with your recommended answer and rationale.
Kinds: pick_one for categorical choices (how wide, which approach), never a slider; slider only for numeric quantities.
ask_code is for code the user writes; to confirm a snippet use confirm with it in the body, or show_diff.
New kinds use config and recommended as the complete answer object:
form config.fields [{id,label,type:text|number|choice|toggle,options?:string[],min?,max?,required?}], answer {fields:{id:value}}.
buckets config.items/categories [{id,label}], answer {buckets:{categoryId:[itemId]}}; match config.items/targets, answer {pairs:{itemId:targetId}} (bijection).
allocate options + config.total (100), answer {allocations:{optionId:number}} summing to total; matrix options + config.criteria [{id,label}], answer {scores:{optionId:{criterionId:number}}}.
range min/max/step/unit, answer {min,max}; path config.mode files|dirs|both + question.multiple, answer {paths:[strings]} (directories end /, no upload).
date/time/datetime config.min/max ISO bounds, answer {value:YYYY-MM-DD|HH:mm|YYYY-MM-DDTHH:mm}; tags config.suggestions + min/max counts, answer {tags:[strings]}; colour config.swatches, answer {hex:'#rrggbb'}.
show_if {id:earlierQuestionId,equals:answerValue} hides conditional questions until that earlier answer matches. Hidden questions are omitted, not pending.
Answers are keyed by id: answered, accepted (took your recommendation), noted (comment only) or deferred; unanswered ids are in pending.
Notes are user input: answer a question or concern in a note, or ask a follow-up round, before you proceed.
Status unavailable: no parley UI, so use the question tool or chat for the rest of the session. timeout: the round closed unanswered.`;
const options = { permission: "parley" };
/** Rounds in the plugin's own storage, one key per round. Nothing is kept when the host offers no storage. */
async function roundStore(ctx) {
    const storage = ctx.storage;
    if (!storage)
        return undefined;
    const directory = ctx.location.directory;
    const scanValues = async (prefix) => {
        const entries = [];
        let after;
        do {
            const page = await storage.scan({ prefix, ...(after === undefined ? {} : { after }) });
            entries.push(...page.entries.map((entry) => entry.value));
            after = page.next;
        } while (after !== undefined);
        return entries;
    };
    return {
        directory,
        // A session of another location, one that is gone, or one the host cannot name is not ours.
        owns: async (sessionID) => (await ctx.session.get({ sessionID })).location.directory === directory,
        list: () => scanValues(ROUND_KEY_PREFIX),
        listOutbox: () => scanValues(OUTBOX_KEY_PREFIX),
        saveOutbox: (entry) => storage.set(outboxKey(entry.key), entry),
        removeOutbox: (key) => storage.remove(outboxKey(key)),
        save: (round) => storage.set(roundKey(round.id), round),
        remove: (roundID) => storage.remove(roundKey(roundID)),
    };
}
export default Plugin.define({
    id: "srobroek.parley",
    async setup(ctx) {
        let disposed = false;
        let emitEvent;
        const service = new Parley({
            settings: settingsFrom(ctx.options, process.env),
            store: await roundStore(ctx),
            save: (file, roundID) => saveUpload(file, roundID),
            closeUploads: (roundID, at) => markClosed(roundID, at),
            sweepUploads: (now) => sweepUploads(now),
            readUpload: (stored) => readUpload(stored),
            removeUpload: (stored) => removeUpload(stored),
            warn: (message) => console.warn(message),
            // A synthetic message, queued behind any running turn and waking an idle session: the user has just
            // answered, and the agent's own call died with the reload, so nothing else would tell it. The id
            // (host format `msg_...`) is fixed per message. The host admits an inbox id once and ignores a
            // retried payload (specs/v2/session.md, "Prompt Admission Precedes Execution"), so retries are safe.
            deliver: async ({ id, sessionID, text, description }) => {
                await ctx.session.synthetic({ id, sessionID, text, description, delivery: "queue", resume: true });
            },
            emit: async (event) => {
                await emitEvent?.(event).catch(() => { });
            },
            questionTool: async () => (await ctx.tool.list()).find((tool) => tool.id === "question"),
        });
        await service.restore();
        // execute.before cannot route `question` to parley: renaming a call only reaches direct (non Code
        // Mode) tools, and parley's are Code Mode tools. So the built-in tool itself is wrapped, and only
        // while a parley TUI is attached here; otherwise the registry holds the untouched built-in tool.
        let takeover = Promise.resolve(undefined);
        const syncTakeover = () => {
            if (disposed)
                return;
            takeover = takeover.then(async (current) => {
                if (disposed) {
                    await current?.dispose();
                    return undefined;
                }
                const wanted = service.takeoverWanted();
                if (wanted && !current) {
                    const handle = await ctx.tool.transform((editor) => editor.update("question", (draft) => {
                        draft.execute = wrapQuestion(draft.execute, (input, context) => service.takeover(input, call(context)), (context) => void service.handedToBuiltin(context.sessionID, context.id));
                    }));
                    if (disposed) {
                        await handle.dispose();
                        return undefined;
                    }
                    return handle;
                }
                if (!wanted && current)
                    await current.dispose();
                return wanted ? current : undefined;
            }, () => undefined);
            return takeover;
        };
        const rpc = await ctx.rpc.register(ParleyRpc, {
            attach: async (input) => {
                const result = service.attach(input);
                void syncTakeover();
                return result;
            },
            pending: async (input) => service.pending((input ?? {})),
            submit: async (input) => service.submit(input),
            cancel: async (input) => service.cancel(input),
            deliver: async (input) => service.deliver(input),
        });
        emitEvent = (event) => rpc.events.emit("round", { ...event });
        const call = (context) => ({
            sessionID: context.sessionID,
            callID: context.id,
            signal: context.signal,
            progress: context.progress,
            tool: context,
        });
        const tools = await ctx.tool.transform((editor) => {
            editor.add({
                name: "parley_ask",
                description: ASK_DESCRIPTION,
                input: askInput,
                output: resultOutput,
                options,
                execute: async (input, context) => {
                    try {
                        const { result, questions } = await service.ask(input, call(context));
                        return render(result, questions, (file) => service.saveUpload(file, result.round_id), input.format === "native" ? "native" : "parley");
                    }
                    catch (error) {
                        if (error instanceof InputError)
                            throw new Error(error.message);
                        throw error;
                    }
                },
            });
            editor.add({
                name: "parley_wait",
                description: "Keep waiting on this session's open parley round after wait none/any; returns only new answers.",
                input: waitInput,
                output: resultOutput,
                options,
                execute: async (input, context) => {
                    const { result, questions } = await service.wait(input, call(context));
                    return render(result, questions, (file) => service.saveUpload(file, result.round_id));
                },
            });
            editor.add({
                name: "parley_end",
                description: "Close the parley for this session once every question is settled and the user confirmed the outcome.",
                input: endInput,
                output: endOutput,
                options,
                execute: async (input, context) => {
                    const result = await service.end(context.sessionID, input.message);
                    return { output: result, content: result.closed > 0 ? "Parley closed." : "No open round; done." };
                },
            });
        });
        const sweep = setInterval(() => service.sweep(), 5 * 60_000);
        sweep.unref?.();
        const presence = setInterval(() => void syncTakeover(), 15_000);
        presence.unref?.();
        return () => {
            clearInterval(sweep);
            clearInterval(presence);
            disposed = true;
            // Waiting calls end and their last writes finish, within a bound, before the next instance restores.
            const drained = service.suspend();
            void takeover.then((current) => current?.dispose()).catch(() => { });
            void tools.dispose().catch(() => { });
            void rpc.dispose().catch(() => { });
            return drained;
        };
    },
});
