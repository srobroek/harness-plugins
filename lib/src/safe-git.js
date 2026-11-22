import { devNull } from "node:os";
/**
 * Git's global options for every command that runs inside a checkout this tool does
 * not control (a landed worktree, or another repository's checkout).
 *
 * `core.fsmonitor` is a program `git status` executes and `core.hooksPath` selects
 * hooks, so a hostile checkout's own config could run code; command-line `-c`
 * outranks repository config. `--no-optional-locks` keeps a read from writing the index.
 */
export const SAFE_GIT_ARGS = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${devNull}`,
    "--no-optional-locks",
];
/**
 * {@link SAFE_GIT_ARGS} plus the overrides for a command that only reads or updates local
 * state in a checkout whose config may be hostile, and so must never reach a remote.
 *
 * - `core.attributesFile` drops the global attributes file.
 * - `diff.external` is blanked, so a patch diff fails instead of running it.
 * - `core.sshCommand`, `credential.helper` and `core.askPass` are blanked. With every transport
 *   refused ({@link untrustedLocalGitEnv}) none of them should start; this is a second layer.
 * - `log.showSignature` is off, so a log-style read (`stash list`) verifies no signature, and
 *   the signature programs are blanked as a second layer.
 *
 * Filter drivers are named per repository, so a command that hashes work-tree files also needs
 * {@link filterDriverOverrides}.
 */
export function untrustedLocalGitArgs() {
    // A function, not a constant, so bundles that only use SAFE_GIT_ARGS can drop it.
    return [
        ...SAFE_GIT_ARGS,
        "-c",
        `core.attributesFile=${devNull}`,
        "-c",
        "diff.external=",
        "-c",
        "core.sshCommand=",
        "-c",
        "credential.helper=",
        "-c",
        "core.askPass=",
        "-c",
        "log.showSignature=false",
        "-c",
        "gpg.program=",
        "-c",
        "gpg.ssh.program=",
        "-c",
        "gpg.x509.program=",
    ];
}
/**
 * Variables git reads to choose a program to run that do not start with `GIT_`. Every inherited
 * `GIT_*` variable is dropped too; see {@link untrustedLocalGitEnv}.
 */
const PROGRAM_VARIABLES = ["PAGER", "EDITOR", "VISUAL", "SSH_ASKPASS"];
/** The one inherited `GIT_*` variable kept: the user's global config file. */
const KEPT_GIT_VARIABLE = "GIT_CONFIG_GLOBAL";
/**
 * The environment for the commands {@link untrustedLocalGitArgs} covers, from the host's.
 *
 * Every inherited `GIT_*` variable except `GIT_CONFIG_GLOBAL` is dropped, and so are
 * {@link PROGRAM_VARIABLES}. Among the dropped ones:
 *
 * - Config that the filter-driver preflight and the command would read differently: `GIT_CONFIG`
 *   (only `git config` reads it), `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`,
 *   `GIT_CONFIG_VALUE_<n>` and `GIT_CONFIG_SYSTEM`. This plugin's own overrides are `-c` options,
 *   so nothing of its own needs to be appended to them.
 * - A repository, work tree or index other than the one `-C` names: `GIT_DIR`, `GIT_WORK_TREE`,
 *   `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY` and
 *   `GIT_ALTERNATE_OBJECT_DIRECTORIES`.
 * - Programs git runs: `GIT_EXEC_PATH`, `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `GIT_EDITOR`, `GIT_SSH`,
 *   `GIT_SSH_COMMAND`, `GIT_ASKPASS` and `GIT_PROXY_COMMAND`.
 * - Files git writes: `GIT_TRACE` and every other `GIT_TRACE*`.
 * - Pathspec and lookup switches that change what a read sees: `GIT_LITERAL_PATHSPECS` and the
 *   other `GIT_*_PATHSPECS`, `GIT_NAMESPACE` and `GIT_REPLACE_REF_BASE`.
 *
 * `GIT_CONFIG_GLOBAL` is kept because the preflight and the command both read it, and its filter
 * drivers are disabled like any other. `HOME` and `XDG_CONFIG_HOME`, which locate the global config
 * when it is unset, are kept: they only locate that file.
 *
 * Then these are set:
 *
 * - An empty `GIT_ALLOW_PROTOCOL` refuses every transport, built-in or remote helper, whatever
 *   the repository's `protocol.*.allow` says. A lazy fetch in a partial clone would otherwise run
 *   the repository's `remote.<name>.uploadpack`, SSH command or credential helper.
 * - `GIT_NO_LAZY_FETCH` stops that fetch before it starts.
 * - No system config and no terminal prompt.
 *
 * Residual risk (no minimum-version bump): `GIT_NO_LAZY_FETCH` needs git 2.45. Older git still
 * starts a lazy fetch and relies on the transport refusal, which git checks before it connects.
 */
export function untrustedLocalGitEnv(host) {
    const dropped = new Set(PROGRAM_VARIABLES);
    const kept = {};
    for (const [name, value] of Object.entries(host)) {
        if (value === undefined || dropped.has(name))
            continue;
        if (name.startsWith("GIT_") && name !== KEPT_GIT_VARIABLE)
            continue;
        kept[name] = value;
    }
    return {
        ...kept,
        GIT_ALLOW_PROTOCOL: "",
        GIT_NO_LAZY_FETCH: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
    };
}
/**
 * The git arguments that list every configured key, NUL-terminated; {@link filterDriverOverrides}
 * picks the filter drivers out. A `--get-regexp` would skip a key that is not valid in the locale's
 * encoding, and with it the driver. Run them in the same directory, with the same options and
 * environment, as the command they protect: git then evaluates conditional includes (`includeIf`)
 * and per-worktree config the same way for both. An empty listing exits 1.
 */
export const FILTER_DRIVER_LISTING = ["config", "--name-only", "-z", "--list"];
/**
 * `-c` options that disable every filter driver a {@link FILTER_DRIVER_LISTING} output names, so
 * a command that hashes work-tree files runs no clean or process filter. That includes drivers
 * from the user's global config, git-lfs among them: the repository picks the driver through its
 * attributes and can supply the program a relative command runs. Undefined when the listing is
 * malformed or a driver name is not UTF-8 or contains `=`, since `-c` cannot name such a driver;
 * the caller must then not run the command.
 *
 * Not covered: a submodule's own drivers when `git status` recurses into it, and a config that
 * changes between the listing and the command.
 */
export function filterDriverOverrides(listing) {
    const keys = listing.split("\0");
    if (keys.pop() !== "")
        return undefined;
    const drivers = new Set();
    for (const key of keys) {
        const last = key.lastIndexOf(".");
        // A key is `filter.<driver>.<variable>`, and `<driver>` may be empty; a two-part `filter.<variable>` names no driver.
        if (!key.startsWith("filter.") || last < "filter.".length)
            continue;
        drivers.add(key.slice("filter.".length, last));
    }
    // Output is decoded as UTF-8 with replacement, so U+FFFD marks a name that was not UTF-8.
    if ([...drivers].some((driver) => driver.includes("=") || driver.includes("\uFFFD")))
        return undefined;
    return [...drivers].flatMap((driver) => ["clean=", "smudge=", "process=", "required=false"].flatMap((setting) => ["-c", `filter.${driver}.${setting}`]));
}
