import { join } from 'node:path';

import { PolicyPackV2 } from '@pa/contracts';

import { auditFixtureFiles, checkBatch, checkUnion, type PinnedFixture } from './batches.js';
import { contentFree, decodeUtf8, type FileSystem, lstatOrNull, nodeFileSystem } from './files.js';
import { scanJson } from './json-scan.js';
import { auditFixtureRecipes, loadFixture, type LoadOutcome, readManifest } from './loader.js';
import { checkOracle } from './oracle-check.js';
import { type FrozenBatch, V2_SUITE_ROOT } from './schemas.js';

// `pnpm test:oracles:v2`: structural validation of every registered
// v2 batch. It verifies each batch's pins, the union and the suite inventory,
// audits every fixture's files, runs the loader, checks every oracle against
// its fixture and policy input, and then runs the separately labelled recipe
// pin audit. It needs no database, service, model key or network, and it is not
// an assessment, a false-ready measurement or a policy-outcome result.

export interface OraclesV2Result {
  exitCode: 0 | 1;
  problems: string[];
  report: string;
}

async function readOptional(fs: FileSystem, path: string): Promise<Uint8Array | null> {
  const info = await lstatOrNull(fs, path);
  return info?.isFile() === true ? fs.readFile(path) : null;
}

/** The oracle check of one fixture, with every byte it needs read here. */
async function oracleCheck(fixture: PinnedFixture, outcome: LoadOutcome, batches: readonly FrozenBatch[], repoRoot: string, fs: FileSystem): Promise<string[]> {
  const suite = join(repoRoot, V2_SUITE_ROOT);
  const batch = batches.find((candidate) => candidate.batchId === fixture.batchId);
  const read = await readManifest(suite, fixture.fixtureId, fs);
  const oracleBytes = await readOptional(fs, join(suite, 'oracles', `${fixture.fixtureId}.json`));
  const reviewed = batch === undefined ? null : await readOptional(fs, join(repoRoot, batch.policyPack.path));
  const reviewedPack = reviewed === null ? null : PolicyPackV2.safeParse(scanJson(decodeUtf8(reviewed) ?? '')?.value);
  if ('problems' in read || oracleBytes === null || batch === undefined || reviewedPack === null || !reviewedPack.success) {
    return ['oracle not checked: its manifest, oracle bytes or reviewed pack are unavailable'];
  }
  const policyPin = [batch.policyPack, ...batch.policyInputs].find((pin) => pin.path === read.manifest.policyInput.path);
  return checkOracle({
    fixtureId: fixture.fixtureId,
    pin: fixture,
    oracleBytes,
    manifest: read.manifest,
    manifestBytes: read.bytes,
    load: outcome,
    policyPin,
    policyBytes: policyPin === undefined ? null : await readOptional(fs, join(repoRoot, policyPin.path)),
    reviewedPack: reviewedPack.data,
  });
}

/** Runs every structural check over `batches` against the repository at `repoRoot`. */
export async function runOraclesV2(batches: readonly unknown[], repoRoot: string, fs: FileSystem = nodeFileSystem): Promise<OraclesV2Result> {
  const problems: string[] = [];
  const lines = ['Policy v2 structural validation (policy-v2): no assessment, no false-ready measurement and no policy outcome is computed.'];

  for (const [index, candidate] of batches.entries()) {
    const result = await checkBatch(candidate, repoRoot, fs);
    problems.push(...result.problems);
    lines.push(
      result.batch === null
        ? `Batch ${index}: malformed`
        : `Batch ${result.batch.batchId}: pack ${result.batch.policyPack.packId} and ${result.batch.policyInputs.length} negative policy input(s) pinned; ${Object.keys(result.batch.fixtures).length} fixture(s); ${result.problems.length === 0 ? 'pins verified' : `${result.problems.length} problem(s)`}`,
    );
  }
  const union = await checkUnion(batches, repoRoot, fs);
  problems.push(...union.problems);
  lines.push(`Union: ${union.batches.length} batch(es), ${union.fixtures.size} authored fixture(s); ${union.problems.length === 0 ? 'consistent and the suite inventory matches' : `${union.problems.length} problem(s)`}`);

  const suite = join(repoRoot, V2_SUITE_ROOT);
  const loader = { loaded: 0, rejected: 0, refused: 0 };
  const recipeAudit = { fixtures: 0, recipes: 0, outputs: 0, problems: 0 };
  const results: string[] = [];
  for (const fixture of [...union.fixtures.values()].sort((a, b) => (a.fixtureId < b.fixtureId ? -1 : 1))) {
    const label = `fixture ${fixture.fixtureId}`;
    const files = await auditFixtureFiles(repoRoot, fixture.fixtureId, fs);
    problems.push(...files.map((problem) => `${label} files: ${problem}`));

    const outcome = await loadFixture(suite, fixture.fixtureId, fs);
    loader[outcome.outcome] += 1;
    if (outcome.outcome === 'refused') {
      problems.push(...outcome.problems.map((problem) => `${label} loader: ${problem}`));
    }
    const oracleProblems = await contentFree(`fixtures/${fixture.fixtureId}`, () => oracleCheck(fixture, outcome, union.batches, repoRoot, fs), (problem) => [problem]);
    problems.push(...oracleProblems.map((problem) => `${label} oracle: ${problem}`));
    const loaderText =
      outcome.outcome === 'loaded'
        ? `loaded ${outcome.fixture.documents.length} document(s)`
        : outcome.outcome === 'rejected'
          ? `rejected at input_boundary (${outcome.rejection.reasons.map((reason) => reason.code).join(', ')})`
          : 'refused';
    results.push(`  ${fixture.fixtureId} (${fixture.batchId}): loader ${loaderText}; oracle ${oracleProblems.length === 0 ? 'structurally consistent' : `${oracleProblems.length} problem(s)`}`);

    const audit = await auditFixtureRecipes(suite, fixture.fixtureId, fs);
    if (audit.recipes > 0) {
      recipeAudit.fixtures += 1;
    }
    recipeAudit.recipes += audit.recipes;
    recipeAudit.outputs += audit.verified;
    recipeAudit.problems += audit.problems.length;
    problems.push(...audit.problems.map((problem) => `${label} recipe pin audit: ${problem}`));
  }
  lines.push(`Loader: ${union.fixtures.size} fixture(s): ${loader.loaded} loaded, ${loader.rejected} rejected at input_boundary, ${loader.refused} refused`, ...results);
  lines.push(
    `Recipe pin audit (separate from loader results): ${recipeAudit.recipes} recipe(s) in ${recipeAudit.fixtures} fixture(s), ${recipeAudit.outputs} pinned output(s) verified${recipeAudit.problems === 0 ? '' : `, ${recipeAudit.problems} problem(s)`}`,
  );
  if (problems.length > 0) {
    lines.push(`FAILED: ${problems.length} problem(s)`, ...problems.map((problem) => `  - ${problem}`));
  } else {
    lines.push('Passed: every check above holds.');
  }
  return { exitCode: problems.length === 0 ? 0 : 1, problems, report: lines.join('\n') };
}
