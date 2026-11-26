/**
 * Advisory, never a gate: when a shell call adds or installs a named package, the
 * vetting instruction is appended to that call's result, once per package per session.
 * Ported from omp-plugins (`safety/extensions/package-investigate.ts`); package
 * managers are recognised in command position only, so a quoted mention stays data.
 */

import { base, walkShell } from "./shell.ts"

/** A package manager: the verbs that add or change a dependency, and the options that take a value. */
type Manager = { verbs: ReadonlySet<string>; valued: ReadonlySet<string> }

const words = (list: string): ReadonlySet<string> => new Set(list.split(" "))

/**
 * Option sources: `--help` of the installed CLI (bun 1.4.5, pnpm 12.23.0, yarn 1 via `npm exec yarn@1`, uv 0.13.9,
 * pip 26.3, cargo 1.99.1, go 1.27.4 `help build`, poetry 2.1.3); npm 11 `docs/output/using-npm/config.html`, every
 * option whose type takes a value, plus its `-C`/`-w`/`-c`/`-m`/`-L` aliases; composer `getcomposer.org/doc/03-cli.md`,
 * global options and the `require` section. pnpm's multi-value `--cpu`, `--os` and `--libc` are left out, so their
 * values count as operands. Yarn 2+ is unverified; `--cwd` is kept for it.
 */
const MANAGERS: ReadonlyMap<string, Manager> = new Map([
  ["pnpm", { verbs: words("add i install"), valued: words("--env-file -C --dir --store-dir --state-dir --npmrc-auth-file --workspace-packages --registry --https-proxy --http-proxy --no-proxy --reporter --loglevel -F --filter --filter-prod --test-pattern --changed-files-ignore-pattern --workspace-concurrency --lockfile-dir --network-concurrency --fetch-timeout --fetch-warn-timeout-ms --fetch-min-speed-ki-bps --user-agent --pnpr-server --node-linker --allow-build --merge-git-branch-lockfiles-branch-pattern --save-prefix --save-catalog-name") }],
  ["npm", { verbs: words("add i install"), valued: words("--access --allow-directory --allow-file --allow-git --allow-remote --allow-scripts --audit-level --auth-type --before --ca --cache --cafile --call --cidr --cpu --depth --diff --diff-dst-prefix --diff-src-prefix --diff-unified --editor --expect-result-count --expires --fetch-retries --fetch-retry-factor --fetch-retry-maxtimeout --fetch-retry-mintimeout --fetch-timeout --git --globalconfig --heading --https-proxy --include --init-author-email --init-author-name --init-author-url --init-license --init-module --init-type --init-version --install-strategy --libc --local-address --location --lockfile-version --loglevel --logs-dir --logs-max --maxsockets --message --min-release-age --min-release-age-exclude --name --node-gyp --node-options --noproxy --omit --orgs --orgs-permission --os --otp --pack-destination --package --packages --packages-and-scopes-permission --password --prefix --preid --provenance-file --proxy --registry --replace-registry-host --save-prefix --sbom-format --sbom-type --scope --scopes --script-shell --searchexclude --searchlimit --searchopts --searchstaleness --shell --tag --tag-version-prefix --token-description --umask --user-agent --userconfig --viewer --which --workspace --also --cache-max --cache-min --cert --key --only -C -w -c -m -L") }],
  ["bun", { verbs: words("add i install"), valued: words("-c --config --ca --cafile --cache-dir --cwd --env-file --backend --registry --concurrent-scripts --network-concurrency --omit --linker --minimum-release-age --minimum-release-age-excludes --cpu --os --libc -F --filter") }],
  ["yarn", { verbs: words("add i install"), valued: words("--use-yarnrc --link-folder --global-folder --modules-folder --preferred-cache-folder --cache-folder --mutex --proxy --https-proxy --registry --network-concurrency --network-timeout --otp --cwd") }],
  ["uv", { verbs: words("add"), valued: words("-r --requirements -c --constraints -m --marker --optional --group --bounds --rev --tag --branch --extra --package --script --no-install-package --index --default-index -i --index-url --extra-index-url -f --find-links --index-strategy --keyring-provider -P --upgrade-package --upgrade-group --resolution --prerelease --prerelease-package --fork-strategy --exclude-newer --exclude-newer-package --no-sources-package --reinstall-package --link-mode -C --config-setting --config-settings-package --no-build-isolation-package --no-build-package --no-binary-package --cache-dir --refresh-package -p --python --color --allow-insecure-host --directory --project --config-file") }],
  ["pip", { verbs: words("install"), valued: words("-r --requirement -c --constraint --build-constraint --requirements-from-script -e --editable -t --target --platform --python-version --implementation --abi --root --prefix --src --upgrade-strategy -C --config-settings --progress-bar --root-user-action --report --group --all-releases --only-final --no-binary --only-binary -i --index-url --extra-index-url --refresh-package -f --find-links --uploaded-prior-to --python --log --keyring-provider --proxy --retries --timeout --exists-action --trusted-host --cert --client-cert --cache-dir --use-feature --use-deprecated --resume-retries") }],
  ["cargo", { verbs: words("add"), valued: words("-C -F --features --rename --color --config -Z -m --manifest-path -p --package --path --base --git --branch --tag --rev --registry --target") }],
  ["go", { verbs: words("get"), valued: words("-C -p -asmflags -buildmode -compiler -covermode -coverpkg -gccgoflags -gcflags -installsuffix -ldflags -mod -modfile -overlay -pgo -pkgdir -tags -toolexec") }],
  ["poetry", { verbs: words("add"), valued: words("-C --directory -P --project -G --group -E --extras --optional --python --platform --markers --source") }],
  ["composer", { verbs: words("require"), valued: words("-d --working-dir --prefer-install --audit-format --ignore-platform-req --apcu-autoloader-prefix") }],
])

const PACKAGE = /^(?!-)[A-Za-z@./_~][^;|&<>()`$]*$/

export const INVESTIGATE_NOTICE =
  "Before adding or changing a dependency, investigate the package (registry, maintainer, release, and downloads) and confirm it is not a typo-squat or abandoned. Prefer the package-manager CLI over manifest edits, and pin per the repo convention. If it fails that check, revert the change."

/**
 * Indexes of the operands in `argv` from `start`: words that are not options. A valued option takes the next word,
 * and `--` ends the options.
 */
function operandIndexes(argv: readonly string[], start: number, valued: ReadonlySet<string>): number[] {
  const found: number[] = []
  let options = true
  for (let i = start; i < argv.length; i++) {
    const word = argv[i] as string
    if (options && word === "--") options = false
    else if (options && word.startsWith("-") && word !== "-") {
      if (valued.has(word)) i++
    } else found.push(i)
  }
  return found
}

/**
 * Literal package operands of add/install commands in real shell command positions. The verb is the first operand,
 * so options before it (`pnpm --dir infra add zod`) do not hide it.
 */
export function packagesToInvestigate(command: string): string[] {
  const packages: string[] = []
  for (const item of walkShell(command).commands) {
    const manager = MANAGERS.get(base(item.argv[0]))
    if (manager === undefined || item.argv[0]?.includes("/")) continue
    const [verb, ...operands] = operandIndexes(item.argv, 1, manager.valued)
    if (verb === undefined || !manager.verbs.has(item.argv[verb] ?? "")) continue
    for (const i of operands) {
      const value = item.argv[i] as string
      if (item.words?.[i]?.expands && /[$`]/.test(value)) continue
      if (PACKAGE.test(value)) packages.push(value)
    }
  }
  return packages
}

export function shouldInvestigate(command: string): boolean {
  return packagesToInvestigate(command).length > 0
}

export type PackageAdvisor = {
  /** The notice for packages `command` names that this session has not named yet, or undefined. */
  notice(sessionID: string, command: string): string | undefined
}

export function createPackageAdvisor(): PackageAdvisor {
  const noticed = new Map<string, Set<string>>()
  return {
    notice(sessionID, command) {
      const seen = noticed.get(sessionID) ?? new Set<string>()
      const fresh = [...new Set(packagesToInvestigate(command))].filter((name) => !seen.has(name))
      if (fresh.length === 0) return undefined
      for (const name of fresh) seen.add(name)
      noticed.set(sessionID, seen)
      return `${INVESTIGATE_NOTICE} Packages: ${fresh.join(", ")}.`
    },
  }
}
