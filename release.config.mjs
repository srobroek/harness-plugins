// Shared preset from @srobroek/harness-kit; only the forge plugin is specific to this repository.
import { releaseConfig } from "@srobroek/harness-kit/release.config.js"

export default releaseConfig({
  forge: "@semantic-release/github",
})
