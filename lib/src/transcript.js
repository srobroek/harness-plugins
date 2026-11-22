/**
 * The source-neutral transcript model and the OpenCode V2 message normalizer.
 *
 * A turn is a user (or shell, or skill) message plus every following assistant,
 * synthetic and system message up to and including the next `idle`. Without an
 * idle marker a turn runs to the next user message.
 */
import { writeTargets } from "./tool-targets.ts";
import { clip, oneLine } from "./transcript-text.ts";
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
const str = (value) => (typeof value === "string" ? value : "");
export function newTurn(kind, time, user = "") {
    return {
        time,
        kind,
        user,
        attachments: [],
        assistant: [],
        reasoning: [],
        tools: [],
        notes: [],
        files: [],
        shells: [],
        parts: [],
    };
}
export function addText(turn, text) {
    turn.assistant.push(text);
    turn.parts.push({ type: "text", text });
}
export function addReasoning(turn, text) {
    turn.reasoning.push(text);
    turn.parts.push({ type: "reasoning", text });
}
export function addTrace(turn, trace) {
    turn.tools.push(trace);
    turn.parts.push({ type: "tool", trace });
}
/** A turn with nothing a reader can use: no user text, prose, reasoning or tool call. */
export function isEmptyTurn(turn) {
    return (!turn.user.trim() &&
        turn.assistant.every((text) => !text.trim()) &&
        turn.reasoning.length === 0 &&
        turn.tools.length === 0 &&
        turn.shells.length === 0);
}
const BRIEF_KEYS = ["description", "path", "command", "pattern", "url", "query", "id", "agent", "file", "task", "i"];
/** One short argument echo per tool call, never the whole payload. */
export function briefArgs(args) {
    if (!isRecord(args))
        return "";
    for (const key of BRIEF_KEYS) {
        const value = args[key];
        if (typeof value === "string" && value.trim())
            return oneLine(clip(value, 120));
        if (typeof value === "number" || typeof value === "boolean")
            return String(value);
    }
    return "";
}
/** The first text content of a tool result, one line, or a file name. */
export function contentText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    for (const part of content) {
        if (!isRecord(part))
            continue;
        if (part.type === "text" && typeof part.text === "string")
            return part.text;
        if (part.type === "file")
            return `[file ${str(part.name) || str(part.mime) || "attachment"}]`;
    }
    return "";
}
/** Every text content of a tool result, joined; used for branch evidence. */
function allText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
}
function metadataFiles(metadata) {
    if (!isRecord(metadata) || !Array.isArray(metadata.files))
        return [];
    const out = [];
    for (const file of metadata.files) {
        if (typeof file === "string")
            out.push(file);
        else if (isRecord(file)) {
            const path = str(file.path) || str(file.file) || str(file.filePath);
            if (path)
                out.push(path);
        }
    }
    return out;
}
const shortTool = (name) => name.split(".").pop() ?? name;
/** Fold one assistant tool part into a turn: its trace, files, shell runs and nested execute calls. */
export function applyToolPart(turn, part) {
    const name = str(part.name) || "?";
    const state = isRecord(part.state) ? part.state : {};
    const input = state.input;
    const status = str(state.status);
    let result = "";
    let error = false;
    if (status === "completed")
        result = contentText(state.content);
    else if (status === "error") {
        error = true;
        result = isRecord(state.error) ? str(state.error.message) : contentText(state.content);
    }
    else if (status)
        result = `(${status})`;
    const trace = { name, brief: briefArgs(input), result: clip(oneLine(result), 240), error };
    const metadata = state.metadata;
    if (name === "subagent" && isRecord(metadata) && typeof metadata.sessionID === "string")
        trace.child = metadata.sessionID;
    addTrace(turn, trace);
    turn.files.push(...writeTargets(name, input), ...metadataFiles(metadata));
    if (name === "shell" && isRecord(input) && typeof input.command === "string") {
        turn.shells.push({ command: input.command, output: allText(state.content) });
    }
    if (name === "execute" && isRecord(metadata) && Array.isArray(metadata.toolCalls)) {
        for (const call of metadata.toolCalls) {
            if (!isRecord(call))
                continue;
            const tool = str(call.tool) || "?";
            const callStatus = str(call.status);
            addTrace(turn, {
                name: `execute.${tool}`,
                brief: briefArgs(call.input),
                result: callStatus && callStatus !== "completed" ? `(${callStatus})` : "",
                error: callStatus === "error",
                nested: true,
            });
            const short = shortTool(tool);
            turn.files.push(...writeTargets(short, call.input));
            if (short === "shell" && isRecord(call.input) && typeof call.input.command === "string") {
                turn.shells.push({ command: call.input.command, output: "" });
            }
        }
    }
}
/** `## Heading` sections of a compaction summary, each clipped. */
export function compactionSections(summary, limit = 600) {
    const sections = [];
    let current;
    const body = [];
    const flush = () => {
        if (current)
            sections.push({ heading: current.heading, body: clip(body.join("\n").trim(), limit) });
        body.length = 0;
    };
    for (const line of summary.split("\n")) {
        const heading = /^##\s+(.+?)\s*$/.exec(line);
        if (heading?.[1]) {
            flush();
            current = { heading: heading[1], body: "" };
            continue;
        }
        if (current)
            body.push(line);
    }
    flush();
    return sections;
}
export function section(compaction, heading) {
    const wanted = heading.toLowerCase();
    return compaction?.sections.find((entry) => entry.heading.toLowerCase() === wanted)?.body;
}
/** Drop empty turns and move the compaction boundary onto the kept turns. */
export function finishTurns(turns, boundary) {
    const kept = [];
    let keptBoundary = -1;
    turns.forEach((turn, index) => {
        if (index >= boundary && keptBoundary < 0)
            keptBoundary = kept.length;
        if (!isEmptyTurn(turn))
            kept.push(turn);
    });
    return { turns: kept, boundary: keptBoundary < 0 ? kept.length : keptBoundary };
}
/** Normalize OpenCode V2 session messages (from `context()` or the message API) into turns. */
export function toTranscript(messages, options = {}) {
    const turns = [];
    const compactions = [];
    const locations = [];
    let boundary = 0;
    let current;
    const open = (time) => {
        if (current === undefined || current.ended !== undefined) {
            current = newTurn("orphan", time);
            turns.push(current);
        }
        return current;
    };
    const start = (kind, time, user) => {
        current = newTurn(kind, time, user);
        turns.push(current);
        return current;
    };
    for (const raw of messages) {
        if (!isRecord(raw))
            continue;
        const time = isRecord(raw.time) && typeof raw.time.created === "number" ? raw.time.created : null;
        switch (raw.type) {
            case "user": {
                const turn = start("user", time, str(raw.text));
                if (Array.isArray(raw.files)) {
                    for (const file of raw.files) {
                        if (isRecord(file))
                            turn.attachments.push(str(file.name) || str(file.mime) || "attachment");
                    }
                }
                break;
            }
            case "shell": {
                const output = isRecord(raw.output) ? str(raw.output.output) : "";
                const turn = start("shell", time, `$ ${str(raw.command)}`);
                turn.shells.push({ command: str(raw.command), output });
                break;
            }
            case "skill": {
                const name = str(raw.name) || str(raw.skill);
                const usable = current && current.ended === undefined && current.assistant.length === 0 && current.tools.length === 0;
                if (usable && current)
                    current.notes.push(`skill: ${name}`);
                else
                    start("skill", time, `/${name}`);
                break;
            }
            case "assistant": {
                const turn = open(time);
                if (Array.isArray(raw.content)) {
                    for (const part of raw.content) {
                        if (!isRecord(part))
                            continue;
                        if (part.type === "text" && typeof part.text === "string")
                            addText(turn, part.text);
                        else if (part.type === "reasoning" && options.includeReasoning && typeof part.text === "string")
                            addReasoning(turn, part.text);
                        else if (part.type === "tool")
                            applyToolPart(turn, part);
                    }
                }
                if (isRecord(raw.snapshot))
                    turn.files.push(...metadataFiles(raw.snapshot));
                if (typeof raw.finish === "string")
                    turn.finish = raw.finish;
                if (isRecord(raw.error))
                    turn.error = str(raw.error.message) || str(raw.error.type);
                break;
            }
            case "synthetic": {
                const turn = open(time);
                const description = oneLine(str(raw.description));
                turn.notes.push(`synthetic: ${description || clip(oneLine(str(raw.text)), 120)}`);
                break;
            }
            case "compaction": {
                if (raw.status !== "completed")
                    break;
                const summary = str(raw.summary);
                compactions.push({ time, summary, sections: compactionSections(summary) });
                current = undefined;
                boundary = turns.length;
                break;
            }
            case "idle": {
                if (current && current.ended === undefined) {
                    current.ended = (str(raw.outcome) || "succeeded");
                    if (isRecord(raw.error))
                        current.error = str(raw.error.message) || current.error;
                }
                break;
            }
            case "location-switched": {
                const directory = isRecord(raw.location) ? str(raw.location.directory) : "";
                if (directory)
                    locations.push(directory);
                break;
            }
            default:
                break;
        }
    }
    const finished = finishTurns(turns, boundary);
    return { ...finished, compactions, locations, messages: messages.length };
}
