#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const installRsPath = join(rootDir, 'cli/src/install.rs');
const trackingPath = join(rootDir, 'priv/version-tracking.json');

function usage() {
  console.error('Usage: node scripts/update-patchright-version.mjs <version|latest>');
}

function npmLatest() {
  return execFileSync('npm', ['view', 'patchright', 'version'], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid Patchright version: ${version}`);
  }
}

function buildPackageFiles(version) {
  const packageJson = {
    name: 'patchright',
    private: true,
    type: 'module',
    dependencies: {
      patchright: version,
    },
  };

  const dir = mkdtempSync(join(tmpdir(), 'agent-browser-patchright-'));
  try {
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
    execFileSync(
      'npm',
      [
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--fund=false',
      ],
      {
        cwd: dir,
        stdio: 'inherit',
        timeout: 60_000,
      },
    );
    const packageLock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
    if (packageLock.packages?.['']) {
      delete packageLock.packages[''].name;
    }
    return {
      packageJson: `${JSON.stringify(packageJson, null, 2)}\n`,
      packageLock: `${JSON.stringify(packageLock, null, 2)}\n`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function replaceRawString(source, name, value) {
  const pattern = new RegExp(`let ${name} = r#"(.*?)"#;`, 's');
  if (!pattern.test(source)) {
    throw new Error(`Could not find raw string ${name} in cli/src/install.rs`);
  }
  return source.replace(pattern, `let ${name} = r#"${value}"#;`);
}

function updateInstallRs(version, packageJson, packageLock) {
  let source = readFileSync(installRsPath, 'utf8');
  source = source.replace(
    /pub const PATCHRIGHT_VERSION:\s*&str\s*=\s*"[^"]+";/,
    `pub const PATCHRIGHT_VERSION: &str = "${version}";`,
  );
  source = replaceRawString(source, 'package_json', packageJson);
  source = replaceRawString(source, 'package_lock', packageLock);
  writeFileSync(installRsPath, source);
}

function updateTracking(version) {
  const tracking = JSON.parse(readFileSync(trackingPath, 'utf8'));
  tracking.patchright_pin = version;
  writeFileSync(trackingPath, `${JSON.stringify(tracking, null, 2)}\n`);
}

const requested = process.argv[2];
if (!requested) {
  usage();
  process.exit(1);
}

const version = requested === 'latest' ? npmLatest() : requested;
validateVersion(version);

const { packageJson, packageLock } = buildPackageFiles(version);
updateInstallRs(version, packageJson, packageLock);
updateTracking(version);

console.log(`Updated Patchright backend pin to ${version}`);
