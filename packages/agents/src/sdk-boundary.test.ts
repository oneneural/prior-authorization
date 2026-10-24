import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Source guard: the Anthropic SDK can send a Messages request from exactly one
// place, and that place sends only after a durable reservation and a dispatch
// grant from the API's admission service.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PROVIDER = 'packages/agents/src/providers/anthropic.ts';
const SKIP = new Set(['node_modules', 'dist', '.next', '.git', 'coverage', '.vitest', 'prior_auth', 'tests', 'fixtures', 'delivery', 'docs']);

async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await sources(path));
    else if (/\.(ts|tsx|mts|js|mjs|cjs)$/.test(entry.name)) found.push(path);
  }
  return found;
}

const files = async () => {
  const all = (await Promise.all(['apps', 'packages', 'evals', 'scripts', 'docker'].map((area) => sources(join(ROOT, area))))).flat();
  return Promise.all(all.map(async (path) => ({ path: relative(ROOT, path), text: await readFile(path, 'utf8') })));
};

describe('Anthropic SDK boundary', () => {
  it('has one runtime SDK import, one client construction and one Messages call site', async () => {
    const sourceFiles = (await files()).filter((file) => !/\.test\.tsx?$/.test(file.path));
    const valueImport = /^import\s+(?!type\b)[^;]*from\s+['"]@anthropic-ai\/sdk(?:\/[^'"]*)?['"]/m;
    const requireOrDynamic = /(?:require|import)\(\s*['"]@anthropic-ai\/sdk/;
    expect(sourceFiles.filter((file) => valueImport.test(file.text) || requireOrDynamic.test(file.text)).map((file) => file.path)).toEqual([PROVIDER]);
    expect(sourceFiles.filter((file) => /new\s+Anthropic\s*\(/.test(file.text)).map((file) => file.path)).toEqual([PROVIDER]);
    expect(sourceFiles.filter((file) => /messages\s*\.\s*(create|stream|countTokens)|\.beta\s*\./.test(file.text)).map((file) => file.path)).toEqual([PROVIDER]);
    // No runtime package other than agents depends on the SDK (the evaluation harness uses its types only).
    const manifests = await Promise.all(['apps/api', 'apps/web', 'apps/worker', 'packages/contracts', 'packages/db', 'packages/config', 'packages/domain', 'packages/connectors'].map(async (dir) => ({ dir, text: await readFile(join(ROOT, dir, 'package.json'), 'utf8') })));
    expect(manifests.filter((manifest) => manifest.text.includes('@anthropic-ai/sdk')).map((manifest) => manifest.dir)).toEqual([]);
  });

  it('sends the one request only after reserve and dispatch, with retries disabled', async () => {
    const text = await readFile(join(ROOT, PROVIDER), 'utf8');
    expect(text.match(/messages\.create\(/g)).toHaveLength(1);
    expect(text).toMatch(/messages\.create\(params, \{ signal, maxRetries: 0 \}\)/);
    expect(text).toMatch(/new Anthropic\(\{[^}]*maxRetries: 0[^}]*\}\)/);
    const next = text.slice(text.indexOf('async function next('));
    const reserve = next.indexOf('deps.admission.reserve(');
    const dispatch = next.indexOf('deps.admission.dispatch(');
    const send = next.indexOf('client.create(');
    expect(reserve).toBeGreaterThan(0);
    expect(dispatch).toBeGreaterThan(reserve);
    expect(send).toBeGreaterThan(dispatch);
    expect(next.match(/client\.create\(/g)).toHaveLength(1);
  });
});
