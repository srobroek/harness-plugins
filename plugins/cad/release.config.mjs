// cad is below 1.0, so a breaking change cuts a minor release (release-please's bump-minor-pre-major).
// multi-semantic-release replaces the root config with this one wholesale, so the forge and the other rules repeat the root's.
import { releaseConfig } from "@srobroek/harness-kit/release.config.js"

export default releaseConfig({
  forge: "@semantic-release/github",
  releaseRules: [
    { breaking: true, release: "minor" },
    { type: "refactor", release: "patch" },
    { type: "docs", release: "patch" },
  ],
})
