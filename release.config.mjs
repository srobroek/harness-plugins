// Shared preset from @srobroek/harness-kit via scripts/release-preset.mjs; only the forge plugin and the release rules are specific to this repository.
import { repoRelease } from "./scripts/release-preset.mjs"

// refactor: and docs: cut a patch, as release-please did. A commit that matches a rule skips the preset's defaults,
// so the breaking rule must stay: without it "refactor!:" would cut only a patch.
const releaseRules = [
  { breaking: true, release: "major" },
  { type: "refactor", release: "patch" },
  { type: "docs", release: "patch" },
]

export default repoRelease({
  // No "released in" comments: the success step looks up every released commit's pull request, and GitHub refuses
  // that lookup for a pull request that regenerates every bundle ("too many files changed"), failing the whole run.
  forge: ["@semantic-release/github", { successCommentCondition: false }],
  releaseRules,
  assets: ["CHANGELOG.md", "package.json", "INVENTORY.md", "opencode/**", "claude/**", "omp/**", "pi/**"],
})
