import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './fixture.js';

// Runtime code must not read the evaluator's expectations (SPEC "Critical
// fixture suite"). ESLint blocks imports from evals/; this test also catches a
// path built as a string, for example for a file system read, whether written
// whole or assembled from segments such as join('evals', 'oracles').
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.next', 'coverage']);
const ORACLE_PATH = /evals[\\/]+oracles/;
const MENTIONS_EVALS = /\bevals\b/;
const ORACLES_LITERAL = /(['"`])oracles\1/;

const referencesOracles = (text: string) => ORACLE_PATH.test(text) || (MENTIONS_EVALS.test(text) && ORACLES_LITERAL.test(text));

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

describe('oracle independence', () => {
  it('no file under packages/ or apps/ references the evals/oracles path', async () => {
    const files = [...(await sourceFiles(join(REPO_ROOT, 'packages'))), ...(await sourceFiles(join(REPO_ROOT, 'apps')))];
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      if (referencesOracles(await readFile(file, 'latin1'))) {
        offenders.push(relative(REPO_ROOT, file).split(sep).join('/'));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('recognises the path in either separator style or assembled from segments', () => {
    expect(referencesOracles("readFile('../../evals/oracles/F01.json')")).toBe(true);
    expect(referencesOracles('C:\\repo\\evals\\oracles\\F01.json')).toBe(true);
    expect(referencesOracles("readFile(join(root, 'evals', 'oracles', 'F01.json'))")).toBe(true);
    expect(referencesOracles('const dir = "evals"; const sub = `oracles`;')).toBe(true);
    expect(referencesOracles('evals/fixtures/F01/case.json')).toBe(false);
    expect(referencesOracles("const label = 'oracles'; // no evaluator directory")).toBe(false);
  });
});
