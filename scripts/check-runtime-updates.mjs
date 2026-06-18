#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const installRsPath = join(rootDir, 'cli/src/install.rs');
const trackingPath = join(rootDir, 'priv/version-tracking.json');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readPatchrightPin() {
  const source = readFileSync(installRsPath, 'utf8');
  const match = source.match(/pub const PATCHRIGHT_VERSION:\s*&str\s*=\s*"([^"]+)"/);
  if (!match) {
    throw new Error('Could not find PATCHRIGHT_VERSION in cli/src/install.rs');
  }
  return match[1];
}

function npmLatest(packageName) {
  return execFileSync('npm', ['view', packageName, 'version'], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function upstreamTags() {
  const output = execFileSync(
    'git',
    [
      'ls-remote',
      '--tags',
      '--refs',
      'https://github.com/vercel-labs/agent-browser.git',
      'refs/tags/v*',
    ],
    {
      cwd: rootDir,
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1]?.replace('refs/tags/', ''))
    .filter(Boolean)
    .filter((tag) => /^v\d+\.\d+\.\d+/.test(tag));
}

function parseVersion(version) {
  const cleaned = version.replace(/^v/, '').split('-')[0];
  const parts = cleaned.split('.').map((part) => Number.parseInt(part, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return a.localeCompare(b);
}

function latestTag(tags) {
  if (tags.length === 0) return null;
  return [...tags].sort(compareVersions).at(-1);
}

function buildReport() {
  const tracking = readJson(trackingPath);
  const patchrightPinned = readPatchrightPin();
  const patchrightLatest = npmLatest('patchright');
  const latestUpstreamTag = latestTag(upstreamTags());

  return {
    patchright: {
      pinned: patchrightPinned,
      latest: patchrightLatest,
      outdated: patchrightPinned !== patchrightLatest,
      tracking_matches_source: tracking.patchright_pin === patchrightPinned,
    },
    agent_browser: {
      tracked_upstream_tag: tracking.agent_browser_upstream_tag,
      latest_upstream_tag: latestUpstreamTag,
      outdated: Boolean(
        latestUpstreamTag &&
          compareVersions(latestUpstreamTag, tracking.agent_browser_upstream_tag) > 0,
      ),
    },
    tracking: {
      path: 'priv/version-tracking.json',
      policy: tracking.policy,
    },
  };
}

function printHuman(report) {
  console.log('Runtime update check');
  console.log('');
  console.log(
    `Patchright: pinned ${report.patchright.pinned}, npm latest ${report.patchright.latest}`,
  );
  console.log(
    `  status: ${report.patchright.outdated ? 'outdated' : 'current'}`,
  );
  console.log(
    `  tracking: ${report.patchright.tracking_matches_source ? 'matches source' : 'does not match source'}`,
  );
  console.log('');
  console.log(
    `agent-browser upstream: tracked ${report.agent_browser.tracked_upstream_tag}, latest ${report.agent_browser.latest_upstream_tag ?? 'unknown'}`,
  );
  console.log(
    `  status: ${report.agent_browser.outdated ? 'sync available' : 'current'}`,
  );
}

const report = buildReport();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printHuman(report);
}

if (!report.patchright.tracking_matches_source) {
  process.exitCode = 1;
}
