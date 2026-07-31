import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createConnection, createServer, type Server } from "node:net";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE_PATTERN = /^[0-9a-f]{64}$/i;
const CDP_PATH_PATTERN = /^\/devtools\/browser\/[A-Za-z0-9._-]+$/;

export const runtimeDir = () =>
  process.env.AGENT_BROWSER_PATCHRIGHT_RUNTIME_DIR ||
  join(homedir(), ".agent-browser", "providers", "patchright");

function validateInstanceId(instanceId: string): void {
  if (!UUID_PATTERN.test(instanceId)) {
    throw new Error("Invalid Patchright instance ID");
  }
}

export const statePath = (instanceId: string) => {
  validateInstanceId(instanceId);
  return join(runtimeDir(), `${instanceId}.json`);
};

export const bootstrapPath = (instanceId: string) => {
  validateInstanceId(instanceId);
  return join(runtimeDir(), `${instanceId}.bootstrap.json`);
};

export const profileDir = (instanceId: string) => {
  validateInstanceId(instanceId);
  return join(runtimeDir(), "profiles", instanceId);
};

export type RuntimeStatus = "starting" | "ready" | "closing" | "failed";

export type State = {
  instanceId: string;
  pid: number;
  controlPort: number;
  nonce: string;
  createdAt: number;
  status: RuntimeStatus;
  cdpUrl?: string;
  error?: string;
};

export type Cleanup = {
  instanceId: string;
  controlPort: number;
  nonce: string;
};

export type RequestedOptions = {
  headed?: boolean;
  engine?: string;
  userAgent?: string | null;
  colorScheme?: "dark" | "light" | "no-preference" | null;
};

export type Bootstrap = {
  state: State;
  request: RequestedOptions;
};

async function ensureRuntimeDir(): Promise<void> {
  await mkdir(runtimeDir(), { recursive: true, mode: 0o700 });
  await mkdir(join(runtimeDir(), "profiles"), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir(), 0o700).catch(() => {});
  await chmod(join(runtimeDir(), "profiles"), 0o700).catch(() => {});
}

function isRequestedOptions(value: unknown): value is RequestedOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    (request.headed === undefined || typeof request.headed === "boolean") &&
    (request.engine === undefined || typeof request.engine === "string") &&
    (request.userAgent === undefined ||
      request.userAgent === null ||
      typeof request.userAgent === "string") &&
    (request.colorScheme === undefined ||
      request.colorScheme === null ||
      new Set(["dark", "light", "no-preference"]).has(
        request.colorScheme as string,
      ))
  );
}

function isLoopbackCdpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return (
      url.protocol === "ws:" &&
      url.hostname === "127.0.0.1" &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65_535 &&
      CDP_PATH_PATTERN.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function parseState(
  value: unknown,
  expectedInstanceId: string,
  allowUnstarted = false,
): State {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Patchright state");
  }
  const state = value as Record<string, unknown>;
  const validStatus = new Set(["starting", "ready", "closing", "failed"]);
  if (
    state.instanceId !== expectedInstanceId ||
    !UUID_PATTERN.test(expectedInstanceId) ||
    !Number.isInteger(state.pid) ||
    (allowUnstarted ? state.pid !== 0 : Number(state.pid) < 1) ||
    !Number.isInteger(state.controlPort) ||
    (allowUnstarted ? state.controlPort !== 0 : Number(state.controlPort) < 1) ||
    Number(state.controlPort) > 65_535 ||
    typeof state.nonce !== "string" ||
    !NONCE_PATTERN.test(state.nonce) ||
    !Number.isFinite(state.createdAt) ||
    Number(state.createdAt) < 0 ||
    typeof state.status !== "string" ||
    !validStatus.has(state.status) ||
    (allowUnstarted && state.status !== "starting") ||
    (allowUnstarted && state.cdpUrl !== undefined) ||
    (state.cdpUrl !== undefined && !isLoopbackCdpUrl(state.cdpUrl)) ||
    (state.error !== undefined && typeof state.error !== "string")
  ) {
    throw new Error("Invalid Patchright state");
  }
  return state as State;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await ensureRuntimeDir();
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, path);
}

export async function writeState(state: State): Promise<void> {
  parseState(state, state.instanceId);
  await writePrivateJson(statePath(state.instanceId), state);
}

export async function writeBootstrap(bootstrap: Bootstrap): Promise<string> {
  parseState(bootstrap.state, bootstrap.state.instanceId, true);
  if (!isRequestedOptions(bootstrap.request)) {
    throw new Error("Invalid Patchright launch options");
  }
  const path = bootstrapPath(bootstrap.state.instanceId);
  await writePrivateJson(path, bootstrap);
  return path;
}

export async function takeBootstrap(path: string): Promise<Bootstrap> {
  const resolvedPath = resolve(path);
  if (
    dirname(resolvedPath) !== resolve(runtimeDir()) ||
    !resolvedPath.endsWith(".bootstrap.json")
  ) {
    throw new Error("Invalid Patchright supervisor bootstrap path");
  }
  const expectedInstanceId = basename(resolvedPath, ".bootstrap.json");
  validateInstanceId(expectedInstanceId);
  try {
    const bootstrap = JSON.parse(await readFile(resolvedPath, "utf8")) as Bootstrap;
    const state = parseState(bootstrap?.state, expectedInstanceId, true);
    if (!isRequestedOptions(bootstrap?.request)) {
      throw new Error("Invalid Patchright launch options");
    }
    return { state, request: bootstrap.request };
  } finally {
    await rm(resolvedPath, { force: true });
  }
}

export async function readState(instanceId: string): Promise<State | undefined> {
  try {
    return parseState(
      JSON.parse(await readFile(statePath(instanceId), "utf8")),
      instanceId,
    );
  } catch {
    return undefined;
  }
}

export async function removeState(instanceId: string): Promise<void> {
  validateInstanceId(instanceId);
  await Promise.all([
    rm(statePath(instanceId), { force: true }),
    rm(bootstrapPath(instanceId), { force: true }),
    rm(profileDir(instanceId), { recursive: true, force: true }),
  ]);
}

async function removeStateFile(instanceId: string): Promise<void> {
  await rm(statePath(instanceId), { force: true });
}

export function maxLifetimeMs(): number {
  const parsed = Number(
    process.env.AGENT_BROWSER_PATCHRIGHT_MAX_LIFETIME_MS ?? 86_400_000,
  );
  return Number.isFinite(parsed)
    ? Math.min(7 * 86_400_000, Math.max(60_000, parsed))
    : 86_400_000;
}

export type CloseResult = "closed" | "rejected" | "unreachable";

export async function sendClose(cleanup: Cleanup): Promise<CloseResult> {
  if (
    !cleanup.instanceId ||
    !Number.isInteger(cleanup.controlPort) ||
    cleanup.controlPort < 1 ||
    cleanup.controlPort > 65_535 ||
    !cleanup.nonce
  ) {
    return "rejected";
  }

  return await new Promise<CloseResult>((resolve) => {
    let settled = false;
    let response = "";
    const finish = (result: CloseResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      resolve(result);
    };
    const client = createConnection({
      host: "127.0.0.1",
      port: cleanup.controlPort,
    });
    const timer = setTimeout(() => finish("unreachable"), 10_000);
    client.setEncoding("utf8");
    client.once("connect", () => {
      client.write(
        `${JSON.stringify({
          instanceId: cleanup.instanceId,
          nonce: cleanup.nonce,
          action: "close",
        })}\n`,
      );
    });
    client.on("data", (chunk) => {
      response += chunk;
      if (!response.includes("\n")) return;
      try {
        const result = JSON.parse(response) as { ok?: boolean };
        finish(result.ok ? "closed" : "rejected");
      } catch {
        finish("rejected");
      }
    });
    client.once("error", () => finish("unreachable"));
    client.once("end", () => {
      if (!settled) finish("unreachable");
    });
  });
}

export function createControlServer(
  instanceId: string,
  nonce: string,
  close: () => Promise<void>,
): Server {
  return createServer((socket) => {
    let input = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on("data", (chunk) => {
      if (handled) return;
      input += chunk;
      if (input.length > 4096) {
        handled = true;
        socket.end('{"ok":false}\n');
        return;
      }
      if (!input.includes("\n")) return;
      handled = true;
      try {
        const message = JSON.parse(input) as {
          instanceId?: string;
          nonce?: string;
          action?: string;
        };
        if (
          message.nonce !== nonce ||
          message.instanceId !== instanceId ||
          message.action !== "close"
        ) {
          socket.end('{"ok":false}\n');
          return;
        }
        void close().then(
          () => socket.end('{"ok":true}\n'),
          () => socket.end('{"ok":false}\n'),
        );
      } catch {
        socket.end('{"ok":false}\n');
      }
    });
  });
}

export async function cleanupStale(now = Date.now()): Promise<number> {
  await ensureRuntimeDir();
  let removed = 0;
  for (const name of await readdir(runtimeDir())) {
    const path = join(runtimeDir(), name);
    if (name.endsWith(".bootstrap.json")) {
      const stat = await import("node:fs/promises").then((fs) => fs.stat(path));
      if (now - stat.mtimeMs > 60_000) {
        await rm(path, { force: true });
        removed++;
      }
      continue;
    }
    if (!name.endsWith(".json")) continue;
    try {
      const instanceId = basename(name, ".json");
      const state = parseState(
        JSON.parse(await readFile(path, "utf8")),
        instanceId,
      );
      if (state.status === "failed") {
        await removeStateFile(instanceId);
        removed++;
        continue;
      }
      const expired = now - state.createdAt > maxLifetimeMs();
      const result = expired
        ? await sendClose({
            instanceId: state.instanceId,
            controlPort: state.controlPort,
            nonce: state.nonce,
          })
        : undefined;

      if (result === "closed") {
        removed++;
      }
    } catch {
      await rm(path, { force: true });
      removed++;
    }
  }
  return removed;
}

export async function cleanupAll(): Promise<{
  closed: number;
  retained: number;
}> {
  await ensureRuntimeDir();
  let closed = 0;
  let retained = 0;
  for (const name of await readdir(runtimeDir())) {
    if (!name.endsWith(".json") || name.endsWith(".bootstrap.json")) continue;
    try {
      const instanceId = basename(name, ".json");
      const state = parseState(
        JSON.parse(await readFile(join(runtimeDir(), name), "utf8")),
        instanceId,
      );
      if (state.status === "failed") {
        await removeStateFile(instanceId);
        closed++;
        continue;
      }
      const result = await sendClose({
        instanceId: state.instanceId,
        controlPort: state.controlPort,
        nonce: state.nonce,
      });
      if (result === "closed") {
        closed++;
      } else {
        retained++;
      }
    } catch {
      await rm(join(runtimeDir(), name), { force: true });
      closed++;
    }
  }
  return { closed, retained };
}

export function mapLaunchOptions(request: RequestedOptions) {
  return {
    headless: !request.headed,
    channel: process.env.AGENT_BROWSER_PATCHRIGHT_CHANNEL || "chrome",
    viewport: null,
    timeout: 35_000,
    ...(request.userAgent ? { userAgent: request.userAgent } : {}),
    ...(request.colorScheme ? { colorScheme: request.colorScheme } : {}),
    args: [
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
    ],
  };
}
