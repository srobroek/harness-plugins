// Shared preset from @srobroek/harness-kit; only the forge plugin and the release rules are specific to this repository.
import { releaseConfig } from "@srobroek/harness-kit/release.config.js"

// refactor: and docs: cut a patch, as release-please did. A commit that matches a rule skips the preset's defaults,
// so the breaking rule must stay: without it "refactor!:" would cut only a patch.
const releaseRules = [
  { breaking: true, release: "major" },
  { type: "refactor", release: "patch" },
  { type: "docs", release: "patch" },
]

const preset = releaseConfig({
  forge: "@semantic-release/github",
  releaseRules,
})

// A bundle embeds its plugin's package.json (delivery stamps its version into receipts), so a release that bumps the
// version must rebuild the bundle in the same commit. prepareCmd runs in the plugin directory after `harness-kit stamp`;
// the preset's @semantic-release/git assets already include opencode/** and claude/**.
const buildAfterStamp = (prepareCmd) =>
  `${prepareCmd} && bun "$(git rev-parse --show-toplevel)/scripts/build.ts" "$(basename "$PWD")"`

export default {
  ...preset,
  plugins: preset.plugins.map((plugin) =>
    Array.isArray(plugin) && plugin[0] === "@semantic-release/exec"
      ? [plugin[0], { ...plugin[1], prepareCmd: buildAfterStamp(plugin[1].prepareCmd) }]
      : plugin,
  ),
}
