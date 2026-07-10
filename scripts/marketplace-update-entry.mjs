#!/usr/bin/env node
// Upserts a single plugin entry into a Claude Code plugin marketplace catalog
// (.claude-plugin/marketplace.json). Run with CWD set to a checkout of the
// marketplace catalog repository (see scripts/update-marketplace-catalog.sh).
//
// Required env vars:
//   PLUGIN_NAME           - marketplace entry key (kebab-case)
//   PLUGIN_DESCRIPTION    - human-readable description
//   PLUGIN_BITBUCKET_URL  - git URL of the plugin distribution repo
// Optional env vars:
//   PLUGIN_REF            - git tag/branch to pin the plugin source to

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const CATALOG_PATH = '.claude-plugin/marketplace.json';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

const name = requireEnv('PLUGIN_NAME');
const description = requireEnv('PLUGIN_DESCRIPTION');
const bitbucketUrl = requireEnv('PLUGIN_BITBUCKET_URL');
const ref = process.env.PLUGIN_REF || undefined;

let catalog;
try {
  catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
} catch {
  catalog = { name: 'company-internal-plugins', owner: { name: 'Internal Dev Team' }, plugins: [] };
}

const source = { source: 'url', url: bitbucketUrl };
if (ref) {
  source.ref = ref;
}

const entry = { name, description, source };

const idx = catalog.plugins.findIndex((p) => p.name === name);
if (idx >= 0) {
  catalog.plugins[idx] = entry;
} else {
  catalog.plugins.push(entry);
}

// Validate the resulting catalog shape before writing it back, so a corrupt
// existing file or a bug here fails fast instead of pushing bad data.
if (!catalog.name || !Array.isArray(catalog.plugins)) {
  throw new Error('invalid marketplace.json structure after update');
}
for (const p of catalog.plugins) {
  if (!p.name || !p.source?.url) {
    throw new Error(`invalid plugin entry: ${JSON.stringify(p)}`);
  }
}

mkdirSync('.claude-plugin', { recursive: true });
writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
