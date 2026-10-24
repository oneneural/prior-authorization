import { z } from 'zod';

import { DocumentVersion, Identifier, JsonPointer } from '../common.js';
import { EVIDENCE_FIELD_SOURCES, EvidenceField, ExtractionMethod, FactReviewStatus } from '../evidence.js';
import { ExactText } from './text.js';

/** RFC 8259 number token, as it may appear in a structured JSON source. */
const JSON_NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

/**
 * `pa.evidence-fact.v2`: `originalText` is the source text at the locator
 * exactly as written, never trimmed (D1). For a string value it equals the
 * value; for a number it is the JSON token as written (`1.0` stays `1.0` while
 * `value` is the number 1); for a boolean it is `true` or `false`. Every other
 * field and invariant is unchanged from `pa.evidence-fact.v1`.
 */
export const EvidenceFactV2 = z
  .strictObject({
    schemaVersion: z.literal('pa.evidence-fact.v2'),
    factId: Identifier,
    field: EvidenceField,
    value: z.union([z.string(), z.number(), z.boolean()]),
    documentId: Identifier,
    documentVersion: DocumentVersion,
    locator: JsonPointer,
    originalText: ExactText,
    extractionMethod: ExtractionMethod,
    confidence: z.number().min(0).max(1).nullable(),
    reviewStatus: FactReviewStatus,
  })
  .superRefine((value, context) => {
    if ((value.extractionMethod === 'model') !== (value.confidence !== null)) {
      context.addIssue({ code: 'custom', path: ['confidence'], message: 'confidence is stated exactly for model extraction' });
    }
    if (value.locator !== EVIDENCE_FIELD_SOURCES[value.field].pointer) {
      context.addIssue({ code: 'custom', path: ['locator'], message: `locator for ${value.field} must be ${EVIDENCE_FIELD_SOURCES[value.field].pointer}` });
    }
    const text = value.originalText;
    const consistent =
      typeof value.value === 'string'
        ? text === value.value
        : typeof value.value === 'number'
          ? JSON_NUMBER.test(text) && Number(text) === value.value
          : text === String(value.value);
    if (!consistent) {
      context.addIssue({ code: 'custom', path: ['originalText'], message: 'originalText must be the exact source text of value' });
    }
  });
export type EvidenceFactV2 = z.infer<typeof EvidenceFactV2>;
