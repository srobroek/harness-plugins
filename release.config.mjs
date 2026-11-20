// Shared preset from @srobroek/harness-kit; only the forge plugin and the release rules are specific to this repository.
import { releaseConfig } from "@srobroek/harness-kit/release.config.js"

// refactor: and docs: cut a patch, as release-please did. A commit that matches a rule skips the preset's defaults,
// so the breaking rule must stay: without it "refactor!:" would cut only a patch.
const releaseRules = [
  { breaking: true, release: "major" },
  { type: "refactor", release: "patch" },
  { type: "docs", release: "patch" },
]

export default releaseConfig({
  forge: "@semantic-release/github",
  releaseRules,
})
