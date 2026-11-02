// MAIR-711: checks what the preset decides for representative dependencies, so a later edit cannot
// silently drop the supply-chain rules (3-day quarantine on npm / crates.io, digests pinned).
// Renovate applies packageRules in order and later matches override earlier ones; resolve() replays that
// for the matchers this preset uses. renovate-config-validator (CI) checks the syntax.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const preset = JSON.parse(readFileSync(new URL('../default.json', import.meta.url), 'utf8'));

const pattern = (value) => (value.startsWith('/') && value.endsWith('/') ? new RegExp(value.slice(1, -1)) : null);
const matchesName = (patterns, name) => patterns.some((p) => (pattern(p) ? pattern(p).test(name) : p === name));

function resolve(dep) {
  const config = {};
  for (const rule of preset.packageRules) {
    if (rule.matchManagers && !rule.matchManagers.includes(dep.manager)) continue;
    if (rule.matchDatasources && !rule.matchDatasources.includes(dep.datasource)) continue;
    if (rule.matchPackageNames && !matchesName(rule.matchPackageNames, dep.packageName)) continue;
    if (rule.matchUpdateTypes && !rule.matchUpdateTypes.includes(dep.updateType)) continue;
    if (rule.matchFileNames && !rule.matchFileNames.includes(dep.fileName)) continue;
    if (rule.matchCurrentVersion && !pattern(rule.matchCurrentVersion).test(dep.currentVersion ?? '')) continue;
    for (const [key, value] of Object.entries(rule)) {
      if (!key.startsWith('match') && key !== 'description') config[key] = value;
    }
  }
  return config;
}

test('MAIR-711 no branch is created before the release age is reached', () => {
  assert.equal(preset.internalChecksFilter, 'strict');
});

for (const dep of [
  { manager: 'npm', packageName: 'express', updateType: 'minor', currentVersion: '5.1.0', fileName: 'package.json' },
  { manager: 'npm', packageName: 'zod', updateType: 'patch', currentVersion: '4.1.0', fileName: 'package.json' },
  { manager: 'cargo', packageName: 'serde', updateType: 'patch', currentVersion: '1.0.200', fileName: 'Cargo.toml' },
]) {
  test(`MAIR-711 a third-party ${dep.manager} ${dep.updateType} waits 3 days, then automerges`, () => {
    const config = resolve(dep);
    assert.equal(config.minimumReleaseAge, '3 days');
    assert.equal(config.automerge, true);
  });
}

for (const packageName of ['@mairie360/core-api-openapi', '@mairie360/bffs-lib', 'mairie360_api_lib']) {
  test(`MAIR-711 our own package ${packageName} has no quarantine`, () => {
    const manager = packageName.startsWith('@') ? 'npm' : 'cargo';
    assert.equal(resolve({ manager, packageName, updateType: 'patch', currentVersion: '1.0.0' }).minimumReleaseAge, null);
  });
}

for (const dep of [
  { manager: 'github-actions', packageName: 'actions/checkout' },
  { manager: 'dockerfile', packageName: 'node', fileName: 'Dockerfile' },
  { manager: 'docker-compose', packageName: 'postgres', fileName: 'docker-compose-security.yml' },
]) {
  test(`MAIR-711 third-party ${dep.manager} ref ${dep.packageName} is pinned by digest`, () => {
    assert.equal(resolve({ updateType: 'minor', ...dep }).pinDigests, true);
  });
}

for (const dep of [
  { manager: 'github-actions', packageName: 'mairie360/CICD' },
  { manager: 'docker-compose', packageName: 'ghcr.io/mairie360/core-api', fileName: 'docker-compose-security.yml' },
]) {
  test(`MAIR-711 internal ref ${dep.packageName} stays on its tag`, () => {
    assert.equal(resolve({ updateType: 'minor', ...dep }).pinDigests, false);
  });
}

test('MAIR-711 a pinDigest update has no quarantine and automerges, except in the production Dockerfile', () => {
  const inCompose = resolve({ manager: 'docker-compose', packageName: 'redis', updateType: 'pinDigest', fileName: 'docker-compose-security.yml' });
  assert.equal(inCompose.minimumReleaseAge, null);
  assert.equal(inCompose.automerge, true);
  const inProd = resolve({ manager: 'dockerfile', packageName: 'node', updateType: 'pinDigest', fileName: 'Dockerfile' });
  assert.equal(inProd.automerge, false);
});

test('rules kept: mairie360/CICD and the production Dockerfile are never automerged, majors are not automerged', () => {
  assert.equal(resolve({ manager: 'github-actions', packageName: 'mairie360/CICD', updateType: 'minor' }).automerge, false);
  assert.equal(resolve({ manager: 'dockerfile', packageName: 'node', updateType: 'minor', fileName: 'Dockerfile' }).automerge, false);
  assert.notEqual(resolve({ manager: 'npm', packageName: 'express', updateType: 'major', currentVersion: '5.1.0' }).automerge, true);
});
