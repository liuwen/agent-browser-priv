# agent-browser-priv Fork Plan

## Decisions

- Primary distribution starts with Homebrew, not npm.
- GitHub Releases publish prebuilt binaries for every upstream target, including Linux AMD64 and Linux ARM64.
- Patchright is a required backend for ephemeral sandboxes, CI, and remote environments where a compatible browser may need to be downloaded on demand.
- npm remains optional. It is useful for `npx`, but it is not the source of truth for the fork.

## Distribution Plan

### GitHub Releases

Release assets use the fork binary name:

- `agent-browser-priv-darwin-arm64`
- `agent-browser-priv-darwin-x64`
- `agent-browser-priv-linux-arm64`
- `agent-browser-priv-linux-x64`
- `agent-browser-priv-linux-musl-arm64`
- `agent-browser-priv-linux-musl-x64`
- `agent-browser-priv-win32-x64.exe`

The release workflow should keep upstream's cross-build matrix and glibc 2.28
floor check, but rename artifacts from `agent-browser-*` to
`agent-browser-priv-*`.

### Homebrew

Create a public tap, preferably `liuwen/homebrew-agent-browser-priv`, so users
install with:

```bash
brew tap liuwen/agent-browser-priv
brew install agent-browser-priv
```

The formula should download the GitHub Release binary for the host platform and
install it as `agent-browser-priv`. The formula should depend on `node` because
the Patchright backend needs a Node runtime for its launcher and installer.

Homebrew should not download Patchright browser caches into a user profile at
install time. Instead, the binary exposes an explicit bootstrap command:

```bash
agent-browser-priv install patchright
agent-browser-priv install patchright --with-deps
```

That keeps Homebrew installs deterministic while giving CI and remote machines a
single command to fetch Patchright and browser artifacts.

### npm

Publishing `agent-browser-priv` to npm is optional. It would only provide:

- `npx agent-browser-priv ...`
- `npm install -g agent-browser-priv`
- Node ecosystem convenience for agents and ephemeral machines

The CLI itself is a Rust binary. npm is not required for runtime behavior except
when we choose to use npm as the Patchright package fetcher.

## Patchright Backend

Patchright is not a Rust library and is not a drop-in replacement for the
native Chrome launcher. The minimal maintainable backend is:

1. Add `--backend patchright` and `AGENT_BROWSER_BACKEND=patchright`.
2. Keep the default backend as native Chrome unless invoked through
   `agent-browser-priv`, where Patchright can be the default after bootstrap.
3. Add a Rust-managed Patchright host process:
   - The Rust daemon allocates a localhost CDP port.
   - It spawns a small Node host script shipped with the fork.
   - The host imports pinned `patchright`, launches a persistent Chromium or
     Chrome context, enables localhost CDP, and stays alive until the daemon
     closes it.
   - The existing Rust CDP client attaches to that port, so normal
     `agent-browser` commands keep working.
4. Add `agent-browser-priv install patchright`:
   - Installs pinned `patchright` into
     `~/.agent-browser-priv/backends/patchright`.
   - Runs Patchright's own browser installer for Chromium unless a system Chrome
     channel is requested.
   - Supports `--with-deps` for Linux dependency installation where Patchright
     supports it.
5. Add backend status output:
   - Patchright package version.
   - Browser registry revision and browser version.
   - Cache path.
   - Whether the host can launch and expose CDP.

Do not hardcode CDN or GitHub browser download URLs. Patchright owns that
registry. Pin the Patchright package version and use its `browsers.json` and
installer to resolve platform URLs.

## Local Defaults

When invoked as `agent-browser-priv`:

- Use an isolated default session namespace.
- Use an isolated profile root under `~/.agent-browser-priv/profiles`.
- Prefer headed mode for local interactive use unless explicitly headless.
- Add `--disable-blink-features=AutomationControlled` on native Chrome launches.
- Use Patchright backend when `--backend patchright` is set or when the
  `agent-browser-priv` default has been configured to Patchright.

## Update Path

Keep upstream rebases cheap:

```bash
git fetch upstream
git checkout main
git rebase upstream/main
git checkout codex/agent-browser-priv-minimal
git rebase main
```

Avoid broad rewrites. The initial patch should touch only:

- binary naming and package metadata;
- release artifact naming;
- Homebrew tap automation;
- backend option parsing;
- Patchright install and launch backend;
- docs and skill data required by upstream repo rules.

## Verification

Minimum local gates:

```bash
cd cli
cargo fmt -- --check
cargo test
```

Build and smoke:

```bash
pnpm run build:native
./bin/agent-browser-priv-darwin-arm64 --version
./bin/agent-browser-priv-darwin-arm64 install patchright
./bin/agent-browser-priv-darwin-arm64 --backend patchright open https://example.com
./bin/agent-browser-priv-darwin-arm64 --backend patchright snapshot -i
```

Release gates:

- GitHub Actions builds all seven release assets.
- Homebrew formula installs the right asset on macOS ARM64, macOS x64, Linux
  AMD64, and Linux ARM64.
- Patchright backend bootstraps from a clean CI cache.
- Challenge pages are classified and preserved for human handoff. No CAPTCHA
  solving, decaptcha services, proxy rotation, or production stealth defaults.
