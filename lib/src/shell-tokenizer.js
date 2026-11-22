/**
 * Static shell tokenization shared by the guards in this repository.
 *
 * Ported from omp-plugins (`beads/extensions/shell-tokenizer.ts`). This is
 * deliberately a lexer, never a shell evaluator.
 *
 * A here-document is queued when its redirection is read. At the following
 * newline, a quoted delimiter makes the body inert data; an unquoted delimiter
 * feeds the body back through this same lexer. That mirrors the shell rule
 * that only an unquoted here-document expands substitutions, without ever
 * expanding or executing one here. Consumers that read every word as a command
 * opt into `hereDocumentSubstitutionsOnly`, which lexes only the `$( … )` and
 * backtick substitutions of an unquoted body, each wrapped in `$(` … `)`.
 */
const SEPARATORS = new Set([";", "&", "|", "(", ")", "\n"]);
function token(value, startsQuoted = false, sawQuote = false) {
    return { value, startsQuoted, sawQuote };
}
/** Tokenize command-shaped source without invoking a shell. */
export function tokenizeShell(command, options = {}) {
    if (typeof command !== "string")
        return [];
    const out = [];
    let current = "";
    let started = false;
    let startsQuoted = false;
    let sawQuote = false;
    let quote = null;
    const pending = [];
    const flush = () => {
        if (!started)
            return;
        out.push(token(current, startsQuoted, sawQuote));
        current = "";
        started = false;
        startsQuoted = false;
        sawQuote = false;
    };
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote !== null) {
            if (ch === quote) {
                quote = null;
                continue;
            }
            current += ch;
            started = true;
            continue;
        }
        if (ch === '"' || ch === "'") {
            if (!started)
                startsQuoted = true;
            started = true;
            sawQuote = true;
            quote = ch;
            continue;
        }
        if (ch === "\\" && i + 1 < command.length) {
            if (options.preserveBackslashes)
                current += ch;
            current += command[++i];
            started = true;
            continue;
        }
        if (ch === "$" && command[i + 1] === "(") {
            flush();
            out.push(token("$("));
            i++;
            continue;
        }
        if (ch === "<" && command[i + 1] === "<" && command[i + 2] === "<") {
            flush();
            out.push(token("<<<"));
            i += 2;
            continue;
        }
        if (ch === "<" && command[i + 1] === "<") {
            const operator = hereDocumentOperator(command, i);
            if (operator !== null) {
                flush();
                pending.push(operator);
                i = operator.end - 1;
                continue;
            }
        }
        if (ch === "\n") {
            flush();
            out.push(token(ch));
            let bodyStart = i + 1;
            while (pending.length > 0) {
                const document = pending.shift();
                if (document === undefined)
                    break;
                const body = hereDocumentBody(command, bodyStart, document);
                if (!document.quoted) {
                    const source = command.slice(bodyStart, body.bodyEnd);
                    if (options.hereDocumentSubstitutionsOnly)
                        out.push(...substitutions(source, options));
                    else
                        out.push(...tokenizeShell(source, options));
                }
                i = body.terminatorEnd;
                bodyStart = i + 1;
            }
            continue;
        }
        if (/\s/.test(ch)) {
            flush();
            continue;
        }
        if (SEPARATORS.has(ch)) {
            flush();
            out.push(token(ch));
            continue;
        }
        current += ch;
        started = true;
    }
    flush();
    return out;
}
/** Whether the source ends outside a single- or double-quoted word. */
export function shellQuoteBalanced(command) {
    if (typeof command !== "string")
        return true;
    let quote = null;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote !== null) {
            if (ch === quote)
                quote = null;
            continue;
        }
        if (ch === '"' || ch === "'")
            quote = ch;
        else if (ch === "\\")
            i++;
    }
    return quote === null;
}
function hereDocumentOperator(command, start) {
    let i = start + 2;
    const stripTabs = command[i] === "-";
    if (stripTabs)
        i++;
    while (command[i] === " " || command[i] === "\t")
        i++;
    let delimiter = "";
    let quoted = false;
    let quote = null;
    while (i < command.length) {
        const ch = command[i];
        if (quote !== null) {
            if (ch === quote) {
                quote = null;
                i++;
                continue;
            }
            delimiter += ch;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quoted = true;
            quote = ch;
            i++;
            continue;
        }
        if (ch === "\\" && i + 1 < command.length) {
            quoted = true;
            delimiter += command[i + 1];
            i += 2;
            continue;
        }
        if (/\s|[;&|<>()]/.test(ch))
            break;
        delimiter += ch;
        i++;
    }
    if (quote !== null || delimiter.length === 0)
        return null;
    return { delimiter, stripTabs, quoted, end: i };
}
function hereDocumentBody(command, from, document) {
    let cursor = from;
    while (cursor < command.length) {
        let next = command.indexOf("\n", cursor);
        if (next === -1)
            next = command.length;
        let line = command.slice(cursor, next);
        if (document.stripTabs)
            line = line.replace(/^\t+/, "");
        if (line === document.delimiter)
            return { bodyEnd: cursor, terminatorEnd: next };
        if (next === command.length)
            break;
        cursor = next + 1;
    }
    return { bodyEnd: command.length, terminatorEnd: command.length };
}
/** Tokens of each `$( … )` and backtick substitution in an unquoted here-document body. */
function substitutions(body, options) {
    const out = [];
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === "\\") {
            i++;
            continue;
        }
        let inner;
        if (ch === "$" && body[i + 1] === "(") {
            const end = substitutionEnd(body, i + 2);
            inner = body.slice(i + 2, end);
            i = end;
            // `$(( … ))` is arithmetic, not a command.
            if (inner.startsWith("("))
                continue;
        }
        else if (ch === "`") {
            let end = i + 1;
            while (end < body.length && body[end] !== "`")
                end += body[end] === "\\" ? 2 : 1;
            inner = body.slice(i + 1, end);
            i = end;
        }
        else {
            continue;
        }
        out.push(token("$("), ...tokenizeShell(inner, options), token(")"));
    }
    return out;
}
/** Index of the `)` closing a substitution whose content starts at `from`, or the body length. */
function substitutionEnd(body, from) {
    let depth = 1;
    let quote = null;
    for (let i = from; i < body.length; i++) {
        const ch = body[i];
        if (quote !== null) {
            if (ch === quote)
                quote = null;
            else if (ch === "\\" && quote === '"')
                i++;
            continue;
        }
        if (ch === "\\")
            i++;
        else if (ch === '"' || ch === "'")
            quote = ch;
        else if (ch === "(")
            depth++;
        else if (ch === ")" && --depth === 0)
            return i;
    }
    return body.length;
}
