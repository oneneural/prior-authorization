import type { ProviderUsage } from '@pa/contracts';

/**
 * Exact money for spend admission: integer units of USD 0.0000001. The frozen
 * per-token tariff is an integer number of units, so reservations, actuals and
 * totals never touch binary floating point.
 */
export const UNITS_PER_USD = 10_000_000;

export class InvalidAmount extends Error {
  override name = 'InvalidAmount';
}

/** Parses a non-negative decimal USD string with at most seven fractional digits. */
export function usdToUnits(text: string): number {
  const match = /^(\d{1,9})(?:\.(\d{1,7}))?$/.exec(text);
  if (match === null) throw new InvalidAmount('amount must be a decimal with at most seven fractional digits');
  const units = Number(match[1]) * UNITS_PER_USD + Number((match[2] ?? '').padEnd(7, '0'));
  if (!Number.isSafeInteger(units)) throw new InvalidAmount('amount is out of range');
  return units;
}

/** Display-only conversion; accounting never converts back. */
export const unitsToUsd = (units: number) => units / UNITS_PER_USD;

export function formatUnits(units: number): string {
  const whole = Math.floor(units / UNITS_PER_USD);
  return `${whole}.${String(units - whole * UNITS_PER_USD).padStart(7, '0')}`;
}

/**
 * Claude Opus 5.5 standard global prices from
 * https://platform.claude.com/docs/en/about-claude/pricing, read on 2026-10-21
 * and rechecked 2026-10-22 for ADR 0001: input $4, 5-minute cache write $5,
 * cache hit $0.20 and output $20 per million tokens. One-hour cache writes,
 * server tools and other surcharged classes are refused rather than priced.
 */
export const OPUS_5_5_TARIFF = {
  model: 'claude-opus-5-5',
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  readOn: '2026-10-21',
  unitsPerToken: { input: 40, cacheWrite5m: 50, cacheRead: 2, output: 200 },
  contextWindowTokens: 1_000_000,
  maxOutputTokens: 8192,
} as const;
export type Tariff = typeof OPUS_5_5_TARIFF;

/**
 * The first-proof reservation ceiling: the whole context window at the
 * highest admitted input price plus every output token. For the frozen tariff
 * and 8,192 output tokens this is 51,638,400 units (USD 5.16384).
 */
export function attemptCeilingUnits(tariff: Tariff, maxOutputTokens: number): number {
  const input = Math.max(tariff.unitsPerToken.input, tariff.unitsPerToken.cacheWrite5m);
  return tariff.contextWindowTokens * input + maxOutputTokens * tariff.unitsPerToken.output;
}

/**
 * Whether a model identity returned by the provider is priced by this tariff:
 * the requested alias itself or a dated snapshot of the same model (for
 * example `claude-opus-5-5-20261001`). Any other model is a billing incident.
 */
export function tariffCoversModel(tariff: Tariff, model: string): boolean {
  return model === tariff.model || (model.startsWith(`${tariff.model}-`) && /^\d{8}$/.test(model.slice(tariff.model.length + 1)));
}

/** Billing classes this policy cannot price exactly; their presence holds the reservation. */
export function unsupportedBilling(usage: ProviderUsage): string | null {
  if (usage.cacheWrite1hInputTokens > 0) return 'one_hour_cache_write';
  if (usage.serverToolRequests > 0) return 'server_tool_use';
  if (usage.serviceTier !== null && usage.serviceTier !== 'standard') return 'service_tier';
  return null;
}

/** Exact cost of complete usage at the frozen tariff. */
export function usageUnits(tariff: Tariff, usage: ProviderUsage): number {
  const price = tariff.unitsPerToken;
  return usage.inputTokens * price.input + usage.cacheCreationInputTokens * price.cacheWrite5m
    + usage.cacheReadInputTokens * price.cacheRead + usage.outputTokens * price.output;
}

/** Fixed project policy. The ledger stores these caps once; nothing at runtime can raise them. */
export const ACCOUNTING_POLICY = {
  accountId: 'prior-authorization',
  policyVersion: 'pa-accounting-policy.v1',
  caps: { runUnits: 10 * UNITS_PER_USD, dayUnits: 20 * UNITS_PER_USD, lifetimeUnits: 20 * UNITS_PER_USD },
  /** One live provider request at a time across the worker and the evaluation CLI. */
  maxActiveDispatches: 1,
} as const;
