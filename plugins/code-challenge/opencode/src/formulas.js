import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installFormulas as installShipped } from "@srobroek/opencode-lib/formulas";
export const SETUP_TOOL = "challenge_setup";
/** The full run, then one `mol-` formula per phase. */
export const FORMULAS = [
    "code-challenge",
    "mol-challenge-intake",
    "mol-challenge-scan",
    "mol-challenge-challenge",
    "mol-challenge-lens",
    "mol-challenge-research",
    "mol-challenge-refute",
    "mol-challenge-decide",
    "mol-challenge-deliver",
];
/** The shipped `formulas/` directory: `src/` and the bundled `dist/` both sit one level below it. */
export const FORMULAS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "formulas");
const USAGE = [
    "Pour a full run with: bd mol pour code-challenge --var target=<paths> --var run_id=<run-id>",
    "Bond one lens scout with: bd mol bond mol-challenge-lens <step-id> --var lens=<lens> --var target=<paths> --var run_id=<run-id>",
    "Pour one phase with: bd mol pour mol-challenge-<phase> --var target=<paths> --var run_id=<run-id> --var depth=<depth> --var mode=<mode>",
];
/** Copy the code-challenge formulas into `<workspace>/.beads/formulas/`; see the shared installer for the refusals. */
export function installFormulas(workspace, cwd, force = false) {
    const result = installShipped({ workspace, cwd, force, names: FORMULAS, sourceDir: FORMULAS_DIR });
    return result.ok ? { ...result, text: [result.text, ...USAGE].join("\n") } : result;
}
