import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../v2/files.js';
import { loadContributionPackage } from './package.js';

// Contribution custody: runtime, worker, API, web and prompt code never read the
// contribution gold, cases or evaluator, and the image build context excludes
// them. The general oracle and v2 checks (../independence.test.ts,
// ../v2/independence.test.ts) stay in force; this adds the contribution paths,
// the gold schema names and the gold target identities. ESLint's
// no-evals-imports rule also forbids any runtime import from evals/.

const CONTRIBUTION_SRC = join(REPO_ROOT, 'evals', 'src', 'contribution');
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.next', 'coverage']);
const ALLOWED_IMPORTS = [
  /^node:/, /^vitest$/, /^zod$/, /^@pa\/contracts$/, /^@pa\/domain$/, /^@pa\/agents$/, /^@langchain\/langgraph$/,
  /^\.\/[a-z0-9-]+\.js$/, /^\.\.\/agent-comparison\.js$/, /^\.\.\/v2\/files\.js$/, /^\.\.\/v2\/loader\.js$/,
];
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"`;]*?from\s*(['"])([^'"]+)\1|\bimport\s*\(\s*(['"])([^'"]+)\3\s*\)|(?:^|\n)\s*import\s*(['"])([^'"]+)\5/g;
const importsOf = (text: string) => [...text.matchAll(IMPORT)].map((match) => match[2] ?? match[4] ?? match[6] ?? '');

/** A contribution path, whole or assembled from segments, or a gold schema name. */
const CONTRIBUTION_PATH = /(?:expectations|suites)[\\/]+contribution|contribution-regression|pa\.contribution-(?:expectations|scoring)/;
const MENTIONS_EVALS = /\bevals\b/;
const CONTRIBUTION_LITERAL = /(['"`])contribution\1/;
const referencesContribution = (text: string) => CONTRIBUTION_PATH.test(text) || (MENTIONS_EVALS.test(text) && CONTRIBUTION_LITERAL.test(text));

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...(await sourceFiles(join(dir, entry.name))));
    } else if (entry.isFile()) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

const display = (file: string) => relative(REPO_ROOT, file).split(sep).join('/');
// Everything the image build context admits besides manifests: packages/, apps/ and docker/.
const runtimeFiles = async () => [...(await sourceFiles(join(REPO_ROOT, 'packages'))), ...(await sourceFiles(join(REPO_ROOT, 'apps'))), ...(await sourceFiles(join(REPO_ROOT, 'docker')))];

describe('contribution evaluator independence', () => {
  it('no file under packages/, apps/ or docker/ names the contribution gold, cases or schemas', async () => {
    const files = await runtimeFiles();
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) if (referencesContribution(await readFile(file, 'latin1'))) offenders.push(display(file));
    expect(offenders).toEqual([]);
  });

  it('no runtime or prompt file embeds a gold target identity', async () => {
    const { expectations } = await loadContributionPackage();
    const targetIds = expectations.cases.flatMap((item) => [
      ...item.requiredSupportedFacts.map((target) => target.targetId), ...item.usefulNeutralRequests.map((target) => target.targetId), ...item.correctAbstentions.map((target) => target.targetId),
    ]);
    // Case-only document identities: every one is new in this package, unlike the reused f01-order.
    const documentIds = [...new Set(expectations.cases.flatMap((item) => item.requiredSupportedFacts.map((target) => target.documentId)))].filter((id) => /^cr0[0-9]-/.test(id));
    expect(targetIds).toHaveLength(14 + 1 + 3);
    const offenders: string[] = [];
    for (const file of await runtimeFiles()) {
      const text = await readFile(file, 'latin1');
      for (const needle of [...targetIds, ...documentIds]) if (text.includes(needle)) offenders.push(`${display(file)}: ${needle}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the image build context is an allowlist that excludes evals/', async () => {
    const lines = (await readFile(join(REPO_ROOT, '.dockerignore'), 'utf8')).split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
    expect(lines[0]).toBe('*');
    expect(lines.filter((line) => line.startsWith('!') && /evals/.test(line))).toEqual([]);
  });

  it('contribution evaluator files import only evaluator and public package modules', async () => {
    // This file is skipped: its detection samples below are deliberate offenders.
    const files = (await sourceFiles(CONTRIBUTION_SRC)).filter((file) => file !== import.meta.filename);
    expect(files.length).toBeGreaterThan(4);
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of importsOf(await readFile(file, 'utf8'))) {
        if (!ALLOWED_IMPORTS.some((pattern) => pattern.test(specifier))) offenders.push(`${display(file)}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('recognises contribution references in every form', () => {
    expect(referencesContribution("readFile('../../evals/expectations/contribution/expectations.json')")).toBe(true);
    expect(referencesContribution('C:\\repo\\evals\\suites\\contribution\\fixtures\\CR01')).toBe(true);
    expect(referencesContribution("join(root, 'evals', 'expectations', 'contribution')")).toBe(true);
    expect(referencesContribution("schemaVersion: 'pa.contribution-scoring.v2'")).toBe(true);
    expect(referencesContribution('/outside-root/contribution-regression/regression')).toBe(true);
    expect(referencesContribution("const label = 'contribution'; // no evaluator directory")).toBe(false);
    expect(referencesContribution('evals/suites/pa-agent/fixtures/F17a')).toBe(false);
    expect(importsOf("import { assess } from '../../apps/api/src/agent/service.js';")).toEqual(['../../apps/api/src/agent/service.js']);
    expect(ALLOWED_IMPORTS.some((pattern) => pattern.test('@pa/db'))).toBe(false);
    expect(ALLOWED_IMPORTS.some((pattern) => pattern.test('../oracles/F01.json'))).toBe(false);
  });
});
