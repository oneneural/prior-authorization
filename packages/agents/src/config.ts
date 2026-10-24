import type { AgentCapability } from '@pa/contracts';

import { ACCOUNTING_POLICY, attemptCeilingUnits, InvalidAmount, OPUS_5_5_TARIFF, unitsToUsd, usdToUnits } from './admission/units.js';

export type Env = Readonly<Record<string, string | undefined>>;

export interface AgentLimits {
  /** Total tool executions per investigation, counting rejected attempts. */
  maxToolCalls: number;
  /** Provider turns per investigation. */
  maxModelCalls: number;
  /** Serialized size of one provider turn or tool result. */
  maxOutputBytes: number;
  /** Investigation time before the human wait; the wait itself is not counted. */
  maxRunSeconds: number;
  /** Transient tool retries after the first attempt. */
  maxToolRetries: number;
}

/** Configured live caps in exact accounting units; all zero unless live mode is selected. */
export interface LiveBudgets { runUnits: number; dayUnits: number; totalUnits: number }

export interface AgentSettings {
  /**
   * `off` leaves the rules baseline as the only path; `recorded` enables
   * recorded runs; `live` also admits explicit live Claude runs through the
   * API's accounting ledger. Key presence never selects a mode.
   */
  graphProvider: 'off' | 'recorded' | 'live';
  /** Positive only in live mode, and never above the fixed project policy. */
  live: LiveBudgets;
  limits: AgentLimits;
  /** Model candidates below this confidence are recorded but never accepted. */
  minConfidence: number;
}

export const DEFAULT_LIMITS: AgentLimits = { maxToolCalls: 10, maxModelCalls: 6, maxOutputBytes: 64 * 1024, maxRunSeconds: 180, maxToolRetries: 2 };
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  graphProvider: 'off', live: { runUnits: 0, dayUnits: 0, totalUnits: 0 }, limits: DEFAULT_LIMITS, minConfidence: 0.7,
};

export class AgentConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid agent configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'AgentConfigError';
  }
}

// Only these names are read, so a provider key in the environment is never touched.
type Read = 'AGENT_GRAPH_PROVIDER' | 'AGENT_RUN_BUDGET_USD' | 'AGENT_DAILY_BUDGET_USD' | 'AGENT_TOTAL_BUDGET_USD' | 'AGENT_MAX_TOOL_CALLS' | 'AGENT_MAX_MODEL_CALLS' | 'AGENT_MAX_RUN_SECONDS' | 'LANGSMITH_TRACING' | 'LANGSMITH_TRACING_V2' | 'LANGCHAIN_TRACING' | 'LANGCHAIN_TRACING_V2';

/** Messages name variables and never echo values, like the core configuration. */
export function loadAgentSettings(env: Env = process.env): AgentSettings {
  const problems: string[] = [];
  const value = (name: Read) => { const raw = env[name]; return raw === undefined || raw === '' ? undefined : raw; };
  const provider = value('AGENT_GRAPH_PROVIDER') ?? 'off';
  if (provider === 'anthropic') problems.push('AGENT_GRAPH_PROVIDER=anthropic is not a mode name; select live explicitly (supported: off, recorded, live)');
  else if (provider !== 'off' && provider !== 'recorded' && provider !== 'live') problems.push('AGENT_GRAPH_PROVIDER has an unrecognised value (supported: off, recorded, live)');
  const caps = { AGENT_RUN_BUDGET_USD: ACCOUNTING_POLICY.caps.runUnits, AGENT_DAILY_BUDGET_USD: ACCOUNTING_POLICY.caps.dayUnits, AGENT_TOTAL_BUDGET_USD: ACCOUNTING_POLICY.caps.lifetimeUnits } as const;
  const budget = (name: keyof typeof caps): number => {
    const raw = value(name);
    let units = raw === undefined ? 0 : Number.NaN;
    if (raw !== undefined) { try { units = usdToUnits(raw); } catch (error) { if (!(error instanceof InvalidAmount)) throw error; } }
    if (provider !== 'live') {
      if (units !== 0) problems.push(`${name} must be 0 unless AGENT_GRAPH_PROVIDER=live`);
      return 0;
    }
    // Zero, absent or invalid caps refuse live mode outright rather than starting with no allowance.
    if (!(units > 0 && units <= caps[name])) { problems.push(`${name} must be a positive amount of at most ${unitsToUsd(caps[name])} USD when AGENT_GRAPH_PROVIDER=live`); return 0; }
    return units;
  };
  const live: LiveBudgets = { runUnits: budget('AGENT_RUN_BUDGET_USD'), dayUnits: budget('AGENT_DAILY_BUDGET_USD'), totalUnits: budget('AGENT_TOTAL_BUDGET_USD') };
  // LangSmith tracing would send run data to an external service.
  for (const name of ['LANGSMITH_TRACING', 'LANGSMITH_TRACING_V2', 'LANGCHAIN_TRACING', 'LANGCHAIN_TRACING_V2'] as const) {
    const raw = value(name);
    if (raw !== undefined && raw !== 'false') problems.push(`${name} must be unset or false: external tracing is not permitted`);
  }
  const integer = (name: 'AGENT_MAX_TOOL_CALLS' | 'AGENT_MAX_MODEL_CALLS' | 'AGENT_MAX_RUN_SECONDS', fallback: number, max: number) => {
    const raw = value(name);
    if (raw === undefined) return fallback;
    const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) { problems.push(`${name} must be an integer from 1 to ${max}`); return fallback; }
    return parsed;
  };
  const limits: AgentLimits = {
    ...DEFAULT_LIMITS,
    maxToolCalls: integer('AGENT_MAX_TOOL_CALLS', DEFAULT_LIMITS.maxToolCalls, 10),
    maxModelCalls: integer('AGENT_MAX_MODEL_CALLS', DEFAULT_LIMITS.maxModelCalls, 6),
    maxRunSeconds: integer('AGENT_MAX_RUN_SECONDS', DEFAULT_LIMITS.maxRunSeconds, 180),
  };
  if (problems.length > 0) throw new AgentConfigError(problems);
  return { ...DEFAULT_AGENT_SETTINGS, graphProvider: provider as AgentSettings['graphProvider'], live, limits };
}

/** Live admission state as the API sees it; `null` outside live mode. */
export interface LiveAdmissionView { open: boolean; reason: 'available' | 'accounting_unavailable' | 'admission_blocked' | 'cap_below_attempt_ceiling'; remaining: { dayUnits: number; lifetimeUnits: number } | null }

/**
 * Caps that cannot admit even one attempt: each attempt reserves the full
 * ceiling, so a run, day or lifetime cap below it would refuse every request.
 */
export function capsBelowAttemptCeiling(live: LiveBudgets): ('run' | 'day' | 'total')[] {
  const ceiling = attemptCeilingUnits(OPUS_5_5_TARIFF, OPUS_5_5_TARIFF.maxOutputTokens);
  return (['run', 'day', 'total'] as const).filter((name) => live[`${name}Units`] < ceiling);
}

export function agentCapability(settings: AgentSettings, admission: LiveAdmissionView | null = null): AgentCapability {
  const live = settings.graphProvider === 'live' && admission !== null;
  const tooSmall = settings.graphProvider === 'live' && capsBelowAttemptCeiling(settings.live).length > 0;
  return {
    defaultMode: 'rules_only', graphProvider: settings.graphProvider,
    live: {
      enabled: live && admission.open && !tooSmall,
      reason: tooSmall ? 'cap_below_attempt_ceiling' : live ? admission.reason : 'disabled_by_configuration',
      runBudgetUsd: unitsToUsd(settings.live.runUnits), dailyBudgetUsd: unitsToUsd(settings.live.dayUnits), totalBudgetUsd: unitsToUsd(settings.live.totalUnits),
      remaining: live && admission.remaining !== null ? { dayUsd: unitsToUsd(admission.remaining.dayUnits), lifetimeUsd: unitsToUsd(admission.remaining.lifetimeUnits) } : null,
      attemptReservationUsd: unitsToUsd(attemptCeilingUnits(OPUS_5_5_TARIFF, OPUS_5_5_TARIFF.maxOutputTokens)),
    },
  };
}
