import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  bootstrapPath,
  cleanupStale,
  createControlServer,
  mapLaunchOptions,
  profileDir,
  sendClose,
  statePath,
  takeBootstrap,
  writeState,
} from "../dist/runtime.js";

const INSTANCE_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_ID = "223e4567-e89b-42d3-a456-426614174000";
const NONCE = "a".repeat(64);

test("launch request maps to persistent context options", () => {
  const options = mapLaunchOptions({ headed: true, userAgent: "test-agent", colorScheme: "dark" });
  assert.equal(options.headless, false);
  assert.equal(options.viewport, null);
  assert.equal(options.userAgent, "test-agent");
  assert.equal(options.colorScheme, "dark");
  assert.ok(options.args.includes("--remote-debugging-port=0"));
});

test("control server authenticates close and close is idempotent", async () => {
  let closes = 0;
  const server = createControlServer("x", "secret", async () => { closes++; });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  assert.equal(
    await sendClose({ instanceId: "x", controlPort: port, nonce: "wrong" }),
    "rejected",
  );
  assert.equal(closes, 0);
  assert.equal(
    await sendClose({ instanceId: "x", controlPort: port, nonce: "secret" }),
    "closed",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closes, 1);
  server.close();
  assert.equal(
    await sendClose({ instanceId: "x", controlPort: port, nonce: "secret" }),
    "unreachable",
  );
});

test("failed and malformed state files cannot select recursive deletion targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchright-test-"));
  process.env.AGENT_BROWSER_PATCHRIGHT_RUNTIME_DIR = root;
  const profile = profileDir(INSTANCE_ID);
  const unrelated = join(root, "unrelated");
  await mkdir(profile, { recursive: true });
  await mkdir(unrelated);
  await writeState({
    instanceId: INSTANCE_ID,
    pid: 99999999,
    controlPort: 1,
    nonce: NONCE,
    createdAt: 0,
    status: "failed",
  });
  await writeFile(join(root, "broken.json"), "{");
  await writeFile(
    statePath(OTHER_ID),
    JSON.stringify({
      instanceId: INSTANCE_ID,
      pid: 1,
      controlPort: 1,
      nonce: NONCE,
      profileDir: unrelated,
      createdAt: 0,
      status: "failed",
    }),
  );
  assert.equal(await cleanupStale(), 3);
  await access(profile);
  await access(unrelated);
  await assert.rejects(access(statePath(INSTANCE_ID)));
  await assert.rejects(access(statePath(OTHER_ID)));
});

test("malformed bootstrap values are rejected and unlinked", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchright-bootstrap-test-"));
  process.env.AGENT_BROWSER_PATCHRIGHT_RUNTIME_DIR = root;
  await mkdir(root, { recursive: true });
  const path = bootstrapPath(INSTANCE_ID);
  await writeFile(
    path,
    JSON.stringify({
      state: {
        instanceId: INSTANCE_ID,
        pid: 0,
        controlPort: 0,
        nonce: [NONCE],
        createdAt: Date.now(),
        status: ["starting"],
      },
      request: {},
    }),
  );
  await assert.rejects(takeBootstrap(path), /Invalid Patchright state/);
  await assert.rejects(access(path));
});

test("state nonce is not part of public metadata shape", async () => {
  const metadata = { provider: "patchright", instanceId: "instance", channel: "chrome" };
  assert.equal(JSON.stringify(metadata).includes("nonce"), false);
  assert.equal(JSON.stringify(metadata).includes("secret"), false);
});
