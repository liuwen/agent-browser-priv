# agent-browser-plugin-patchright

An independently versioned local [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) browser provider for agent-browser. It launches a fresh persistent Chromium context in a detached supervisor and returns a browser-level CDP endpoint.

## Requirements

- Node.js 24 or newer
- Google Chrome by default, or a Patchright-managed Chromium installation

## Usage

From the repository root, build and register the private provider from the local workspace:

```sh
pnpm --filter agent-browser-plugin-patchright build
agent-browser plugin add "file:$PWD/packages/@agent-browser/plugin-patchright" --global
```

The provider uses an existing Google Chrome installation by default. To install its default channel explicitly, run `node packages/@agent-browser/plugin-patchright/dist/index.js install chrome`.

Select Patchright for a session without changing agent-browser's normal Chrome default or its other providers:

```sh
agent-browser --provider patchright open https://example.com
agent-browser snapshot -i
agent-browser close
```

Patchright-managed Chromium is available as an explicit alternative:

```sh
node packages/@agent-browser/plugin-patchright/dist/index.js install chromium
AGENT_BROWSER_PATCHRIGHT_CHANNEL=chromium agent-browser --provider patchright open https://example.com
```

The executable accepts one `agent-browser.plugin.v1` request on stdin, writes exactly one JSON response to stdout, and exits. A detached supervisor owns the browser between the separate launch and close invocations.

Request shutdown for all reachable provider-owned instances:

```sh
node packages/@agent-browser/plugin-patchright/dist/index.js cleanup
```

The cleanup command retains ownership records when a supervisor cannot be authenticated or reached. This avoids deleting a profile while its browser may still be active.

## Configuration

- `AGENT_BROWSER_PATCHRIGHT_CHANNEL` selects the Patchright channel. It defaults to `chrome`.
- `AGENT_BROWSER_PATCHRIGHT_RUNTIME_DIR` overrides the private runtime state directory. It defaults to `~/.agent-browser/providers/patchright`.
- `AGENT_BROWSER_PATCHRIGHT_MAX_LIFETIME_MS` sets forced instance expiry. Values are bounded from one minute through seven days and default to one day.

Each launch uses a fresh temporary profile, a managed loopback CDP port, and an authenticated loopback control server. The cleanup nonce is returned only in the opaque cleanup token and is not included in browser metadata. The current provider contract does not supply extensions or existing profiles.

Patchright recommends headed Google Chrome with its native driver and no custom user agent for detection-sensitive work. This provider uses Patchright to launch the browser, then agent-browser drives it through a separate raw CDP connection. Patchright's launch argument changes remain useful, but its driver-level avoidance of `Runtime.enable` does not apply to agent-browser's CDP client. Use native Patchright directly when that distinction matters.

## Development

```sh
pnpm build
pnpm test
pnpm smoke
```

The smoke test launches a real browser and is intentionally excluded from the default test suite.
