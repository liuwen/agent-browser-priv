# Private Fork Maintenance

This directory tracks fork-local release inputs that should be easy to audit
and easy to sync.

## Runtime Version Tracking

`priv/version-tracking.json` records:

- `agent_browser_upstream_tag`: the upstream `vercel-labs/agent-browser` tag
  this fork was last replayed onto.
- `patchright_pin`: the Patchright npm version embedded into
  `agent-browser install`.
- `policy.patchright_updates`: Patchright-only bumps are mechanical PRs.
- `policy.agent_browser_updates`: upstream `agent-browser` updates need a
  manual sync branch because conflicts can land in core Rust command plumbing.

Check current state:

```bash
pnpm run runtime:update-check
```

Prepare a Patchright bump:

```bash
pnpm run runtime:update-patchright -- latest
```

That command updates the release pin in `cli/src/install.rs`, regenerates the
embedded npm lockfile, and updates `priv/version-tracking.json`.

## Release Rule

Patchright can usually be bumped mechanically, but it still needs a normal
`agent-browser-priv` release before users pick it up. After the bump PR passes
CI, add the normal version and changelog changes, merge to `main`, and let the
release workflow publish the binaries, npm package, and Homebrew formula.

Upstream `agent-browser` updates are not mechanical. Start from the upstream
tag, replay this fork's small patch stack, update
`agent_browser_upstream_tag`, and release only if the conflicts stay localized.
