import { z } from 'zod';

// Shared value types for the SPEC domain records. Medical event dates are local
// calendar dates; receipt and audit timestamps are UTC. Nothing here supplies a
// default: an unknown value is an explicit `null` or `unknown` member.

/** Local calendar date (YYYY-MM-DD), validated for month length and leap years. */
export const IsoDate = z.iso.date();
export type IsoDate = z.infer<typeof IsoDate>;

/** Receipt or audit instant in UTC (`Z` designator only). */
export const UtcTimestamp = z.iso.datetime();
export type UtcTimestamp = z.infer<typeof UtcTimestamp>;

/** A local medical event instant with an explicit UTC offset. */
export const OffsetTimestamp = z.iso.datetime({ offset: true });
export type OffsetTimestamp = z.infer<typeof OffsetTimestamp>;

/** Lower-case hexadecimal SHA-256 digest of exact bytes. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lower-case hex SHA-256 digest');
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/** Opaque synthetic record identifier. */
export const Identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'must be 1-128 characters of A-Z, a-z, 0-9, ., _ or -, starting alphanumeric');
export type Identifier = z.infer<typeof Identifier>;

export const DocumentVersion = z.int().min(1);
export type DocumentVersion = z.infer<typeof DocumentVersion>;

export const CaseRevision = z.int().min(1);
export type CaseRevision = z.infer<typeof CaseRevision>;

/**
 * RFC 6901 JSON Pointer into a structured JSON source body. The whole-document
 * pointer `""` is not a locator: evidence always names a specific value.
 */
export const JsonPointer = z.string().regex(/^(\/([^~/]|~[01])*)+$/, 'must be a non-empty RFC 6901 JSON Pointer');
export type JsonPointer = z.infer<typeof JsonPointer>;

/** HCPCS-shaped item code. The application never infers one from free text. */
export const ItemCode = z.string().regex(/^[A-Z][0-9]{4}$/, 'must be a letter followed by four digits');
export type ItemCode = z.infer<typeof ItemCode>;

export const NonEmptyText = z.string().trim().min(1);
