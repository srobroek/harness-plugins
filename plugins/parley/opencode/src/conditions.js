import { canonical } from "./answers.ts";
/** Only earlier visible, answered questions can satisfy a condition; chains never resurrect hidden answers. */
export function visibleQuestions(questions, value) {
    const visible = [];
    const ids = new Set();
    for (const question of questions) {
        const condition = question.show_if;
        if (condition && (!ids.has(condition.id) || value(condition.id) === undefined || canonical(value(condition.id)) !== canonical(condition.equals)))
            continue;
        visible.push(question);
        ids.add(question.id);
    }
    return visible;
}
