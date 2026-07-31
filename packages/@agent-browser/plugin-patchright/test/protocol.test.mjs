import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const executable = fileURLToPath(new URL("../dist/index.js", import.meta.url));
async function invoke(payload) {
  const child = spawn(process.execPath, [executable], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  let stdout = "";
  for await (const chunk of child.stdout) stdout += chunk;
  const code = await new Promise((resolve) => child.once("exit", resolve));
  return { code, stdout, value: JSON.parse(stdout) };
}

test("manifest is advertised as one exact JSON response", async () => {
  const result = await invoke({ protocol: "agent-browser.plugin.v1", type: "plugin.manifest", request: {} });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.deepEqual(result.value.manifest.capabilities, ["browser.provider"]);
});

test("invalid JSON, protocol, type, and engine fail", async () => {
  for (const payload of ["not-json", null, [], { protocol: "v0", type: "plugin.manifest" }, { protocol: "agent-browser.plugin.v1", capability: "browser.provider", type: "unknown" }, { protocol: "agent-browser.plugin.v1", capability: "browser.provider", type: "browser.launch", request: { launchOptions: { engine: "lightpanda" } } }]) {
    const result = await invoke(payload);
    assert.equal(result.code, 0);
    assert.equal(result.value.success, false);
    assert.equal(typeof result.value.error, "string");
  }
});
