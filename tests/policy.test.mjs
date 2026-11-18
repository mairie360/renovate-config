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

for (const repository of ['mairie360/BFF_Project', 'mairie360/Projects_Web_Service']) {
  test(`MAIR-998 no bump PR for the OpenAPI contracts in ${repository}`, () => {
    for (const currentVersion of ['0.0.0-dev-156a9b9', '2.3.0']) {
      const config = resolve({ manager: 'npm', datasource: 'npm', packageName: '@mairie360/core-api-openapi',
        currentVersion, updateType: 'minor', repository });
      assert.equal(config.enabled, false);
      assert.equal(config.followTag, undefined);
    }
  });
}

test('MAIR-998 the libraries keep their bump PRs', () => {
  for (const packageName of ['@mairie360/bffs-lib', '@mairie360/lib-components']) {
    assert.notEqual(resolve({ manager: 'npm', datasource: 'npm', packageName, updateType: 'minor', currentVersion: '2.7.0' }).enabled, false);
  }
});

test('MAIR-1010 automerge at any time, but never a major, local dev files included', () => {
  assert.deepEqual(preset.schedule, ['at any time']);
  assert.equal(preset.automergeSchedule, undefined);
  for (const fileName of ['docker-compose.yml', 'development.Dockerfile', 'package.json']) {
    const manager = fileName === 'package.json' ? 'npm' : fileName.endsWith('Dockerfile') ? 'dockerfile' : 'docker-compose';
    assert.notEqual(resolve({ manager, packageName: 'postgres', updateType: 'major', currentVersion: '17.0.0', fileName }).automerge, true, fileName);
  }
  assert.equal(resolve({ manager: 'docker-compose', packageName: 'postgres', updateType: 'minor', currentVersion: '17.0.0', fileName: 'docker-compose.yml' }).automerge, true);
});

// MAIR-685: auto-approve.yml calls the reusable workflow of mairie360/CICD with a `cicd_version` input,
// like gdpr-pr.yml: the regex manager must track that input so the mairie360/CICD group moves both pins.
test('MAIR-685 the cicd_version input of auto-approve.yml and gdpr-pr.yml is tracked', () => {
  const caller = `    uses: mairie360/CICD/.github/workflows/auto-approve.yml@v5.13.0
    with:
      cicd_version: v5.13.0   # same release as the \`uses:\` ref
`;
  for (const file of ['.github/workflows/auto-approve.yml', '.github/workflows/gdpr-pr.yml']) {
    const managers = (preset.customManagers ?? []).filter((manager) =>
      manager.managerFilePatterns.some((p) => pattern(p)?.test(file)));
    const tracked = managers.filter((manager) => manager.depNameTemplate === 'mairie360/CICD');
    assert.equal(tracked.length, 1, `${file} is tracked by one mairie360/CICD manager`);
    const match = tracked[0].matchStrings.map((source) => new RegExp(source).exec(caller)).find(Boolean);
    assert.equal(match?.groups.currentValue, 'v5.13.0', file);
  }
  assert.ok(!(preset.customManagers ?? []).some((manager) =>
    manager.managerFilePatterns.some((p) => pattern(p)?.test('.github/workflows/cicd.yml'))), 'cicd.yml stays with each repository');
});
