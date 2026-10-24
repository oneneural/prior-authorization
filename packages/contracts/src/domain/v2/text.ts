import { z } from 'zod';

// Non-transforming text validators (decision D1). The legacy
// `NonEmptyText` trims on parse; these accept or reject a string but always
// return it unchanged, so a parsed record is byte-identical to its source.
// Reasons never quote the rejected value.

const hasVisibleText = (value: string) => value.trim().length > 0;

/**
 * Text with at least one non-whitespace character, returned exactly as given
 * (surrounding whitespace preserved). Replaces `NonEmptyText` wherever the
 * legacy field required nonblank text. Whitespace is `String.prototype.trim`'s
 * definition, so the accepted set equals the legacy trim-then-nonempty set.
 */
export const ExactText = z.string().refine(hasVisibleText, { message: 'must contain a non-whitespace character' });
export type ExactText = z.infer<typeof ExactText>;

/** `ExactText` that also has no surrounding whitespace: for case identity and reviewed pack text. */
export const CanonicalText = ExactText.refine((value) => value === value.trim(), { message: 'must not have surrounding whitespace' });
export type CanonicalText = z.infer<typeof CanonicalText>;
