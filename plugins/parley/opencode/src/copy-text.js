import { optionLabel } from "./questions.ts";
/** Plain text of the focused card, excluding uploaded bytes and UI/key hints. */
export function cardText(question, draft) {
    const value = draft.value;
    const label = (id) => typeof id === "string" ? optionLabel(question, id) : String(id);
    let answer = "";
    if (value) {
        if (typeof value.text === "string")
            answer = value.text;
        else if (Array.isArray(value.files))
            answer = value.files.map((file) => file.path ?? file.name).join("\n");
        else if (Array.isArray(value.selected))
            answer = value.selected.map(label).join(", ");
        else if (Array.isArray(value.order))
            answer = value.order.map(label).join(" → ");
        else if (typeof value.selected === "string")
            answer = label(value.selected);
        else if (typeof value.value === "number")
            answer = `${value.value}${question.unit ? ` ${question.unit}` : ""}`;
        else
            answer = JSON.stringify(value, null, 2);
    }
    return [question.title, question.body, question.markdown, ...(question.sections ?? []).map((section) => `${section.title}\n${section.content}`), question.diff,
        answer === "" ? undefined : `Answer:\n${answer}`, draft.note === "" ? undefined : `Note:\n${draft.note}`]
        .filter((part) => part !== undefined && part !== "").join("\n\n");
}
