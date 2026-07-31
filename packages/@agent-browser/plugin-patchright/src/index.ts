#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium } from "patchright";
import {
  cleanupAll,
  cleanupStale,
  createControlServer,
  mapLaunchOptions,
  maxLifetimeMs,
  profileDir,
  readState,
  removeState,
  sendClose,
  statePath,
  takeBootstrap,
  writeBootstrap,
  writeState,
  type Cleanup,
  type RequestedOptions,
  type State,
} from "./runtime.js";

const PROTOCOL = "agent-browser.plugin.v1";
const LAUNCHER_TIMEOUT_MS = 42_000;

type BrowserContext = Awaited<
  ReturnType<typeof chromium.launchPersistentContext>
>;

function respond(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message: string) {
  return { protocol: PROTOCOL, success: false, error: message };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDevToolsActivePort(profileDir: string): Promise<string> {
  const path = join(profileDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const [port, browserPath] = (await readFile(path, "utf8"))
        .trim()
        .split(/\r?\n/);
      const portNumber = Number(port);
      if (
        port &&
        /^\d+$/.test(port) &&
        Number.isInteger(portNumber) &&
        portNumber >= 1 &&
        portNumber <= 65_535 &&
        /^\/devtools\/browser\/[A-Za-z0-9._-]+$/.test(browserPath || "")
      ) {
        return `ws://127.0.0.1:${port}${browserPath}`;
      }
    } catch {
      // Chrome creates this file after its debugging endpoint is ready.
    }
    await delay(50);
  }
  throw new Error("Chrome did not publish its managed CDP endpoint");
}

async function supervise(bootstrapPath: string): Promise<void> {
  const { state, request } = await takeBootstrap(bootstrapPath);
  state.pid = process.pid;

  let context: BrowserContext | undefined;
  let launchPromise: Promise<BrowserContext> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let expiry: NodeJS.Timeout | undefined;
  let resolveControlClosed!: () => void;
  const controlClosed = new Promise<void>((resolve) => {
    resolveControlClosed = resolve;
  });
  let control: ReturnType<typeof createControlServer>;
  const isClosing = () => state.status === "closing";

  const shutdown = async (): Promise<void> => {
    state.status = "closing";
    await writeState(state);
    context ??= launchPromise ? await launchPromise.catch(() => undefined) : undefined;
    if (context) await context.close();
    if (expiry) clearTimeout(expiry);
    await removeState(state.instanceId);
    control.close();
  };

  const requestShutdown = async (): Promise<void> => {
    shutdownPromise ??= shutdown();
    try {
      await shutdownPromise;
    } catch (error) {
      shutdownPromise = undefined;
      throw error;
    }
  };

  control = createControlServer(
    state.instanceId,
    state.nonce,
    requestShutdown,
  );
  control.once("close", resolveControlClosed);

  try {
    await new Promise<void>((resolve, reject) => {
      control.once("error", reject);
      control.listen(0, "127.0.0.1", resolve);
    });
    const address = control.address();
    if (!address || typeof address === "string") {
      throw new Error("Patchright supervisor did not bind a control port");
    }
    state.controlPort = address.port;
    state.status = "starting";
    await writeState(state);

    expiry = setTimeout(() => {
      void sendClose({
        instanceId: state.instanceId,
        controlPort: state.controlPort,
        nonce: state.nonce,
      });
    }, maxLifetimeMs());
    process.once("SIGTERM", () => {
      void sendClose({
        instanceId: state.instanceId,
        controlPort: state.controlPort,
        nonce: state.nonce,
      });
    });
    process.once("SIGINT", () => {
      void sendClose({
        instanceId: state.instanceId,
        controlPort: state.controlPort,
        nonce: state.nonce,
      });
    });

    launchPromise = chromium.launchPersistentContext(
      profileDir(state.instanceId),
      mapLaunchOptions(request),
    );
    context = await launchPromise;
    if (isClosing()) {
      await requestShutdown();
      return;
    }
    state.cdpUrl = await waitForDevToolsActivePort(profileDir(state.instanceId));
    if (isClosing()) {
      await requestShutdown();
      return;
    }
    state.status = "ready";
    await writeState(state);
    void cleanupStale().catch(() => {});

    await controlClosed;
  } catch (error) {
    if (expiry) clearTimeout(expiry);
    if (context || isClosing()) {
      try {
        await requestShutdown();
      } catch (cleanupError) {
        state.status = "closing";
        const original = error instanceof Error ? error.message : String(error);
        const cleanup =
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
        state.error = `${original}; cleanup failed: ${cleanup}`;
        await writeState(state).catch(() => {});
        await controlClosed;
      }
      return;
    }
    await removeState(state.instanceId);
    state.status = "failed";
    state.error = error instanceof Error ? error.message : String(error);
    await writeState(state).catch(() => {});
    control.close();
    process.exitCode = 1;
  }
}

async function launch(request: RequestedOptions) {
  if (request.engine && request.engine !== "chrome") {
    return fail("Patchright provider supports only engine 'chrome'");
  }

  const instanceId = randomUUID();
  const state: State = {
    instanceId,
    pid: 0,
    controlPort: 0,
    nonce: randomBytes(32).toString("hex"),
    createdAt: Date.now(),
    status: "starting",
  };
  await mkdir(profileDir(instanceId), { recursive: true, mode: 0o700 });
  const path = await writeBootstrap({ state, request });
  const child = spawn(process.execPath, [process.argv[1]!, "__supervise", path], {
    detached: true,
    stdio: "ignore",
    env: process.env,
    windowsHide: true,
  });
  const childOutcome = new Promise<{ error?: Error; code?: number }>((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code) => resolve({ code: code ?? 1 }));
  });
  child.unref();

  const deadline = Date.now() + LAUNCHER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      childOutcome,
      delay(100).then(() => undefined),
    ]);
    if (outcome) {
      let ownershipPublished = true;
      try {
        await access(statePath(state.instanceId));
      } catch {
        ownershipPublished = false;
      }
      if (ownershipPublished) {
        await rm(path, { force: true });
      } else {
        await removeState(state.instanceId);
      }
      const detail = outcome.error?.message || `exit code ${outcome.code}`;
      return fail(`Patchright supervisor stopped before readiness: ${detail}`);
    }
    const current = await readState(state.instanceId);
    if (current?.status === "ready" && current.cdpUrl) {
      return {
        protocol: PROTOCOL,
        success: true,
        browser: {
          cdpUrl: current.cdpUrl,
          directPage: false,
          cleanup: {
            instanceId: current.instanceId,
            controlPort: current.controlPort,
            nonce: current.nonce,
          },
          metadata: {
            provider: "patchright",
            instanceId: current.instanceId,
            channel:
              process.env.AGENT_BROWSER_PATCHRIGHT_CHANNEL || "chrome",
          },
        },
      };
    }
    if (current?.status === "failed") {
      await removeState(current.instanceId);
      return fail(current.error || "Patchright supervisor failed to start");
    }
  }

  const current = await readState(state.instanceId);
  if (current?.controlPort) {
    await sendClose({
      instanceId: current.instanceId,
      controlPort: current.controlPort,
      nonce: current.nonce,
    });
  }
  return fail("Timed out waiting for Patchright browser");
}

async function readProtocolRequest(): Promise<unknown> {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return JSON.parse(value);
}

async function protocolMain(): Promise<unknown> {
  let payload: Record<string, any>;
  try {
    const request = await readProtocolRequest();
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      return fail("Invalid plugin request");
    }
    payload = request as Record<string, any>;
  } catch {
    return fail("Invalid JSON request");
  }
  if (payload.protocol !== PROTOCOL) {
    return fail("Unsupported plugin protocol");
  }
  if (payload.type === "plugin.manifest") {
    return {
      protocol: PROTOCOL,
      success: true,
      manifest: {
        name: "patchright",
        description: "Local Patchright persistent Chromium provider",
        capabilities: ["browser.provider"],
      },
    };
  }
  if (payload.capability !== "browser.provider") {
    return fail("Unsupported capability");
  }
  if (payload.type === "browser.launch") {
    return await launch(payload.request?.launchOptions || {});
  }
  if (payload.type === "browser.close") {
    const cleanup = payload.request as Cleanup;
    if (
      !cleanup?.instanceId ||
      !cleanup?.controlPort ||
      !cleanup?.nonce
    ) {
      return fail("Invalid cleanup token");
    }
    const result = await sendClose(cleanup);
    if (result === "rejected") return fail("Patchright cleanup token was rejected");
    if (result === "unreachable" && (await readState(cleanup.instanceId))) {
      return fail("Patchright supervisor could not be reached");
    }
    return { protocol: PROTOCOL, success: true, data: {} };
  }
  return fail("Unsupported request type");
}

function resolvePatchrightCli(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("patchright/package.json")), "cli.js");
}

async function installBrowser(browser: string): Promise<void> {
  if (!new Set(["chrome", "chromium"]).has(browser)) {
    throw new Error(
      "Usage: agent-browser-plugin-patchright install [chrome|chromium]",
    );
  }
  const child = spawn(process.execPath, [resolvePatchrightCli(), "install", browser], {
    stdio: "inherit",
  });
  const result = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (result !== 0) throw new Error(`Patchright browser installer exited ${result}`);
}

async function main(): Promise<void> {
  if (process.argv[2] === "__supervise") {
    await supervise(process.argv[3]!);
    return;
  }
  if (process.argv[2] === "cleanup") {
    console.log(JSON.stringify(await cleanupAll()));
    return;
  }
  if (process.argv[2] === "install") {
    await installBrowser(process.argv[3] || "chrome");
    return;
  }
  respond(await protocolMain());
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (!process.argv[2]) {
    respond(fail(message));
    return;
  }
  console.error(message);
  process.exitCode = 1;
});

export { mapLaunchOptions } from "./runtime.js";
