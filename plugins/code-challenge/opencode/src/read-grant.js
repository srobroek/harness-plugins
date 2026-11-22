import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { directoryReadRulesFor } from "@srobroek/opencode-lib/agent-files";
// The skill's references/ in the installed plugin sits outside the project, so a subagent cannot read it
// without a grant. `directoryReadRules` grants the canonical target of the path it is given, so a
// `references` that is a symlink (to its parent, or outside the plugin) would widen the grant to
// `<skill>/*` or beyond. The grant is made only when the real path is exactly `<skills root>/code-challenge/references`.
//
// The rules are built from the two paths validated here and never from a second resolution, so a swap after the
// check cannot add a pattern. `resolve` is a test seam.
export function referenceReadRules(moduleUrl, warn = console.warn, resolve = realpathSync) {
    const skills = fileURLToPath(new URL("../skills", moduleUrl));
    const references = join(skills, "code-challenge", "references");
    try {
        const expected = join(resolve(skills), "code-challenge", "references");
        const actual = resolve(references);
        if (actual === expected)
            return directoryReadRulesFor([references, expected]);
        warn(`srobroek.code-challenge: ${references} resolves to ${actual}, not ${expected}; no read grant for the references`);
    }
    catch (error) {
        warn(`srobroek.code-challenge: cannot resolve ${references} (${error.code ?? "error"}); no read grant for the references`);
    }
    return [];
}
