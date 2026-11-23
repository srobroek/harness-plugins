// The release preset of this repository: the harness-kit preset, plus a bundle rebuild after the version stamp.
// A bundle can embed its plugin's package.json (delivery's receipts carry the version), so the release commit must
// carry the rebuilt opencode/dist. prepareCmd runs in the plugin directory; @semantic-release/git commits opencode/**,
// claude/** and omp/**. multi-semantic-release replaces the root config with a package's own release.config.mjs
// wholesale, so each of those files calls repoRelease too.
import { releaseConfig } from "@srobroek/harness-kit/release.config.js"

export function repoRelease(options) {
  const preset = releaseConfig({ ...options, assets: options.assets ?? ["CHANGELOG.md", "package.json", "INVENTORY.md", "opencode/**", "claude/**", "omp/**"] })
  return {
    ...preset,
    plugins: preset.plugins.map((plugin) =>
      Array.isArray(plugin) && plugin[0] === "@semantic-release/exec"
        ? [plugin[0], { ...plugin[1], prepareCmd: `${plugin[1].prepareCmd} && bun "$(git rev-parse --show-toplevel)/scripts/build.ts" "$(basename "$PWD")"` }]
        : plugin,
    ),
  }
}
