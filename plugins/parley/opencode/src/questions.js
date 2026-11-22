import { isRecord } from "./guards.ts";
import { isStructured, NEW_KINDS, validateStructuredQuestion } from "./structured.ts";
export const PHASE_ONE_KINDS = [
    "pick_one",
    "show_options",
    "pick_many",
    "confirm",
    "rank",
    "slider",
    "ask_text",
    "review",
];
export const PHASE_TWO_KINDS = [
    "rate",
    "thumbs",
    "emoji_react",
    "show_diff",
    "ask_code",
    "ask_image",
    "ask_file",
];
export const KINDS = [...PHASE_ONE_KINDS, ...PHASE_TWO_KINDS, ...NEW_KINDS];
export const OPTION_KINDS = new Set(["pick_one", "show_options", "pick_many", "rank", "rate"]);
export const DEFAULT_EMOJIS = ["👍", "👎", "🎉", "🤔", "❤️", "🚀"];
export const MAX_QUESTIONS = 12;
const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
/** Semantic checks the JSON schema cannot express. Returns human-readable errors; empty means valid. */
export function validateQuestions(input, existing = []) {
    const errors = [];
    if (!Array.isArray(input) || input.length === 0)
        return ["questions must be a non-empty array"];
    if (input.length + existing.length > MAX_QUESTIONS)
        errors.push(`a round holds at most ${MAX_QUESTIONS} questions (have ${existing.length}, adding ${input.length})`);
    const seen = new Set(existing.map((question) => question.id));
    input.forEach((raw, index) => {
        const at = `questions[${index}]`;
        if (!isRecord(raw)) {
            errors.push(`${at} must be an object`);
            return;
        }
        const where = typeof raw.id === "string" ? `${at} (${raw.id})` : at;
        if (raw.show_if !== undefined) {
            const showIf = raw.show_if;
            if (!isRecord(showIf) || typeof showIf.id !== "string")
                errors.push(`${where}.show_if must be an object with an id`);
            else if (showIf.id === raw.id)
                errors.push(`${where}.show_if cannot refer to the question itself`);
            else if (!seen.has(showIf.id))
                errors.push(`${where}.show_if refers to ${JSON.stringify(showIf.id)}, which is not an earlier question`);
            if (isRecord(showIf) && !Object.hasOwn(showIf, "equals"))
                errors.push(`${where}.show_if.equals is required`);
        }
        if (typeof raw.id !== "string" || !QUESTION_ID.test(raw.id))
            errors.push(`${at}.id must match ${QUESTION_ID}`);
        else if (seen.has(raw.id))
            errors.push(`${where}: duplicate id`);
        else
            seen.add(raw.id);
        if (typeof raw.title !== "string" || raw.title.trim() === "")
            errors.push(`${where}.title is required`);
        if (typeof raw.kind !== "string" || !KINDS.includes(raw.kind)) {
            errors.push(`${where}.kind must be one of ${KINDS.join(", ")}`);
            return;
        }
        errors.push(...validateKind(raw, where));
    });
    return errors;
}
function validateKind(question, where) {
    if (isStructured(question))
        return validateStructuredQuestion(question).map((error) => `${where}: ${error}`);
    const errors = [];
    const options = question.options ?? [];
    const optionIDs = new Set();
    if (OPTION_KINDS.has(question.kind)) {
        if (options.length < 2)
            errors.push(`${where}.options needs at least 2 entries for ${question.kind}`);
        for (const option of options) {
            if (!isRecord(option) || typeof option.id !== "string" || !OPTION_ID.test(option.id)) {
                errors.push(`${where}.options: every option needs an id matching ${OPTION_ID}`);
                continue;
            }
            if (optionIDs.has(option.id))
                errors.push(`${where}.options: duplicate option id ${option.id}`);
            optionIDs.add(option.id);
            if (typeof option.label !== "string" || option.label === "")
                errors.push(`${where}.options.${option.id}.label is required`);
        }
    }
    const rec = question.recommended;
    const checkOption = (id) => {
        if (typeof id !== "string" || !optionIDs.has(id))
            errors.push(`${where}.recommended refers to unknown option ${JSON.stringify(id)}`);
    };
    switch (question.kind) {
        case "pick_one":
        case "show_options":
            if (rec !== undefined)
                checkOption(rec);
            break;
        case "pick_many": {
            if (rec !== undefined) {
                if (!isStringArray(rec))
                    errors.push(`${where}.recommended must be an array of option ids`);
                else
                    rec.forEach(checkOption);
            }
            const { min, max } = question;
            if (min !== undefined && max !== undefined && min > max)
                errors.push(`${where}: min must be <= max`);
            if (max !== undefined && max > options.length)
                errors.push(`${where}: max exceeds the number of options`);
            break;
        }
        case "rank":
            if (rec !== undefined) {
                if (!isStringArray(rec))
                    errors.push(`${where}.recommended must be an array of option ids`);
                else {
                    rec.forEach(checkOption);
                    if (new Set(rec).size !== rec.length)
                        errors.push(`${where}.recommended has duplicate ids`);
                }
            }
            break;
        case "confirm":
        case "thumbs": {
            const allowed = question.kind === "confirm" ? ["yes", "no"] : ["up", "down"];
            if (rec !== undefined && !allowed.includes(rec))
                errors.push(`${where}.recommended must be ${allowed.join(" or ")}`);
            break;
        }
        case "slider":
        case "rate": {
            const min = question.min ?? (question.kind === "rate" ? 1 : undefined);
            const max = question.max ?? (question.kind === "rate" ? 5 : undefined);
            if (typeof min !== "number" || typeof max !== "number")
                errors.push(`${where}: min and max are required`);
            else if (min >= max)
                errors.push(`${where}: min must be < max`);
            if (question.step !== undefined && !(question.step > 0))
                errors.push(`${where}.step must be positive`);
            if (question.kind === "slider" && rec !== undefined) {
                if (typeof rec !== "number")
                    errors.push(`${where}.recommended must be a number`);
                else if (typeof min === "number" && typeof max === "number" && (rec < min || rec > max))
                    errors.push(`${where}.recommended is outside min..max`);
            }
            if (question.kind === "rate" && rec !== undefined) {
                if (!isRecord(rec))
                    errors.push(`${where}.recommended must map option ids to numbers`);
                else
                    for (const key of Object.keys(rec))
                        checkOption(key);
            }
            break;
        }
        case "ask_text":
        case "ask_code":
            if (rec !== undefined && typeof rec !== "string")
                errors.push(`${where}.recommended must be a string`);
            break;
        case "review":
            if (question.markdown === undefined && question.sections === undefined && question.body === undefined)
                errors.push(`${where}: review needs markdown, sections or body`);
            if (rec !== undefined && rec !== "approve" && rec !== "revise")
                errors.push(`${where}.recommended must be approve or revise`);
            break;
        case "show_diff":
            if (typeof question.diff !== "string" || question.diff.trim() === "")
                errors.push(`${where}.diff (unified diff text) is required`);
            if (rec !== undefined && rec !== "approve" && rec !== "revise")
                errors.push(`${where}.recommended must be approve or revise`);
            break;
        case "emoji_react":
            if (rec !== undefined && typeof rec !== "string")
                errors.push(`${where}.recommended must be an emoji string`);
            break;
        case "ask_image":
        case "ask_file":
            break;
    }
    return errors;
}
/** The answer value a question starts with in the UI: its recommendation, or a neutral default. */
export function recommendedValue(question) {
    const rec = question.recommended;
    switch (question.kind) {
        case "pick_one":
        case "show_options":
            return rec === undefined ? undefined : { selected: rec };
        case "pick_many":
            return rec === undefined ? undefined : { selected: [...rec] };
        case "confirm":
        case "thumbs":
            return rec === undefined ? undefined : { choice: rec };
        case "rank": {
            if (rec === undefined)
                return undefined;
            const order = [...rec];
            for (const option of question.options ?? [])
                if (!order.includes(option.id))
                    order.push(option.id);
            return { order };
        }
        case "slider":
            return rec === undefined ? undefined : { value: rec };
        case "rate":
            return rec === undefined ? undefined : { ratings: { ...rec } };
        case "ask_text":
        case "ask_code":
            return rec === undefined ? undefined : { text: rec };
        case "review":
        case "show_diff":
            return rec === undefined ? undefined : { decision: rec };
        case "emoji_react":
            return rec === undefined ? undefined : { emoji: rec };
        case "ask_image":
        case "ask_file":
            return undefined;
        case "form":
        case "buckets":
        case "match":
        case "allocate":
        case "matrix":
        case "range":
        case "path":
        case "date":
        case "time":
        case "datetime":
        case "tags":
        case "colour":
            return rec === undefined ? undefined : structuredClone(rec);
    }
}
export function sliderBounds(question) {
    const min = question.min ?? (question.kind === "rate" ? 1 : 0);
    const max = question.max ?? (question.kind === "rate" ? 5 : 10);
    const step = question.step ?? 1;
    return { min, max, step };
}
/** The `labels` entry at a slider value (min, max, or the midpoint), if any. */
export function sliderAnchor(question, value) {
    const { min, max } = sliderBounds(question);
    const labels = question.labels;
    if (!labels)
        return undefined;
    if (value === min)
        return labels.min;
    if (value === max)
        return labels.max;
    return value === sliderMid(question) ? labels.mid : undefined;
}
/** The step nearest the middle of a slider's range. */
export function sliderMid(question) {
    const { min, max, step } = sliderBounds(question);
    return Number((Math.round((max - min) / 2 / step) * step + min).toFixed(10));
}
/**
 * A slider value as the user reads it: the label text when the value sits on a label, with the
 * number in brackets unless every value is labelled (a three-step scale reads as its labels).
 */
export function sliderText(question, value) {
    const { min, max, step } = sliderBounds(question);
    const number = `${value}${question.unit ? ` ${question.unit}` : ""}`;
    const label = sliderAnchor(question, value);
    if (label === undefined)
        return number;
    const count = Math.round((max - min) / step) + 1;
    const every = Array.from({ length: count }, (_, index) => Number((min + index * step).toFixed(10)));
    return count <= 3 && every.every((at) => sliderAnchor(question, at) !== undefined) ? label : `${label} (${number})`;
}
export function optionLabel(question, id) {
    return question.options?.find((option) => option.id === id)?.label ?? id;
}
const NUMERIC_FIELDS = ["min", "max", "step"];
const toNumber = (value) => typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : value;
/** Repairs common model slips before validation: numbers sent as strings, ids sent as numbers. */
export function coerceQuestion(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        return raw;
    const question = { ...raw };
    for (const field of NUMERIC_FIELDS)
        if (field in question)
            question[field] = toNumber(question[field]);
    if (question.kind === "slider")
        question.recommended = toNumber(question.recommended);
    if (typeof question.id === "number")
        question.id = String(question.id);
    if (Array.isArray(question.options))
        question.options = question.options.map((option) => typeof option === "object" && option !== null && typeof option.id === "number"
            ? { ...option, id: String(option.id) }
            : option);
    return question;
}
