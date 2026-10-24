import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import {
  type AssessedState,
  Document,
  EVIDENCE_FIELD_SOURCES,
  EvidenceField,
  IntakeCase,
  PolicyPack,
  SourceDocumentBody,
  type StateEffect,
} from '@pa/contracts';

import { resolvePointer } from './json-pointer.js';
import { FixtureManifest, Oracle } from './schemas.js';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
export const FIXTURES_DIR = join(REPO_ROOT, 'evals', 'fixtures');
export const ORACLES_DIR = join(REPO_ROOT, 'evals', 'oracles');
export const POLICY_PACK_PATH = join(REPO_ROOT, 'policy-packs', 'lab-k0823-jd-20261018-v1.json');

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export interface FixtureDocument {
  meta: Document;
  /** Exact source bytes; `null` when access is restricted. */
  raw: Uint8Array | null;
  /** Parsed structured body; `null` unless the document is available and valid. */
  body: SourceDocumentBody | null;
}

export interface LoadedFixture {
  dir: string;
  manifest: FixtureManifest;
  manifestSha256: string;
  caseRecord: IntakeCase;
  documents: FixtureDocument[];
}

export interface FixtureCheck {
  fixture: LoadedFixture | undefined;
  problems: string[];
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

const issues = (error: { issues: { path: PropertyKey[]; message: string }[] }) =>
  error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ');

/**
 * Validates one fixture directory as exact bytes on disk: the manifest lists
 * every other file with its SHA-256, the case and document metadata parse, and
 * each document's content hash and structured body match its metadata.
 */
export async function checkFixture(dir: string): Promise<FixtureCheck> {
  const problems: string[] = [];
  const manifestBytes = await readFile(join(dir, 'manifest.json'));
  const manifest = FixtureManifest.safeParse(JSON.parse(manifestBytes.toString('utf8')));
  if (!manifest.success) {
    return { fixture: undefined, problems: [`manifest.json: ${issues(manifest.error)}`] };
  }

  const onDisk = (await listFiles(dir)).filter((path) => path !== 'manifest.json');
  const listed = manifest.data.files.map((file) => file.path);
  if (JSON.stringify(onDisk) !== JSON.stringify([...listed].sort()) || new Set(listed).size !== listed.length) {
    problems.push(`manifest lists [${listed.join(', ')}] but the fixture holds [${onDisk.join(', ')}]`);
  }
  const bytes = new Map<string, Uint8Array>();
  for (const path of onDisk) {
    bytes.set(path, await readFile(join(dir, path)));
  }
  for (const file of manifest.data.files) {
    const data = bytes.get(file.path);
    if (data !== undefined && sha256(data) !== file.sha256) {
      problems.push(`${file.path}: SHA-256 differs from the manifest`);
    }
  }

  const caseBytes = bytes.get('case.json');
  const parsedCase = IntakeCase.safeParse(caseBytes === undefined ? undefined : JSON.parse(Buffer.from(caseBytes).toString('utf8')));
  if (!parsedCase.success) {
    problems.push(`case.json: ${issues(parsedCase.error)}`);
  }

  const documents: FixtureDocument[] = [];
  const metaPaths = onDisk.filter((path) => path.endsWith('.meta.json'));
  const sourcePaths = new Set(onDisk.filter((path) => path.startsWith('documents/') && !path.endsWith('.meta.json')));
  for (const metaPath of metaPaths) {
    const meta = Document.safeParse(JSON.parse(Buffer.from(bytes.get(metaPath) ?? []).toString('utf8')));
    if (!meta.success) {
      problems.push(`${metaPath}: ${issues(meta.error)}`);
      continue;
    }
    const sourcePath = `documents/${meta.data.documentId}.v${meta.data.version}.json`;
    if (metaPath !== `documents/${meta.data.documentId}.v${meta.data.version}.meta.json`) {
      problems.push(`${metaPath}: file name does not match documentId and version`);
    }
    sourcePaths.delete(sourcePath);
    const raw = bytes.get(sourcePath) ?? null;
    let body: SourceDocumentBody | null = null;
    if (meta.data.accessStatus === 'restricted') {
      if (raw !== null) {
        problems.push(`${sourcePath}: a restricted document holds no bytes`);
      }
    } else if (raw === null) {
      problems.push(`${sourcePath}: source bytes missing`);
    } else {
      if (sha256(raw) !== meta.data.contentHash) {
        problems.push(`${sourcePath}: SHA-256 differs from contentHash in ${metaPath}`);
      } else if (meta.data.accessStatus === 'available') {
        const parsed = SourceDocumentBody.safeParse(JSON.parse(Buffer.from(raw).toString('utf8')));
        if (!parsed.success) {
          problems.push(`${sourcePath}: ${issues(parsed.error)}`);
        } else if (parsed.data.documentKind !== meta.data.kind) {
          problems.push(`${sourcePath}: body kind ${parsed.data.documentKind} differs from metadata kind ${meta.data.kind}`);
        } else {
          body = parsed.data;
        }
      }
    }
    documents.push({ meta: meta.data, raw, body });
  }
  for (const orphan of sourcePaths) {
    problems.push(`${orphan}: source bytes without metadata`);
  }
  const ids = documents.map((document) => document.meta.documentId);
  if (new Set(ids).size !== ids.length) {
    problems.push('document IDs are not unique');
  }

  const fixture = parsedCase.success
    ? { dir, manifest: manifest.data, manifestSha256: sha256(manifestBytes), caseRecord: parsedCase.data, documents }
    : undefined;
  return { fixture, problems };
}

const citationKey = (documentId: string, version: number, locator: string) => `${documentId}@v${version}${locator}`;

/** SPEC state precedence: a higher rank wins; `none` leaves the case ready for review. */
export const STATE_EFFECT_RANK: Record<StateEffect, number> = { none: 0, needs_information: 1, needs_human_review: 2, scope_hold: 3 };
const STATE_FOR_EFFECT: Record<StateEffect, AssessedState> = {
  none: 'ready_for_review',
  needs_information: 'needs_information',
  needs_human_review: 'needs_human_review',
  scope_hold: 'scope_hold',
};

// Pack convention C07: only these rules name affected documents, and only for these statuses.
const NAMES_DOCUMENTS: Record<string, readonly string[]> = {
  R01: ['restricted', 'unreadable'],
  R02: ['conflict'],
  R03: ['manual_review', 'restricted', 'unreadable'],
  R04: ['manual_review', 'restricted', 'unreadable'],
  R05: ['manual_review', 'restricted', 'unreadable'],
  R09: ['conflict', 'restricted', 'unreadable'],
};

/**
 * Checks an oracle against its fixture and the policy pack: frozen manifest and
 * pack hashes, one finding per pack rule, statuses and roles the rule declares,
 * an expected state equal to the highest state effect the pack gives the
 * oracle's own statuses, citations that resolve to non-null values in usable
 * documents, citation sets that follow convention C05 and affected documents
 * that follow C07, for the oracle's own quarantine list. It never derives a
 * status from fixture content.
 */
export function checkOracle(oracle: Oracle, fixture: LoadedFixture, pack: PolicyPack, packSha256: string): string[] {
  const problems: string[] = [];
  if (oracle.fixtureId !== fixture.manifest.fixtureId) {
    problems.push(`oracle names fixture ${oracle.fixtureId}, manifest says ${fixture.manifest.fixtureId}`);
  }
  if (oracle.fixtureManifestSha256 !== fixture.manifestSha256) {
    problems.push(`fixtureManifestSha256 ${oracle.fixtureManifestSha256} differs from manifest.json (${fixture.manifestSha256})`);
  }
  if (oracle.policyPackId !== pack.packId || fixture.caseRecord.policyPackId !== pack.packId) {
    problems.push('oracle, case and pack name different policy packs');
  }
  if (oracle.policyPackSha256 !== packSha256) {
    problems.push(`policyPackSha256 ${oracle.policyPackSha256} differs from the policy pack file (${packSha256})`);
  }
  if (oracle.specReferences.fixtureRow !== fixture.manifest.specFixtureRow) {
    problems.push('specReferences.fixtureRow differs from the manifest');
  }

  const documents = new Map(fixture.documents.map((document) => [document.meta.documentId, document]));
  for (const id of oracle.quarantinedDocumentIds) {
    if (!documents.has(id)) {
      problems.push(`quarantined document ${id} is not in the fixture`);
    }
  }
  const quarantined = new Set(oracle.quarantinedDocumentIds);
  // Usable (C05): not quarantined, available with a valid body, and of a MIME type the pack supports.
  const usable = (document: FixtureDocument) =>
    !quarantined.has(document.meta.documentId) && document.body !== null && pack.scope.documentMimeTypes.includes(document.meta.mimeType);

  const expectedRules = pack.rules.map((rule) => rule.ruleId).sort();
  const oracleRules = oracle.expectedFindings.map((finding) => finding.ruleId);
  if (JSON.stringify([...oracleRules].sort()) !== JSON.stringify(expectedRules)) {
    problems.push(`expected findings cover [${oracleRules.join(', ')}], the pack defines [${expectedRules.join(', ')}]`);
  }

  let highest: StateEffect = 'none';
  for (const finding of oracle.expectedFindings) {
    const rule = pack.rules.find((candidate) => candidate.ruleId === finding.ruleId);
    if (rule === undefined) {
      continue;
    }
    const outcome = rule.outcomes.find((candidate) => candidate.status === finding.status);
    if (outcome === undefined) {
      problems.push(`${finding.ruleId}: status ${finding.status} is not an outcome of the rule`);
    } else {
      if (outcome.responsibleRole !== finding.responsibleRole) {
        problems.push(`${finding.ruleId}: role ${finding.responsibleRole}, the pack assigns ${outcome.responsibleRole} to ${finding.status}`);
      }
      if (STATE_EFFECT_RANK[outcome.stateEffect] > STATE_EFFECT_RANK[highest]) {
        highest = outcome.stateEffect;
      }
    }

    // Convention C07: affected documents exist, are unique and are named only where the convention allows.
    const named = finding.affectedDocuments.map((ref) => `${ref.documentId}@v${ref.version}`);
    if (new Set(named).size !== named.length) {
      problems.push(`${finding.ruleId}: duplicate affected document`);
    }
    for (const ref of finding.affectedDocuments) {
      if (documents.get(ref.documentId)?.meta.version !== ref.version) {
        problems.push(`${finding.ruleId}: affected document ${ref.documentId}@v${ref.version} is not in the fixture`);
      }
      if (finding.ruleId !== 'R02' && quarantined.has(ref.documentId)) {
        problems.push(`${finding.ruleId}: names quarantined document ${ref.documentId}; only R02 does (C07)`);
      }
    }
    if (named.length > 0 && !(NAMES_DOCUMENTS[finding.ruleId] ?? []).includes(finding.status)) {
      problems.push(`${finding.ruleId}: a ${finding.status} finding names no documents (C07)`);
    }
    if (finding.ruleId === 'R02') {
      const expected = [...quarantined].sort();
      const actual = finding.affectedDocuments.map((ref) => ref.documentId).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        problems.push(`R02: affected documents [${actual.join(', ')}] differ from quarantinedDocumentIds [${expected.join(', ')}] (C07)`);
      }
      if ((finding.status === 'conflict') !== quarantined.size > 0) {
        problems.push(`R02: status ${finding.status} disagrees with ${quarantined.size} quarantined documents`);
      }
    }

    const cited = new Set<string>();
    for (const citation of finding.citations) {
      const key = citationKey(citation.documentId, citation.documentVersion, citation.locator);
      if (cited.has(key)) {
        problems.push(`${finding.ruleId}: duplicate citation ${key}`);
      }
      cited.add(key);
      const document = documents.get(citation.documentId);
      if (document === undefined || document.meta.version !== citation.documentVersion) {
        problems.push(`${finding.ruleId}: cites unknown document version ${key}`);
        continue;
      }
      if (quarantined.has(citation.documentId)) {
        problems.push(`${finding.ruleId}: cites quarantined document ${citation.documentId}`);
      } else if (!usable(document)) {
        problems.push(`${finding.ruleId}: cites unusable document ${citation.documentId}`);
      }
      const resolved = document.body === null ? { found: false as const } : resolvePointer(document.body, citation.locator);
      if (!resolved.found || resolved.value === null) {
        problems.push(`${finding.ruleId}: locator ${key} does not resolve to a value`);
      }
      const field = EvidenceField.options.find(
        (candidate) =>
          EVIDENCE_FIELD_SOURCES[candidate].documentKind === document.meta.kind && EVIDENCE_FIELD_SOURCES[candidate].pointer === citation.locator,
      );
      if (field === undefined || !rule.evidenceFields.includes(field)) {
        problems.push(`${finding.ruleId}: ${key} is not one of the rule's evidence fields`);
      }
    }

    // Convention C05: every non-null evidence-field value in a usable, non-quarantined document is cited.
    for (const document of fixture.documents) {
      if (!usable(document) || document.body === null) {
        continue;
      }
      for (const field of rule.evidenceFields) {
        const source = EVIDENCE_FIELD_SOURCES[field];
        const resolved = source.documentKind === document.meta.kind ? resolvePointer(document.body, source.pointer) : { found: false as const };
        const key = citationKey(document.meta.documentId, document.meta.version, source.pointer);
        if (resolved.found && resolved.value !== null && !cited.has(key)) {
          problems.push(`${finding.ruleId}: omits ${key} (${field}) required by convention C05`);
        }
      }
    }
  }
  if (oracle.expectedState !== STATE_FOR_EFFECT[highest]) {
    problems.push(`expectedState ${oracle.expectedState}, but the highest pack state effect of the expected statuses selects ${STATE_FOR_EFFECT[highest]}`);
  }
  return problems;
}

export async function loadPolicyPack(): Promise<{ pack: PolicyPack; sha256: string }> {
  const bytes = await readFile(POLICY_PACK_PATH);
  return { pack: PolicyPack.parse(JSON.parse(bytes.toString('utf8'))), sha256: sha256(bytes) };
}

export async function loadOracle(fixtureId: string): Promise<Oracle> {
  return Oracle.parse(JSON.parse(await readFile(join(ORACLES_DIR, `${fixtureId}.json`), 'utf8')));
}
