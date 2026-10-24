import { AssessedState, DocumentRef, EvidenceCitation, FindingStatus, Identifier, NonEmptyText, ResponsibleRole, RuleId, Sha256Hex } from '@pa/contracts';
import { z } from 'zod';

// Evaluator-owned formats. Runtime code never reads these files (lint and the
// path reference test in independence.test.ts enforce it).

export const FixtureId = z.string().regex(/^F[0-9]{2}[a-z]?$/, 'must be a SPEC fixture ID with an optional variant letter');

export const FixtureManifest = z.strictObject({
  schemaVersion: z.literal('pa.fixture-manifest.v1'),
  fixtureId: FixtureId,
  specFixtureRow: z.string().regex(/^F[0-9]{2}$/),
  title: NonEmptyText,
  scenario: NonEmptyText,
  syntheticProvenance: NonEmptyText,
  files: z
    .array(
      z.strictObject({
        path: z.string().regex(/^(case\.json|documents\/[A-Za-z0-9][A-Za-z0-9._-]*\.v[1-9][0-9]*(\.meta)?\.json)$/),
        sha256: Sha256Hex,
      }),
    )
    .min(1),
});
export type FixtureManifest = z.infer<typeof FixtureManifest>;

/**
 * Expected finding: compared as a complete set, citations by source location
 * only. `affectedDocuments` matches `Finding.documentRefs` (pack convention C07).
 */
export const ExpectedFinding = z.strictObject({
  ruleId: RuleId,
  status: FindingStatus,
  responsibleRole: ResponsibleRole,
  affectedDocuments: z.array(DocumentRef),
  citations: z.array(EvidenceCitation),
});
export type ExpectedFinding = z.infer<typeof ExpectedFinding>;

export const Oracle = z.strictObject({
  schemaVersion: z.literal('pa.oracle.v2'),
  fixtureId: FixtureId,
  fixtureManifestSha256: Sha256Hex,
  policyPackId: Identifier,
  // The oracle depends on the pack's outcome conditions, so it pins the exact pack bytes.
  policyPackSha256: Sha256Hex,
  expectedState: AssessedState,
  expectedFindings: z.array(ExpectedFinding).min(1),
  quarantinedDocumentIds: z.array(Identifier),
  clinicalReviewRequired: z.literal(true),
  specReferences: z.strictObject({
    fixtureRow: z.string().regex(/^F[0-9]{2}$/),
    rules: z.array(RuleId).min(1),
    sections: z.array(NonEmptyText).min(1),
    slicePlanDecisions: z.array(z.int().min(1).max(4)),
    sources: z.array(z.string().regex(/^S[0-9]{2}$/)),
  }),
  authoringNote: NonEmptyText,
});
export type Oracle = z.infer<typeof Oracle>;
