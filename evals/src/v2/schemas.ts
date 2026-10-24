import {
  AssessedState,
  CanonicalText,
  ConditionField,
  ConditionKey,
  DocumentRef,
  DocumentVersion,
  EvidenceCitation,
  ExactText,
  FindingStatus,
  Identifier,
  InputRejection,
  JsonPointer,
  RejectionReason,
  RejectionStage,
  ResponsibleRole,
  RuleId,
  Sha256Hex,
  SourceRefId,
} from '@pa/contracts';
import { z } from 'zod';

// Evaluator-owned v2 formats, as specified in docs/policy-slice.md
// ("Oracle format `pa.oracle.v3`", "Manifest format `pa.fixture-manifest.v2`",
// "Recipe grammar" and "Batch extension interface"). Every object is strict and
// nothing is transformed: duplicates and unknown fields are refused, never
// dropped or normalized. Runtime code never reads these files.

export const V2_SUITE_ROOT = 'evals/suites/policy-v2';
export const MANIFEST_FORMAT = 'pa.fixture-manifest.v2';
export const ORACLE_FORMAT = 'pa.oracle.v3';

/** Input boundary limits (SPEC "Failure, privacy, and recovery"; D6 F26 conventions). */
export const MAX_DOCUMENTS = 50;
export const MAX_PAYLOAD_BYTES = 1_048_576;

/** Recipe resource bounds ("Recipe grammar"); separate from the input limits above. */
export const MAX_RECIPE_COUNT = 64;
export const MAX_TARGET_BYTES = 2_097_152;
export const MAX_GENERATED_BYTES = 4_194_304;
export const MAX_FILL_CHARACTERS = 8;

export const SLOT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Slot name rule N3: a slot name never ends in `.meta` or `.template`, so file names classify unambiguously. */
export const isReservedSlot = (slot: string) => slot.endsWith('.meta') || slot.endsWith('.template');

const unique = (values: readonly string[]) => new Set(values).size === values.length;
const refKey = (ref: DocumentRef) => `${ref.documentId}@v${ref.version}`;

/** An array whose entries must be distinct under `key`; a duplicate is refused, never dropped. */
const distinct = <T extends z.ZodType>(item: T, key: (value: z.infer<T>) => string, what: string) =>
  z.array(item).superRefine((values, context) => {
    if (!unique(values.map(key))) {
      context.addIssue({ code: 'custom', message: `duplicate ${what}` });
    }
  });

/** A fixture ID is a single safe path segment; the naming convention is not enforced. */
export const FixtureIdV2 = Identifier;

const SpecRow = z.string().regex(/^F[0-9]{2}$/, 'must be a SPEC fixture row such as F03');

/** Repository-relative POSIX path of safe segments: no `.`, `..`, empty or absolute segment. */
export const RepoPath = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/, 'must be a relative path of safe segments');

export const Slot = z.string().regex(SLOT_PATTERN, 'must be a slot name');

/** A file under `documents/`: a payload `<slot>.json`, a sidecar `<slot>.meta.json` or a template `<name>.template.json`. */
export const DocumentPath = z.string().regex(/^documents\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/, 'must be documents/<name>.json');

export const ManifestFile = z.strictObject({
  path: z.string().regex(/^(case\.json|documents\/[A-Za-z0-9][A-Za-z0-9._-]*\.json)$/, 'must be case.json or documents/<name>.json'),
  sha256: Sha256Hex,
});
export type ManifestFile = z.infer<typeof ManifestFile>;

export const PathAttempt = z.strictObject({
  slot: Slot,
  /** Inert test data: never opened. */
  path: z.string().min(1),
});
export type PathAttempt = z.infer<typeof PathAttempt>;

const RecipeText = z
  .string()
  .min(1)
  .refine((value) => value.isWellFormed(), { message: 'must be well-formed Unicode' });

/** 1 to 8 Unicode scalar values, with no quote, backslash or control (`Cc`) character, encodable as UTF-8. */
export const Fill = z.string().superRefine((value, context) => {
  if (!value.isWellFormed()) {
    context.addIssue({ code: 'custom', message: 'fill must be well-formed Unicode (no lone surrogate)' });
    return;
  }
  const characters = [...value].length;
  if (characters < 1 || characters > MAX_FILL_CHARACTERS) {
    context.addIssue({ code: 'custom', message: `fill must be 1 to ${MAX_FILL_CHARACTERS} characters` });
  }
  if (/["\\\p{Cc}]/u.test(value)) {
    context.addIssue({ code: 'custom', message: 'fill must not contain a quote, backslash or control character' });
  }
});

export const PadRecipe = z.strictObject({
  recipe: z.literal('pad'),
  template: DocumentPath,
  placeholder: RecipeText,
  fill: Fill,
  targetBytes: z.int().min(1).max(MAX_TARGET_BYTES),
  output: DocumentPath,
  sha256: Sha256Hex,
});
export type PadRecipe = z.infer<typeof PadRecipe>;

export const ReplicateRecipe = z
  .strictObject({
    recipe: z.literal('replicate'),
    payload: DocumentPath,
    metadataTemplate: DocumentPath,
    placeholder: RecipeText,
    count: z.int().min(1).max(MAX_RECIPE_COUNT),
    /** Minimum zero-padding width; bounded only by the output, ID and byte-budget rules. */
    width: z.int().min(1),
    outputs: z.array(z.strictObject({ slot: Slot, metadataSha256: Sha256Hex })),
  })
  .superRefine((value, context) => {
    if (value.outputs.length !== value.count) {
      context.addIssue({ code: 'custom', path: ['outputs'], message: 'outputs must pin exactly count copies' });
    }
    if (!unique(value.outputs.map((output) => output.slot))) {
      context.addIssue({ code: 'custom', path: ['outputs'], message: 'duplicate output slot' });
    }
  });
export type ReplicateRecipe = z.infer<typeof ReplicateRecipe>;

export const Recipe = z.discriminatedUnion('recipe', [PadRecipe, ReplicateRecipe]);
export type Recipe = z.infer<typeof Recipe>;

export const FixtureManifestV2 = z
  .strictObject({
    schemaVersion: z.literal(MANIFEST_FORMAT),
    fixtureId: FixtureIdV2,
    specFixtureRow: SpecRow,
    title: ExactText,
    scenario: ExactText,
    syntheticProvenance: ExactText,
    /** The explicit assessment argument, verbatim; its validity is the domain's schema stage. */
    assessmentDate: z.string(),
    policyInput: z.strictObject({ path: RepoPath, sha256: Sha256Hex }),
    coverage: distinct(CanonicalText, (entry) => entry, 'coverage entry'),
    files: distinct(ManifestFile, (file) => file.path, 'manifest path'),
    pathAttempts: distinct(PathAttempt, (attempt) => attempt.slot, 'path attempt slot').optional(),
    recipes: z.array(Recipe).optional(),
  })
  .superRefine((value, context) => {
    if (!value.files.some((file) => file.path === 'case.json')) {
      context.addIssue({ code: 'custom', path: ['files'], message: 'files must list case.json' });
    }
  });
export type FixtureManifestV2 = z.infer<typeof FixtureManifestV2>;

export const ExpectedConditionV3 = z.strictObject({
  conditionKey: ConditionKey,
  field: ConditionField.nullable(),
  /** The contract's `FindingCondition.documentRefs`. */
  documents: z.array(DocumentRef),
});
export type ExpectedConditionV3 = z.infer<typeof ExpectedConditionV3>;

export const ExpectedFindingV3 = z.strictObject({
  ruleId: RuleId,
  status: FindingStatus,
  responsibleRole: ResponsibleRole,
  /** The contract's `FindingV3.documentRefs` (C07). */
  affectedDocuments: z.array(DocumentRef),
  citations: z.array(EvidenceCitation),
  conditions: z.array(ExpectedConditionV3),
});
export type ExpectedFindingV3 = z.infer<typeof ExpectedFindingV3>;

export const ExactTextExpectation = z.strictObject({
  documentId: Identifier,
  documentVersion: DocumentVersion,
  locator: JsonPointer,
  originalText: ExactText,
});
export type ExactTextExpectation = z.infer<typeof ExactTextExpectation>;

/** Behavior the vector does not prove; never compared and never counted as passed. */
export const DeferredExpectation = z.strictObject({
  stage: CanonicalText,
  statement: ExactText,
});

export const AssessedExpectation = z.strictObject({
  outcome: z.literal('assessed'),
  state: AssessedState,
  findings: z.array(ExpectedFindingV3),
  quarantinedDocuments: distinct(DocumentRef, refKey, 'quarantined document'),
  supersededDocuments: distinct(DocumentRef, refKey, 'superseded document'),
  clinicalReviewRequired: z.boolean(),
  exactText: z.array(ExactTextExpectation).optional(),
  deferredExpectations: z.array(DeferredExpectation).optional(),
});
export type AssessedExpectation = z.infer<typeof AssessedExpectation>;

/** Only the frozen rejection: its stage and reasons in the exact `pa.input-rejection.v1` shapes and order. */
export const RejectedExpectation = z
  .strictObject({
    outcome: z.literal('rejected'),
    stage: RejectionStage,
    reasons: z.array(RejectionReason),
  })
  .superRefine((value, context) => {
    const parsed = InputRejection.safeParse({ schemaVersion: 'pa.input-rejection.v1', stage: value.stage, reasons: value.reasons });
    for (const issue of parsed.error?.issues ?? []) {
      context.addIssue({ code: 'custom', path: issue.path.filter((segment) => segment !== 'schemaVersion'), message: issue.message });
    }
  });
export type RejectedExpectation = z.infer<typeof RejectedExpectation>;

export const OracleV3 = z.strictObject({
  schemaVersion: z.literal(ORACLE_FORMAT),
  fixtureId: FixtureIdV2,
  fixtureManifestSha256: Sha256Hex,
  policyInput: z.strictObject({ packId: Identifier, sha256: Sha256Hex }),
  specReferences: z.strictObject({
    fixtureRow: SpecRow,
    rules: distinct(RuleId, (rule) => rule, 'rule').min(1),
    sections: distinct(ExactText, (section) => section, 'section').min(1),
    decisions: distinct(z.string().regex(/^D[1-6]$/, 'must be a decision D1 to D6'), (decision) => decision, 'decision'),
    conventions: distinct(z.string().regex(/^C0[1-9]$/, 'must be a lab convention C01 to C09'), (convention) => convention, 'convention'),
    sources: distinct(SourceRefId, (source) => source, 'source'),
  }),
  authoringNote: ExactText,
  expectation: z.discriminatedUnion('outcome', [AssessedExpectation, RejectedExpectation]),
});
export type OracleV3 = z.infer<typeof OracleV3>;

export const PolicyPin = z.strictObject({ packId: Identifier, path: RepoPath, sha256: Sha256Hex });
export type PolicyPin = z.infer<typeof PolicyPin>;

/** `FrozenBatch` ("Batch extension interface"): hash data only, one shared root and exact format versions. */
export const FrozenBatchSchema = z
  .strictObject({
    batchId: Identifier,
    root: z.literal(V2_SUITE_ROOT),
    formatVersions: z.strictObject({ manifest: z.literal(MANIFEST_FORMAT), oracle: z.literal(ORACLE_FORMAT) }),
    policyPack: PolicyPin,
    policyInputs: z.array(PolicyPin),
    fixtures: z.record(FixtureIdV2, z.strictObject({ manifestSha256: Sha256Hex, oracleSha256: Sha256Hex })),
  })
  .superRefine((value, context) => {
    if (!value.policyPack.path.startsWith('policy-packs/')) {
      context.addIssue({ code: 'custom', path: ['policyPack', 'path'], message: 'the reviewed pack lives under policy-packs/' });
    }
    value.policyInputs.forEach((input, index) => {
      if (!input.path.startsWith(`${V2_SUITE_ROOT}/policy-inputs/`)) {
        context.addIssue({ code: 'custom', path: ['policyInputs', index, 'path'], message: `negative inputs live under ${V2_SUITE_ROOT}/policy-inputs/` });
      }
    });
    if (!unique(value.policyInputs.map((input) => input.path)) || !unique(value.policyInputs.map((input) => input.packId))) {
      context.addIssue({ code: 'custom', path: ['policyInputs'], message: 'duplicate policy input' });
    }
  });
export type FrozenBatch = z.infer<typeof FrozenBatchSchema>;
