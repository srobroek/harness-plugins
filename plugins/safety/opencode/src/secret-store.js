/**
 * `safety_secret_store`: store a new secret without a shell. The value is generated here from a CSPRNG,
 * or read from the stdout of a command run as argv with no shell, and only ever leaves this process on a
 * child's stdin: the JSON item template piped to `op item create --vault <vault> -`, or the value piped
 * to `fnox set NAME --provider <store>`. It never reaches an argv, an environment, a log, an error or the
 * result, and its buffers are zeroed once the store is done.
 *
 * Child output is never reported: a failure names the stage and the exit code only. Nothing is retried,
 * so a 1Password approval that fails or times out stops the call.
 */
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { EXIT_GRACE_MS, killChild, supervise } from "@srobroek/opencode-lib/subprocess";
import { externalDirectories } from "./flag-directories.ts";
import { VALUE_STORE_TYPES } from "./op-guard.ts";
export const STORE_ACTION = "safety_secret_store";
/** The permission each command run asks for; the plugin turns an `allow` into an `ask`. */
export const COMMAND_ACTION = "safety_secret_command";
/** The most stdout a command may print; more stops it. */
export const STDOUT_CAP = 64 * 1024;
export const MIN_ENTROPY_BITS = 128;
export const MAX_LENGTH = 4096;
export const COMMAND_TIMEOUT_MS = 120_000;
/** `op` waits for the user to approve in 1Password. */
export const OP_TIMEOUT_MS = 120_000;
export const FNOX_TIMEOUT_MS = 60_000;
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
/** Printable ASCII without the space, which fnox would trim from either end. */
const PRINTABLE = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)).join("");
const ALPHABETS = {
    hex: new TextEncoder().encode("0123456789abcdef"),
    base64url: new TextEncoder().encode(`${UPPER}${LOWER}${DIGITS}-_`),
    alnum: new TextEncoder().encode(`${UPPER}${LOWER}${DIGITS}`),
    "ascii-printable": new TextEncoder().encode(PRINTABLE),
};
export class SecretStoreError extends Error {
}
const fail = (message) => {
    throw new SecretStoreError(`safety_secret_store: ${message}`);
};
const NAME = /^[A-Z][A-Z0-9_]*$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse control characters.
const CONTROL = /[\u0000-\u001f\u007f]/;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function only(record, keys, what) {
    const extra = Object.keys(record).filter((key) => !keys.includes(key));
    if (extra.length > 0)
        fail(`${what} has unknown field ${extra.join(", ")}`);
}
/** A short single-line string: no control characters, at most `max` characters. */
function text(value, what, max = 200) {
    if (typeof value !== "string" || value.length === 0 || value.length > max || CONTROL.test(value)) {
        return fail(`${what} must be a non-empty line of at most ${max} characters`);
    }
    return value;
}
function count(value, what) {
    if (!Number.isInteger(value) || value < 1)
        return fail(`${what} must be a positive integer`);
    return value;
}
function parseTarget(value) {
    if (!isRecord(value))
        return fail("target must be an object");
    if (value.kind === "1password") {
        only(value, ["kind", "vault", "item", "field", "tags", "provider"], "target");
        const item = text(value.item, "target.item");
        if (item.includes("/"))
            fail("target.item may not contain '/', which ends the item in a fnox reference");
        const field = value.field === undefined ? "credential" : text(value.field, "target.field", 64);
        if (!FIELD.test(field))
            fail("target.field must be a field id such as credential");
        const tags = value.tags === undefined ? [] : value.tags;
        if (!Array.isArray(tags) || tags.length > 20)
            fail("target.tags must be a list of at most 20 tags");
        const target = {
            kind: "1password",
            vault: text(value.vault, "target.vault"),
            item,
            field,
            tags: tags.map((tag) => text(tag, "target.tags[]", 100)),
        };
        if (target.vault.includes("/"))
            fail("target.vault may not contain '/', which would break an op:// reference");
        if (value.provider !== undefined)
            target.provider = provider(value.provider, "target.provider");
        return target;
    }
    if (value.kind === "fnox-store") {
        only(value, ["kind", "provider"], "target");
        return { kind: "fnox-store", provider: provider(value.provider, "target.provider") };
    }
    return fail('target.kind must be "1password" or "fnox-store"');
}
function provider(value, what) {
    const name = text(value, what, 64);
    if (!PROVIDER.test(name))
        fail(`${what} must be a fnox provider name`);
    return name;
}
function parseGenerate(value) {
    if (!isRecord(value))
        return fail("generate must be an object");
    only(value, ["charset", "bytes", "length"], "generate");
    const charset = value.charset;
    if (typeof charset !== "string" || !Object.hasOwn(ALPHABETS, charset)) {
        return fail("generate.charset must be hex, base64url, alnum or ascii-printable");
    }
    if ((value.bytes === undefined) === (value.length === undefined))
        fail("generate takes one of bytes or length");
    const bits = Math.log2(ALPHABETS[charset].length);
    // `bytes` asks for that much entropy: the characters it takes in this charset (hex 2 per byte, base64url 4 per 3).
    const length = value.bytes !== undefined ? Math.ceil((count(value.bytes, "generate.bytes") * 8) / bits) : count(value.length, "generate.length");
    if (length * bits < MIN_ENTROPY_BITS - 1e-9)
        fail(`generate must give at least ${MIN_ENTROPY_BITS} bits (16 bytes)`);
    if (length > MAX_LENGTH)
        fail(`generate gives at most ${MAX_LENGTH} characters`);
    return { kind: "generate", charset, length };
}
function parseCommand(value) {
    if (!isRecord(value))
        return fail("command must be an object");
    only(value, ["argv", "cwd"], "command");
    const argv = value.argv;
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((word) => typeof word !== "string" || word.includes("\0"))) {
        return fail("command.argv must be a non-empty list of strings");
    }
    if (argv[0] === "")
        fail("command.argv[0] must name a program");
    return { kind: "command", argv: [...argv], ...(value.cwd === undefined ? {} : { cwd: text(value.cwd, "command.cwd", 4096) }) };
}
/** The validated request; throws a SecretStoreError naming the first bad field. */
export function parseRequest(input) {
    if (!isRecord(input))
        return fail("input must be an object");
    only(input, ["name", "target", "generate", "command", "config", "description"], "input");
    if (typeof input.name !== "string" || !NAME.test(input.name) || input.name.length > 128) {
        fail("name must match ^[A-Z][A-Z0-9_]*$");
    }
    if ((input.generate === undefined) === (input.command === undefined))
        fail("give exactly one of generate or command");
    const request = {
        name: input.name,
        target: parseTarget(input.target),
        source: input.generate !== undefined ? parseGenerate(input.generate) : parseCommand(input.command),
    };
    if (input.config !== undefined) {
        request.config = text(input.config, "config", 4096);
        if (request.config.startsWith("-"))
            fail("config must be a file path");
    }
    if (input.description !== undefined)
        request.description = text(input.description, "description");
    return request;
}
/** `length` characters drawn uniformly from the charset: random bytes past the largest multiple of its size are dropped. */
export function generateSecret(charset, length, random = (bytes) => void crypto.getRandomValues(bytes)) {
    const alphabet = ALPHABETS[charset];
    const limit = 256 - (256 % alphabet.length);
    const out = new Uint8Array(length);
    const pool = new Uint8Array(Math.max(64, length));
    let filled = 0;
    try {
        while (filled < length) {
            random(pool);
            for (let i = 0; i < pool.length && filled < length; i++) {
                const byte = pool[i];
                if (byte < limit)
                    out[filled++] = alphabet[byte % alphabet.length];
            }
        }
    }
    finally {
        pool.fill(0);
    }
    return out;
}
function validUtf8(bytes) {
    for (let i = 0; i < bytes.length;) {
        const lead = bytes[i];
        if (lead < 0x80) {
            i++;
            continue;
        }
        const tail = lead >= 0xc2 && lead <= 0xdf ? 1 : lead >= 0xe0 && lead <= 0xef ? 2 : lead >= 0xf0 && lead <= 0xf4 ? 3 : -1;
        if (tail < 0)
            return false;
        let point = lead & (0x3f >> tail);
        for (let k = 1; k <= tail; k++) {
            const next = bytes[i + k];
            if (next === undefined || (next & 0xc0) !== 0x80)
                return false;
            point = (point << 6) | (next & 0x3f);
        }
        const min = tail === 1 ? 0x80 : tail === 2 ? 0x800 : 0x10000;
        if (point < min || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
            return false;
        i += tail + 1;
    }
    return true;
}
/** A command's stdout as the secret: one trailing newline (LF or CRLF) dropped; refused when empty, with a NUL byte or not UTF-8. */
export function commandSecret(stdout) {
    let end = stdout.length;
    if (stdout[end - 1] === 0x0a)
        end -= stdout[end - 2] === 0x0d ? 2 : 1;
    if (end === 0)
        fail("the command printed no value");
    const value = stdout.slice(0, end);
    if (value.includes(0) || !validUtf8(value)) {
        value.fill(0);
        fail("the command printed a NUL byte or text that is not UTF-8");
    }
    return value;
}
/** Unicode White_Space, which fnox's trim of a piped value removes from either end. */
function whitespace(point) {
    return ((point >= 0x09 && point <= 0x0d) ||
        point === 0x20 ||
        point === 0x85 ||
        point === 0xa0 ||
        point === 0x1680 ||
        (point >= 0x2000 && point <= 0x200a) ||
        point === 0x2028 ||
        point === 0x2029 ||
        point === 0x202f ||
        point === 0x205f ||
        point === 0x3000);
}
/** The code point of the valid UTF-8 sequence starting at `at`. */
function pointAt(bytes, at) {
    const lead = bytes[at];
    const tail = lead < 0x80 ? 0 : lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : 3;
    let point = tail === 0 ? lead : lead & (0x3f >> tail);
    for (let k = 1; k <= tail; k++)
        point = (point << 6) | (bytes[at + k] & 0x3f);
    return point;
}
/** Whether valid UTF-8 `bytes` start or end with whitespace, read without making a string of them. */
function edgeWhitespace(bytes) {
    if (bytes.length === 0)
        return false;
    let last = bytes.length - 1;
    while (last > 0 && (bytes[last] & 0xc0) === 0x80)
        last--;
    return whitespace(pointAt(bytes, 0)) || whitespace(pointAt(bytes, last));
}
/** The JSON template `op item create -` reads: the value is escaped byte by byte, never held as a string. */
export function itemTemplate(target, value) {
    const encoder = new TextEncoder();
    const head = encoder.encode(`{"title":${JSON.stringify(target.item)},"category":"API_CREDENTIAL","tags":${JSON.stringify(target.tags)},"fields":[{"id":${JSON.stringify(target.field)},"label":${JSON.stringify(target.field)},"type":"CONCEALED","value":"`);
    const tail = encoder.encode(`"}]}`);
    let size = head.length + tail.length;
    for (const byte of value)
        size += byte === 0x22 || byte === 0x5c ? 2 : byte < 0x20 ? 6 : 1;
    const out = new Uint8Array(size);
    out.set(head);
    let at = head.length;
    const hex = encoder.encode("0123456789abcdef");
    for (const byte of value) {
        if (byte === 0x22 || byte === 0x5c) {
            out[at++] = 0x5c;
            out[at++] = byte;
        }
        else if (byte < 0x20) {
            out.set([0x5c, 0x75, 0x30, 0x30, hex[byte >> 4], hex[byte & 15]], at);
            at += 6;
        }
        else {
            out[at++] = byte;
        }
    }
    out.set(tail, at);
    return out;
}
/** Read `stream` up to `cap` bytes; past that, zero what was read and call `onOverflow`. `cancel` ends the read early. */
function readCapped(stream, cap, onOverflow) {
    const reader = stream.getReader();
    let cancelled = false;
    const cancel = () => {
        cancelled = true;
        void reader.cancel().catch(() => undefined);
    };
    const done = (async () => {
        const chunks = [];
        let total = 0;
        let overflow = false;
        try {
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done)
                    break;
                total += chunk.value.length;
                if (total > cap) {
                    chunk.value.fill(0);
                    overflow = true;
                    onOverflow();
                    void reader.cancel().catch(() => undefined);
                    break;
                }
                chunks.push(chunk.value);
            }
        }
        catch {
            // A cancelled read ends the capture.
        }
        const keep = !overflow && !cancelled;
        const bytes = new Uint8Array(keep ? total : 0);
        let at = 0;
        for (const chunk of chunks) {
            if (keep)
                bytes.set(chunk, at);
            at += chunk.length;
            chunk.fill(0);
        }
        return { bytes, overflow, cancelled };
    })();
    return { done, cancel };
}
/** Resolves `"late"` once `ms` pass, unless `promise` settles first. */
function within(promise, ms) {
    let timer;
    const late = new Promise((resolve) => {
        timer = setTimeout(() => resolve("late"), ms);
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
/**
 * The child leads its own process group, so a timeout or an overflow ends its descendants too. Its
 * stdout must close within a grace period after it exits: a descendant that keeps the pipe open ends
 * the run as `lost`, its group is killed and nothing it printed is kept.
 */
export const runChild = async (argv, options) => {
    let child;
    try {
        child = Bun.spawn(argv, {
            cwd: options.cwd,
            env: options.env,
            stdin: options.stdin ? "pipe" : "ignore",
            stdout: options.capture !== undefined ? "pipe" : "ignore",
            stderr: "ignore",
            detached: true,
        });
    }
    catch {
        return { kind: "unstarted" };
    }
    const capture = options.capture !== undefined && child.stdout instanceof ReadableStream
        ? readCapped(child.stdout, options.capture, () => killChild(child, true))
        : undefined;
    // supervise reads no pipe here: stdout goes through the capped reader alone.
    const run = supervise({ pid: child.pid, exited: child.exited, kill: (signal) => child.kill(signal) }, { timeoutMs: options.timeoutMs, group: true, ...(options.signal ? { signal: options.signal } : {}) });
    if (options.stdin) {
        const sink = child.stdin;
        try {
            sink.write(options.stdin);
            await sink.flush();
            await sink.end();
        }
        catch {
            // A child that exits without reading its stdin fails on its own exit code.
        }
    }
    const outcome = await run;
    let captured = capture === undefined ? undefined : await within(capture.done, EXIT_GRACE_MS);
    if (options.reap)
        killChild(child, true);
    if (captured === "late") {
        killChild(child, true);
        capture?.cancel();
        (await capture?.done)?.bytes.fill(0);
        return { kind: "lost" };
    }
    if (captured?.overflow)
        return { kind: "overflow" };
    if (outcome.kind !== "exited") {
        captured?.bytes.fill(0);
        captured = undefined;
        return { kind: outcome.kind };
    }
    return { kind: "exited", exitCode: outcome.exitCode, ...(captured ? { stdout: captured.bytes } : {}) };
};
function onPath(deps, bin, cwd) {
    return deps.which(bin, cwd) ?? fail(`${bin} is not on PATH`);
}
/** Why a run failed, with the stage and exit code only. */
function outcome(result, stage) {
    if (result.kind === "exited")
        return result.exitCode === 0 ? undefined : `${stage} failed (exit ${result.exitCode})`;
    if (result.kind === "overflow")
        return `${stage} printed more than ${STDOUT_CAP / 1024} KiB`;
    if (result.kind === "timeout")
        return `${stage} timed out`;
    if (result.kind === "aborted")
        return `${stage} was cancelled`;
    if (result.kind === "unstarted")
        return `${stage} could not start`;
    return `${stage} ended without an exit status`;
}
/** A stop can land mid-write, so a cancelled write may or may not have stored the value. */
function unsure(failure) {
    return failure.endsWith("was cancelled") ? "; the write may have completed, so check the store before retrying" : "";
}
function quoted(word) {
    return `'${word.replaceAll("'", "'\\''")}'`;
}
/** The provider to record the reference with: the named one, or the only 1Password provider; fails closed otherwise. */
function onePasswordProvider(target, snapshot) {
    const providers = snapshot.ofType("1password");
    if (target.provider !== undefined) {
        if (!providers.includes(target.provider))
            fail(`provider ${target.provider} is not a 1Password provider in every fnox config`);
        return target.provider;
    }
    if (providers.length !== 1) {
        fail(`found ${providers.length} 1Password providers in the fnox config; name one with target.provider`);
    }
    return providers[0];
}
/** The provider the target writes with, checked against one config snapshot; fails closed when uncertain. */
function validProvider(target, snapshot) {
    if (target.kind === "1password")
        return onePasswordProvider(target, snapshot);
    const type = snapshot.typeOf(target.provider);
    if (type === undefined || !VALUE_STORE_TYPES.has(type)) {
        fail(`provider ${target.provider} is not a value store in every fnox config (type ${type ?? "unknown"}); use a 1Password target`);
    }
    return target.provider;
}
/** The value: generated here, or the stdout of the command after the user allows it. */
async function obtain(request, deps) {
    const source = request.source;
    if (source.kind === "generate")
        return generateSecret(source.charset, source.length, deps.random);
    const cwd = source.cwd === undefined ? deps.directory : isAbsolute(source.cwd) ? source.cwd : resolve(deps.directory, source.cwd);
    const program = source.argv[0];
    const resolved = program.includes("/") ? program : onPath(deps, program, cwd);
    await deps.askCommand(source.argv, cwd);
    const result = await deps.run([resolved, ...source.argv.slice(1)], {
        cwd,
        env: deps.env,
        capture: STDOUT_CAP,
        // Nothing the command started may outlive it and edit the config after the recheck.
        reap: true,
        timeoutMs: COMMAND_TIMEOUT_MS,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    const stdout = result.kind === "exited" ? result.stdout : undefined;
    try {
        const failure = outcome(result, "the command");
        if (failure !== undefined)
            return fail(`${failure} for ${request.name}; nothing was stored`);
        return commandSecret(stdout ?? new Uint8Array());
    }
    finally {
        stdout?.fill(0);
    }
}
/**
 * Why the child environment could point fnox at a config the provider checks did not read: they read
 * `~/.config/fnox`, so a fnox config override or another XDG config home fails closed.
 */
export function configEnvironmentRefusal(env, home) {
    for (const name of ["FNOX_CONFIG_DIR", "FNOX_CONFIG"])
        if (env[name] !== undefined)
            return `${name} is set`;
    const xdg = env.XDG_CONFIG_HOME;
    if (xdg !== undefined && xdg !== "" && resolve(xdg) !== resolve(home, ".config"))
        return "XDG_CONFIG_HOME is not ~/.config";
    return undefined;
}
/**
 * Store a secret. The config is pinned: fnox gets `--config=<canonical path>`, a path outside the session
 * asks `external_directory`, and the provider is checked against one snapshot of the files fnox loads.
 * After the value is obtained (a command may have run), a fresh snapshot must have the same digest and
 * pass the same check before anything is written. Throws a SecretStoreError naming the stage, never the value.
 */
export async function storeSecret(input, deps) {
    const request = parseRequest(input);
    const { name, target } = request;
    const fnox = onPath(deps, "fnox", deps.directory);
    const op = target.kind === "1password" ? onPath(deps, "op", deps.directory) : undefined;
    const overridden = configEnvironmentRefusal(deps.env, deps.home ?? homedir());
    if (overridden !== undefined)
        fail(`${overridden}, so fnox may read a config this check did not; unset it and retry`);
    const requested = resolve(deps.directory, request.config ?? "fnox.toml");
    const file = deps.realpath(requested) ?? fail(`fnox config ${requested} does not exist; create it first`);
    const external = externalDirectories([dirname(file)], deps.roots);
    if (external.length > 0)
        await deps.askExternal(external);
    const before = deps.snapshot(file) ?? fail(`could not read the fnox config ${file}, so the provider is uncertain`);
    const provider = validProvider(target, before);
    const fnoxSet = (positionals) => [
        fnox,
        `--config=${file}`,
        "set",
        `--provider=${provider}`,
        ...(request.description === undefined ? [] : [`--description=${request.description}`]),
        "--",
        ...positionals,
    ];
    const common = { cwd: deps.directory, env: deps.env, ...(deps.signal ? { signal: deps.signal } : {}) };
    await deps.askStore(request, { file, provider });
    const value = await obtain(request, deps);
    let stdin;
    try {
        // A command may have rewritten the config: re-read it, with no cached data, before any write.
        const changed = `the fnox config changed while the value for ${name} was obtained; nothing was stored`;
        const after = deps.snapshot(file);
        if (after === undefined)
            return fail(changed);
        if (after.digest !== before.digest || deps.realpath(requested) !== file || validProvider(target, after) !== provider)
            fail(changed);
        // Last point where a stop writes nothing: past it the write below runs to its end.
        if (deps.signal?.aborted === true)
            fail(`stopped before writing ${name}; nothing was stored`);
        if (target.kind === "fnox-store") {
            if (edgeWhitespace(value)) {
                fail(`the value for ${name} starts or ends with whitespace, which fnox would trim; nothing was stored`);
            }
            stdin = value;
            const failure = outcome(await deps.run(fnoxSet([name]), { ...common, stdin, timeoutMs: FNOX_TIMEOUT_MS }), "fnox set");
            if (failure !== undefined)
                fail(`${failure} storing ${name}; not retried${unsure(failure)}`);
            return { name, provider, stored: true };
        }
        stdin = itemTemplate(target, value);
        const created = outcome(await deps.run([op, "item", "create", `--vault=${target.vault}`, "-"], { ...common, stdin, timeoutMs: OP_TIMEOUT_MS }), "op item create");
        if (created !== undefined)
            fail(`${created} storing ${name} (a 1Password approval may have been refused or timed out); not retried${unsure(created)}`);
        // `item/field` resolves in the provider's vault; a full op:// reference names the vault the item went to.
        const short = `${target.item}/${target.field}`;
        const reference = after.setting(provider, "vault") === target.vault ? short : `op://${target.vault}/${short}`;
        // Critical section: the item exists, so recording its reference ignores the signal; a stop
        // here would leave an item nothing points to. The stop is honored once this returns.
        const recorded = outcome(await deps.run(fnoxSet([name, reference]), { cwd: common.cwd, env: common.env, timeoutMs: FNOX_TIMEOUT_MS }), "fnox set");
        if (recorded !== undefined) {
            fail(`${recorded} after the 1Password item was created; record it with \`fnox set ${name} ${quoted(reference)} --provider ${provider}\``);
        }
        return { name, reference, stored: true };
    }
    finally {
        stdin?.fill(0);
        value.fill(0);
    }
}
