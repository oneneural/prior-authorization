import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../v2/files.js';
import { CONTRIBUTION_EXPECTATIONS_DIR, CONTRIBUTION_SUITE_ROOT, importedPath, loadContributionPackage, NOT_IMPORTED, PACKAGE_SUMS_SHA256, sha256, verifyPackage } from './package.js';

describe('imported regression contribution package', () => {
  it('matches every SHA256SUMS line except the two files the source package excludes', async () => {
    const sums = await verifyPackage();
    expect(sums.sumsSha256).toBe(PACKAGE_SUMS_SHA256);
    expect(sums.mismatched).toEqual([]);
    expect(sums.missing).toEqual([]);
    expect(sums.notImported).toEqual([...NOT_IMPORTED]);
    expect(sums.verified).toHaveLength(45);
  });

  it('parses the frozen gold strictly, with case denominators summing to the cohort', async () => {
    const { expectations } = await loadContributionPackage();
    expect(expectations.cases.map((item) => item.caseId)).toEqual(['CR01', 'CR02', 'CR03', 'CR04']);
    expect(expectations.cohortDenominators).toEqual({ requiredFacts: 14, usefulRequests: 1, abstentionOpportunities: 3, blockedCases: 4 });
  });

  it('reuses the finalized F01 order byte for byte', async () => {
    const original = sha256(await readFile(join(REPO_ROOT, 'evals', 'fixtures', 'F01', 'documents', 'f01-order.v1.json')));
    const sidecar = sha256(await readFile(join(REPO_ROOT, 'evals', 'fixtures', 'F01', 'documents', 'f01-order.v1.meta.json')));
    for (const caseId of ['CR01', 'CR02', 'CR04']) {
      expect(sha256(await readFile(importedPath(`cases/${caseId}/documents/f01-order.v1.json`)))).toBe(original);
      expect(sha256(await readFile(importedPath(`cases/${caseId}/documents/f01-order.v1.meta.json`)))).toBe(sidecar);
    }
  });

  it('reports a changed byte or a missing file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pa-contribution-'));
    try {
      await cp(join(REPO_ROOT, CONTRIBUTION_SUITE_ROOT), join(root, CONTRIBUTION_SUITE_ROOT), { recursive: true });
      await cp(join(REPO_ROOT, CONTRIBUTION_EXPECTATIONS_DIR), join(root, CONTRIBUTION_EXPECTATIONS_DIR), { recursive: true });
      const register = importedPath('cases/CR04/documents/cr04-m-register.v1.json', root);
      await writeFile(register, (await readFile(register, 'utf8')).replace('"exempt"', '"non_exempt"'));
      await rm(importedPath('report-template.md', root));
      const sums = await verifyPackage(root);
      expect(sums.mismatched).toEqual(['cases/CR04/documents/cr04-m-register.v1.json']);
      expect(sums.missing).toEqual(['report-template.md']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses gold whose bytes differ from the pin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pa-contribution-'));
    try {
      await cp(join(REPO_ROOT, CONTRIBUTION_EXPECTATIONS_DIR), join(root, CONTRIBUTION_EXPECTATIONS_DIR), { recursive: true });
      const path = join(root, CONTRIBUTION_EXPECTATIONS_DIR, 'expectations.json');
      await writeFile(path, `${await readFile(path, 'utf8')} `);
      await expect(loadContributionPackage(root)).rejects.toThrow(/expectations.json differs from its pinned hash/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
