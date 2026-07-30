import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { statePath } from "../dist/runtime.js";

const executable = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function invoke(payload) {
  const child = spawn(process.execPath, [executable], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdin.end(JSON.stringify(payload));
  let output = "";
  for await (const chunk of child.stdout) output += chunk;
  const code = await new Promise((resolve) => child.once("exit", resolve));
  const response = JSON.parse(output);
  if (code !== 0 || !response.success) {
    throw new Error(response.error || `Plugin exited ${code}`);
  }
  return response;
}

async function endpointAlive(cdpUrl) {
  try {
    const url = new URL(cdpUrl);
    const response = await fetch(`http://127.0.0.1:${url.port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const launched = await invoke({
  protocol: "agent-browser.plugin.v1",
  capability: "browser.provider",
  type: "browser.launch",
  request: {
    provider: "patchright",
    session: "smoke",
    launchOptions: { engine: "chrome", headed: false },
  },
});

try {
  assert.equal(launched.browser.directPage, false);
  assert.match(launched.browser.cdpUrl, /^ws:\/\/127\.0\.0\.1:/);
  assert.equal(await endpointAlive(launched.browser.cdpUrl), true);
  assert.equal(JSON.stringify(launched.browser.metadata).includes("nonce"), false);
} finally {
  await invoke({
    protocol: "agent-browser.plugin.v1",
    capability: "browser.provider",
    type: "browser.close",
    request: launched.browser.cleanup,
  });
}

for (let attempt = 0; attempt < 50; attempt++) {
  if (!(await endpointAlive(launched.browser.cdpUrl))) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(await endpointAlive(launched.browser.cdpUrl), false);
await assert.rejects(access(statePath(launched.browser.cleanup.instanceId)));
console.log("Patchright provider smoke test passed");
