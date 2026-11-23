import { ANSWER_STATUSES } from "./answers.ts"
import { KINDS, MAX_QUESTIONS } from "./questions.ts"

/** The tool descriptions every host registers verbatim: skills and agents rely on this wording. */
export const ASK_DESCRIPTION = `Ask the user one round of questions in the parley panel and wait for the answers.
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
Status unavailable: no parley UI, so use the question tool or chat for the rest of the session. timeout: the round closed unanswered.`

export const WAIT_DESCRIPTION = "Keep waiting on this session's open parley round after wait none/any; returns only new answers."

export const END_DESCRIPTION = "Close the parley for this session once every question is settled and the user confirmed the outcome."

const option = {
  type: "object",
  required: ["id", "label"],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    description: { type: "string" },
    pros: { type: "array", items: { type: "string" } },
    cons: { type: "array", items: { type: "string" } },
  },
} as const

export const questionSchema = {
  type: "object",
  required: ["id", "title", "kind"],
  properties: {
    id: { type: "string", description: "Stable answer key" },
    title: { type: "string" },
    kind: { type: "string", enum: [...KINDS] },
    body: { type: "string", description: "Markdown" },
    rationale: { type: "string", description: "One line on why you recommend it" },
    recommended: {
      description:
        "Preselected; new kinds use the full answer object",
    },
    options: { type: "array", items: option },
    allow_other: { type: "boolean", description: "Free text: pick_one/pick_many default true, slider false" },
    allow_defer: { type: "boolean" },
    depends_on: { type: "array", items: { type: "string" } },
    min: { type: "number" },
    max: { type: "number" },
    step: { type: "number" },
    unit: { type: "string" },
    labels: {
      type: "object",
      properties: { min: { type: "string" }, mid: { type: "string" }, max: { type: "string" } },
    },
    yes_label: { type: "string" },
    no_label: { type: "string" },
    placeholder: { type: "string" },
    multiline: { type: "boolean" },
    markdown: { type: "string", description: "review: the plan to approve" },
    sections: {
      type: "array",
      description: "review",
      items: {
        type: "object",
        required: ["id", "title", "content"],
        properties: { id: { type: "string" }, title: { type: "string" }, content: { type: "string" } },
      },
    },
    diff: { type: "string", description: "show_diff: unified diff" },
    language: { type: "string", description: "ask_code/show_diff" },
    emojis: { type: "array", items: { type: "string" } },
    multiple: { type: "boolean", description: "path/ask_image/ask_file" },
    accept: { type: "array", items: { type: "string" }, description: "ask_file extensions" },
    config: { type: "object", description: "Kind-specific fields; see tool description and README" },
    show_if: { type: "object", required: ["id", "equals"], properties: { id: { type: "string" }, equals: {} }, description: "Earlier answer value must equal equals" },
  },
} as const

export const askInput = {
  type: "object",
  required: ["questions"],
  properties: {
    title: { type: "string", description: "Shown above the round, e.g. the plan" },
    round: { type: "integer", minimum: 1 },
    wait: {
      type: "string",
      enum: ["all", "any", "none"],
      description: "all (default): until submitted; any: first answer; none: return at once",
    },
    timeout_s: {
      type: "integer",
      minimum: 0,
      description: "Default 1800; 0 waits without limit. When it passes the round closes",
    },
    format: {
      type: "string",
      enum: ["parley", "native"],
      description: "native: word the answers like the question tool",
    },
    questions: { type: "array", minItems: 1, maxItems: MAX_QUESTIONS, items: questionSchema },
  },
} as const

export const waitInput = {
  type: "object",
  properties: {
    wait: { type: "string", enum: ["all", "any"] },
    ids: { type: "array", items: { type: "string" } },
    timeout_s: { type: "integer", minimum: 0 },
  },
} as const

export const endInput = {
  type: "object",
  properties: { message: { type: "string", description: "Shown to the user when the parley closes" } },
} as const

const answer = {
  type: "object",
  required: ["id", "status"],
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: [...ANSWER_STATUSES] },
    value: {},
    note: { type: "string" },
    accepted_recommendation: { type: "boolean" },
  },
} as const

export const resultOutput = {
  type: "object",
  required: ["status", "answers", "pending"],
  properties: {
    status: { type: "string", enum: ["submitted", "open", "partial", "timeout", "cancelled", "unavailable", "none"] },
    reason: { type: "string" },
    channel: { type: "string", enum: ["tui", "question"] },
    round: { type: "integer" },
    round_id: { type: "string" },
    answers: { type: "array", items: answer },
    pending: { type: "array", items: { type: "string" } },
    as_message: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["delivered", "sending", "dismissed"] },
        ids: { type: "array", items: { type: "string" } },
        error: { type: "string" },
      },
    },
  },
} as const

export const endOutput = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" }, closed: { type: "integer" } },
} as const
