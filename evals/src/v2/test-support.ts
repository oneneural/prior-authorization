import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CORE_BATCH } from '../frozen-v2.js';
import { type FileSystem, nodeFileSystem, REPO_ROOT } from './files.js';
import { V2_SUITE_ROOT } from './schemas.js';

// Support for the v2 structural tests. Every input here is original
// synthetic data built in code and written only to the system temporary
// directory; no frozen repository byte is ever changed. Digests are computed
// with node:crypto directly, independently of the implementation's helper.

export type Bytes = string | Uint8Array;

export const digest = (bytes: Bytes) => createHash('sha256').update(bytes).digest('hex');
export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const temporary: string[] = [];

/** A new canonical temporary directory, removed by `removeTempDirs`. */
export async function makeTempDir(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'pa-v2-')));
  temporary.push(path);
  return path;
}

export async function removeTempDirs(): Promise<void> {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}

export async function writeTree(root: string, files: Readonly<Record<string, Bytes>>): Promise<void> {
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
}

export interface Call {
  op: 'lstat' | 'realpath' | 'readFile' | 'readdir';
  path: string;
}

/** A file system that records every call before delegating to the real one. */
export function recordingFs(base: FileSystem = nodeFileSystem): { fs: FileSystem; calls: Call[] } {
  const calls: Call[] = [];
  const record = <T>(op: Call['op'], path: string, run: () => Promise<T>) => {
    calls.push({ op, path });
    return run();
  };
  return {
    calls,
    fs: {
      lstat: (path) => record('lstat', path, () => base.lstat(path)),
      realpath: (path) => record('realpath', path, () => base.realpath(path)),
      readFile: (path) => record('readFile', path, () => base.readFile(path)),
      readdir: (path) => record('readdir', path, () => base.readdir(path)),
    },
  };
}

export const SUBJECT_ID = 'SYN-BEN-V2';
export const SUBJECT_NAME = 'Robin Structural';
const PROVENANCE = { origin: 'authored_synthetic', statement: 'Original synthetic test input built in code for the structural tests.' };

export const caseRecord = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 'pa.case.v2',
  caseId: 'case-v2',
  revision: 1,
  synthetic: true,
  subjectId: SUBJECT_ID,
  subjectName: SUBJECT_NAME,
  assessmentDate: '2026-10-18',
  payerType: 'medicare_ffs',
  payerPrimary: true,
  beneficiaryState: 'CA',
  jurisdiction: 'noridian_jd',
  itemCode: 'K0823',
  requestKind: 'initial',
  urgency: 'standard',
  accessories: [],
  alreadyDelivered: false,
  lcmpIncorporated: false,
  supplierId: 'SYN-SUP-V2',
  supplierStatus: {
    schemaVersion: 'pa.supplier-status.v1',
    status: 'non_exempt',
    established: true,
    newEnrollment: false,
    ownershipChange: false,
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    evidenceId: 't-supplier',
  },
  supplierStatusEvidenceId: 't-supplier',
  policyPackId: CORE_BATCH.policyPack.packId,
  state: 'intake',
  ...overrides,
});

const person = { name: SUBJECT_NAME, identifier: SUBJECT_ID };
const practitioner = { name: 'Morgan Fictional, MD (synthetic)', identifier: 'SYN-PRAC-V2' };

export const orderBody = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 'pa.source.order.v1',
  documentKind: 'order',
  synthetic: true,
  status: 'final',
  beneficiary: person,
  orderDate: '2026-09-02',
  orderTime: null,
  item: { description: 'Power wheelchair, standard base, for a synthetic structural test', code: 'K0823', quantity: 1 },
  treatingPractitioner: practitioner,
  signature: { signerName: practitioner.name, signedDate: '2026-09-02' },
  ...overrides,
});

export const encounterBody = () => ({
  schemaVersion: 'pa.source.encounter.v1',
  documentKind: 'encounter',
  synthetic: true,
  status: 'final',
  beneficiary: person,
  encounterDate: '2026-08-20',
  completionTime: null,
  practitioner,
  lcmpReport: { incorporated: false, evaluationDate: null },
  clinical: {
    diagnosisStatement: 'Synthetic structural test text only.',
    mobilityLimitation: null,
    lowerLevelDevices: null,
    homeAccessibility: null,
    abilityToOperate: null,
  },
  narrative: 'SYNTHETIC TEST DOCUMENT; not a medical record.',
});

export const receiptBody = (orderVersion: number) => ({
  schemaVersion: 'pa.source.order-receipt.v1',
  documentKind: 'order_receipt',
  synthetic: true,
  beneficiary: person,
  orderReference: { documentId: 't-order', version: orderVersion },
  receivedAt: '2026-09-03T17:05:00Z',
  recordedByRole: 'supplier intake coordinator (fictional)',
});

export const supplierBody = () => ({
  schemaVersion: 'pa.source.supplier-status.v1',
  documentKind: 'supplier_status',
  synthetic: true,
  supplierId: 'SYN-SUP-V2',
  status: 'non_exempt',
  established: true,
  newEnrollment: false,
  ownershipChange: false,
  effectiveFrom: '2026-01-01',
  effectiveTo: '2026-12-31',
});

export const noteBody = (text = 'Synthetic note text.') => ({
  schemaVersion: 'pa.source.supporting-note.v1',
  documentKind: 'supporting_note',
  synthetic: true,
  beneficiary: person,
  authoredDate: '2026-09-01',
  title: 'Synthetic note',
  text,
});

const SOURCE_SYSTEM: Record<string, string> = { supplier_status: 'supplier_compliance', order_receipt: 'supplier_intake' };

/** `pa.document.v1` metadata for a payload; `null` makes the slot restricted. */
export const metadata = (documentId: string, version: number, kind: string, payload: Bytes | null, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 'pa.document.v1',
  documentId,
  version,
  subjectId: kind === 'supplier_status' ? null : SUBJECT_ID,
  kind,
  contentHash: payload === null ? null : digest(payload),
  mimeType: 'application/json',
  sourceSystem: SOURCE_SYSTEM[kind] ?? 'practitioner_record',
  receivedAt: '2026-10-17T15:00:00Z',
  authoredAt: '2026-09-02',
  supersedes: null,
  syntheticProvenance: PROVENANCE,
  accessStatus: payload === null ? 'restricted' : 'available',
  ...overrides,
});

export interface DocumentSpec {
  /** A metadata object, or raw sidecar text; omitted for an orphan payload. */
  meta?: unknown;
  payload?: Bytes;
}

export interface FixtureSpec {
  fixtureId: string;
  specFixtureRow?: string;
  caseJson?: Bytes;
  documents?: Readonly<Record<string, DocumentSpec>>;
  /** Further listed files under the fixture directory, such as templates. */
  extraFiles?: Readonly<Record<string, Bytes>>;
  /** Fields merged over the generated manifest. */
  manifest?: Readonly<Record<string, unknown>>;
}

/** The files of one fixture directory (manifest included) and its manifest text. */
export function fixtureFiles(spec: FixtureSpec): { files: Record<string, Bytes>; manifestText: string } {
  const files: Record<string, Bytes> = { 'case.json': spec.caseJson ?? json(caseRecord()) };
  for (const [slot, document] of Object.entries(spec.documents ?? {})) {
    if (document.meta !== undefined) {
      files[`documents/${slot}.meta.json`] = typeof document.meta === 'string' ? document.meta : json(document.meta);
    }
    if (document.payload !== undefined) {
      files[`documents/${slot}.json`] = document.payload;
    }
  }
  Object.assign(files, spec.extraFiles ?? {});
  const manifest = {
    schemaVersion: 'pa.fixture-manifest.v2',
    fixtureId: spec.fixtureId,
    specFixtureRow: spec.specFixtureRow ?? 'F01',
    title: 'Synthetic structural test fixture',
    scenario: 'Original synthetic scenario for a structural test.',
    syntheticProvenance: 'Original synthetic fixture built in code; no real record.',
    assessmentDate: '2026-10-18',
    policyInput: { path: CORE_BATCH.policyPack.path, sha256: CORE_BATCH.policyPack.sha256 },
    coverage: [spec.specFixtureRow ?? 'F01'],
    files: Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, bytes]) => ({ path, sha256: digest(bytes) })),
    ...spec.manifest,
  };
  const manifestText = json(manifest);
  return { files: { ...files, 'manifest.json': manifestText }, manifestText };
}

/** Writes one fixture under `<suiteRoot>/fixtures/<id>/` and returns its manifest text. */
export async function writeFixture(suiteRoot: string, spec: FixtureSpec): Promise<string> {
  const { files, manifestText } = fixtureFiles(spec);
  await writeTree(join(suiteRoot, 'fixtures', spec.fixtureId), files);
  return manifestText;
}

/** A repository copy for batch tests: the real pinned pack and negative input bytes, copied unchanged. */
export async function makeRepoCopy(): Promise<string> {
  const root = await makeTempDir();
  for (const path of [CORE_BATCH.policyPack.path, ...CORE_BATCH.policyInputs.map((input) => input.path)]) {
    await writeTree(root, { [path]: await readFile(join(REPO_ROOT, path)) });
  }
  return root;
}

/** Copies the real suite and every pinned policy file of `batches` into a new repository copy. */
export async function copyRealSuite(batches: readonly { policyPack: { path: string }; policyInputs: readonly { path: string }[] }[]): Promise<string> {
  const root = await makeTempDir();
  await cp(join(REPO_ROOT, V2_SUITE_ROOT), join(root, V2_SUITE_ROOT), { recursive: true, verbatimSymlinks: true });
  for (const path of new Set(batches.flatMap((batch) => [batch.policyPack.path, ...batch.policyInputs.map((input) => input.path)]))) {
    await writeTree(root, { [path]: await readFile(join(REPO_ROOT, path)) });
  }
  return root;
}

/** A batch table over the core pins, with its own ID and fixture pins. */
export const batchOf = (batchId: string, fixtures: Record<string, { manifestSha256: string; oracleSha256: string }>, overrides: Record<string, unknown> = {}) => ({
  ...CORE_BATCH,
  policyInputs: [...CORE_BATCH.policyInputs],
  batchId,
  fixtures,
  ...overrides,
});

/** Writes a fixture and its oracle into a repository copy and returns the batch pin. */
export async function addPinnedFixture(repoRoot: string, spec: FixtureSpec, oracle: (manifestSha256: string) => unknown): Promise<{ manifestSha256: string; oracleSha256: string }> {
  const suite = join(repoRoot, V2_SUITE_ROOT);
  const manifestText = await writeFixture(suite, spec);
  const manifestSha256 = digest(manifestText);
  const oracleValue = oracle(manifestSha256);
  const oracleText = typeof oracleValue === 'string' ? oracleValue : json(oracleValue);
  await writeTree(suite, { [`oracles/${spec.fixtureId}.json`]: oracleText });
  return { manifestSha256, oracleSha256: digest(oracleText) };
}

// A small standard fixture and its hand-written oracle. The expected findings
// are declared by the test author from the frozen formats and pack routing to
// exercise the structural checks; they are not gold expectations.

const quantityAsWritten = (text: string) => text.replace('"quantity": 1\n', '"quantity": 1.0\n');

export function standardDocuments(): Record<string, DocumentSpec> {
  const orderV1 = json(orderBody());
  const orderV2 = quantityAsWritten(json(orderBody()));
  const encounter = json(encounterBody());
  const receipt = json(receiptBody(2));
  const supplier = json(supplierBody());
  const note = json(noteBody());
  return {
    't-order.v1': { meta: metadata('t-order', 1, 'order', orderV1), payload: orderV1 },
    't-order.v2': { meta: metadata('t-order', 2, 'order', orderV2, { supersedes: { documentId: 't-order', version: 1 } }), payload: orderV2 },
    't-encounter.v1': { meta: metadata('t-encounter', 1, 'encounter', encounter), payload: encounter },
    't-receipt.v1': { meta: metadata('t-receipt', 1, 'order_receipt', receipt), payload: receipt },
    't-supplier.v1': { meta: metadata('t-supplier', 1, 'supplier_status', supplier), payload: supplier },
    't-note.v1': { meta: metadata('t-note', 1, 'supporting_note', note, { subjectId: 'SYN-BEN-OTHER' }), payload: note },
  };
}

const ref = (documentId: string, version: number) => ({ documentId, version });
const cite = (documentId: string, documentVersion: number, locator: string) => ({ documentId, documentVersion, locator });
const pass = (ruleId: string, citations: unknown[] = []) => ({ ruleId, status: 'pass', responsibleRole: 'administrative_reviewer', affectedDocuments: [], citations, conditions: [] });

export function standardOracle(fixtureId: string, manifestSha256: string) {
  return {
    schemaVersion: 'pa.oracle.v3',
    fixtureId,
    fixtureManifestSha256: manifestSha256,
    policyInput: { packId: CORE_BATCH.policyPack.packId, sha256: CORE_BATCH.policyPack.sha256 },
    specReferences: { fixtureRow: 'F01', rules: ['R02', 'R06'], sections: ['Critical fixture suite'], decisions: ['D2', 'D3'], conventions: ['C05', 'C07'], sources: ['S08'] },
    authoringNote: 'Synthetic structural test oracle declared by the test author; not a gold expectation.',
    expectation: {
      outcome: 'assessed',
      state: 'needs_human_review',
      findings: [
        pass('R01', [cite('t-supplier', 1, '/supplierId')]),
        {
          ruleId: 'R02',
          status: 'conflict',
          responsibleRole: 'administrative_reviewer',
          affectedDocuments: [ref('t-note', 1)],
          citations: [],
          conditions: [{ conditionKey: 'R02.document_quarantined', field: 'binding.metadata_subject', documents: [ref('t-note', 1)] }],
        },
        pass('R03', [cite('t-order', 2, '/orderDate'), cite('t-order', 2, '/item/quantity')]),
        pass('R04', [cite('t-encounter', 1, '/encounterDate'), cite('t-order', 2, '/orderDate')]),
        pass('R05', [cite('t-receipt', 1, '/receivedAt')]),
        {
          ruleId: 'R06',
          status: 'manual_review',
          responsibleRole: 'qualified_clinical_reviewer',
          affectedDocuments: [],
          citations: [cite('t-encounter', 1, '/clinical/diagnosisStatement')],
          conditions: [{ conditionKey: 'R06.clinical_review', field: null, documents: [] }],
        },
        pass('R07'),
        pass('R08'),
        pass('R09'),
        {
          ruleId: 'R10',
          status: 'not_applicable',
          responsibleRole: 'administrative_reviewer',
          affectedDocuments: [],
          citations: [],
          conditions: [{ conditionKey: 'R10.pure_assessment', field: null, documents: [] }],
        },
      ],
      quarantinedDocuments: [ref('t-note', 1)],
      supersededDocuments: [ref('t-order', 1)],
      clinicalReviewRequired: true,
      exactText: [{ documentId: 't-order', documentVersion: 2, locator: '/item/quantity', originalText: '1.0' }],
      deferredExpectations: [{ stage: 'S4', statement: 'Arrival-order recovery is not exercised by this snapshot.' }],
    },
  };
}
