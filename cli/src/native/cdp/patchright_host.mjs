import { chromium } from "patchright";
import { existsSync } from "node:fs";

function readOption(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJsonOption(name, fallback) {
  const raw = readOption(name);
  if (!raw) return fallback;
  return JSON.parse(raw);
}

const profile = readOption("profile");
const port = readOption("port");
const headless = readOption("headless") === "true";
const executablePath = readOption("executable-path");
const userAgent = readOption("user-agent");
const proxy = readOption("proxy");
const proxyBypass = readOption("proxy-bypass");
const proxyUsername = readOption("proxy-username");
const proxyPassword = readOption("proxy-password");
const ignoreHTTPSErrors = readOption("ignore-https-errors") === "true";
const downloadsPath = readOption("download-path");
const colorScheme = readOption("color-scheme");
const args = readJsonOption("args", []);

if (!profile || !port) {
  console.error("patchright host requires --profile and --port");
  process.exit(2);
}

function isRemoteDebuggingArg(arg) {
  return arg === "--remote-debugging-address"
    || arg.startsWith("--remote-debugging-address=")
    || arg === "--remote-debugging-port"
    || arg.startsWith("--remote-debugging-port=");
}

const userArgs = args.filter((arg) => !isRemoteDebuggingArg(arg));

const launchOptions = {
  headless,
  viewport: null,
  ignoreHTTPSErrors,
  args: [
    ...userArgs,
    "--disable-blink-features=AutomationControlled",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
  ],
};

if (executablePath && existsSync(executablePath)) {
  launchOptions.executablePath = executablePath;
}

if (userAgent) {
  launchOptions.userAgent = userAgent;
}

if (proxy) {
  launchOptions.proxy = { server: proxy };
  if (proxyBypass) launchOptions.proxy.bypass = proxyBypass;
  if (proxyUsername) launchOptions.proxy.username = proxyUsername;
  if (proxyPassword) launchOptions.proxy.password = proxyPassword;
}

if (downloadsPath) {
  launchOptions.downloadsPath = downloadsPath;
}

if (colorScheme) {
  launchOptions.colorScheme = colorScheme;
}

let context;
let closed = false;

async function shutdown() {
  if (closed) return;
  closed = true;
  try {
    await context?.close();
  } catch {
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("disconnect", shutdown);

context = await chromium.launchPersistentContext(profile, launchOptions);
console.log(JSON.stringify({ ready: true, port: Number(port) }));

setInterval(() => {}, 60_000);
