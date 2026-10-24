import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './files.js';

// The v2 validators are evaluator code: they never import the assessment
// (`@pa/domain`), the app or the legacy v1 evaluator, and runtime code never
// reads the v2 suite. ESLint enforces the import rule; this test also checks
// files ESLint may not see and a suite path written as a string.

const V2_DIR = join(REPO_ROOT, 'evals', 'src', 'v2');
const ALLOWED_IMPORTS = [/^node:/, /^vitest$/, /^zod$/, /^@pa\/contracts$/, /^\.\/[a-z0-9-]+\.js$/, /^\.\.\/frozen-v2\.js$/, /^\.\.\/v2-batches\.js$/];
// The data-only registry, which later data tasks extend, imports only hash-only batch tables.
const REGISTRY_IMPORTS = [/^\.\/frozen-v2(?:-[a-z0-9-]+)?\.js$/];
const REGISTRY = join(REPO_ROOT, 'evals', 'src', 'v2-batches.ts');
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"`;]*?from\s*(['"])([^'"]+)\1|\bimport\s*\(\s*(['"])([^'"]+)\3\s*\)|(?:^|\n)\s*import\s*(['"])([^'"]+)\5/g;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.next', 'coverage']);

const importsOf = (text: string) => [...text.matchAll(IMPORT)].map((match) => match[2] ?? match[4] ?? match[6] ?? '');
const disallowed = (text: string, allowed: readonly RegExp[] = ALLOWED_IMPORTS) => importsOf(text).filter((specifier) => !allowed.some((pattern) => pattern.test(specifier)));
const SUITE_PATH = /policy-v2/;

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        files.push(...(await sourceFiles(join(dir, entry.name))));
      }
    } else if (entry.isFile()) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

const display = (file: string) => relative(REPO_ROOT, file).split(sep).join('/');

describe('v2 evaluator independence', () => {
  it('v2 files import only the allowed modules', async () => {
    // This file is skipped: its detection samples below are deliberate offenders.
    const files = (await sourceFiles(V2_DIR)).filter((file) => file !== import.meta.filename);
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of disallowed(await readFile(file, 'utf8'))) {
        offenders.push(`${display(file)}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the batch registry imports only frozen v2 batch tables', async () => {
    const imports = importsOf(await readFile(REGISTRY, 'utf8'));
    expect(imports).toContain('./frozen-v2.js');
    expect(imports.filter((specifier) => !REGISTRY_IMPORTS.some((pattern) => pattern.test(specifier)))).toEqual([]);
  });

  it('no file under packages/ or apps/ names the v2 suite', async () => {
    const files = [...(await sourceFiles(join(REPO_ROOT, 'packages'))), ...(await sourceFiles(join(REPO_ROOT, 'apps')))];
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      if (SUITE_PATH.test(await readFile(file, 'latin1'))) {
        offenders.push(display(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('detects disallowed imports in every form', () => {
    expect(disallowed("import { assess } from '@pa/domain';")).toEqual(['@pa/domain']);
    expect(disallowed("import type { X } from '@pa/domain/v2';")).toEqual(['@pa/domain/v2']);
    expect(disallowed("export { load } from '../fixture.js';")).toEqual(['../fixture.js']);
    expect(disallowed("const m = await import('../../apps/web/x.js');")).toEqual(['../../apps/web/x.js']);
    expect(disallowed("import '../harness.js';")).toEqual(['../harness.js']);
    expect(disallowed("import {\n  a,\n  b,\n} from '@pa/db';")).toEqual(['@pa/db']);
    expect(disallowed("import { z } from 'zod';\nimport { CORE_BATCH } from '../frozen-v2.js';\nimport { sha256 } from './files.js';")).toEqual([]);
  });

  it('admits only frozen v2 tables into the registry', () => {
    const registry = (text: string) => disallowed(text, REGISTRY_IMPORTS);
    expect(registry("import { CORE_BATCH } from './frozen-v2.js';\nimport { SCOPE_BATCH } from './frozen-v2-scope.js';")).toEqual([]);
    expect(registry("import { load } from './harness.js';")).toEqual(['./harness.js']);
    expect(registry("import { load } from './fixture.js';")).toEqual(['./fixture.js']);
    expect(registry("import { x } from './schemas.js';")).toEqual(['./schemas.js']);
    expect(registry("import { x } from './v2/loader.js';")).toEqual(['./v2/loader.js']);
    expect(registry("import { z } from 'zod';")).toEqual(['zod']);
    expect(registry("import { x } from './frozen-v2.json';")).toEqual(['./frozen-v2.json']);
  });
});
