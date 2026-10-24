import { describe, expect, it } from 'vitest';

import { agentCapability, capsBelowAttemptCeiling, DEFAULT_AGENT_SETTINGS, loadAgentSettings, type AgentConfigError, type Env } from './config.js';

/** Fails the test if configuration touches any provider credential. */
function guarded(values: Record<string, string>): Env {
  return new Proxy(values, {
    get(target, name) {
      if (typeof name === 'string' && name.startsWith('ANTHROPIC')) throw new Error(`read ${name}`);
      return target[name as string];
    },
  });
}

describe('agent settings', () => {
  it('defaults to rules only with recorded runs off and live Claude disabled at zero budgets', () => {
    expect(loadAgentSettings(guarded({}))).toEqual(DEFAULT_AGENT_SETTINGS);
    expect(agentCapability(DEFAULT_AGENT_SETTINGS)).toEqual({
      defaultMode: 'rules_only', graphProvider: 'off',
      live: { enabled: false, reason: 'disabled_by_configuration', runBudgetUsd: 0, dailyBudgetUsd: 0, totalBudgetUsd: 0, remaining: null, attemptReservationUsd: 5.16384 },
    });
  });

  it('enables recorded runs only by the explicit setting and never reads a provider key', () => {
    const settings = loadAgentSettings(guarded({ AGENT_GRAPH_PROVIDER: 'recorded', ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key', AGENT_MAX_TOOL_CALLS: '8' }));
    expect(settings.graphProvider).toBe('recorded');
    expect(settings.live).toEqual({ runUnits: 0, dayUnits: 0, totalUnits: 0 });
    expect(settings.limits.maxToolCalls).toBe(8);
  });

  it('enables live mode only explicitly, with all three caps positive and within the fixed policy', () => {
    const live = { AGENT_GRAPH_PROVIDER: 'live', AGENT_RUN_BUDGET_USD: '6', AGENT_DAILY_BUDGET_USD: '20', AGENT_TOTAL_BUDGET_USD: '20.0000000' };
    const settings = loadAgentSettings(guarded(live));
    expect(settings.graphProvider).toBe('live');
    expect(settings.live).toEqual({ runUnits: 60_000_000, dayUnits: 200_000_000, totalUnits: 200_000_000 });
    const view = { open: true, reason: 'available' as const, remaining: { dayUnits: 180_605_124, lifetimeUnits: 180_605_124 } };
    expect(agentCapability(settings, view).live).toEqual({
      enabled: true, reason: 'available', runBudgetUsd: 6, dailyBudgetUsd: 20, totalBudgetUsd: 20, remaining: { dayUsd: 18.0605124, lifetimeUsd: 18.0605124 }, attemptReservationUsd: 5.16384,
    });
    expect(agentCapability(settings, { open: false, reason: 'accounting_unavailable', remaining: null }).live).toMatchObject({ enabled: false, reason: 'accounting_unavailable' });
    // Live mode with no admission view (no ledger opened) is never enabled.
    expect(agentCapability(settings).live.enabled).toBe(false);
  });

  it('reports a cap below one attempt ceiling as unavailable even with open accounting', () => {
    const view = { open: true, reason: 'available' as const, remaining: { dayUnits: 180_605_124, lifetimeUnits: 180_605_124 } };
    for (const [name, value] of [['AGENT_RUN_BUDGET_USD', '5'], ['AGENT_DAILY_BUDGET_USD', '5.1638399'], ['AGENT_TOTAL_BUDGET_USD', '1']] as const) {
      const settings = loadAgentSettings(guarded({ AGENT_GRAPH_PROVIDER: 'live', AGENT_RUN_BUDGET_USD: '6', AGENT_DAILY_BUDGET_USD: '20', AGENT_TOTAL_BUDGET_USD: '20', [name]: value }));
      expect(capsBelowAttemptCeiling(settings.live)).toEqual([{ AGENT_RUN_BUDGET_USD: 'run', AGENT_DAILY_BUDGET_USD: 'day', AGENT_TOTAL_BUDGET_USD: 'total' }[name]]);
      expect(agentCapability(settings, view).live).toMatchObject({ enabled: false, reason: 'cap_below_attempt_ceiling' });
    }
    // Exactly one ceiling is enough for one attempt.
    const exact = loadAgentSettings(guarded({ AGENT_GRAPH_PROVIDER: 'live', AGENT_RUN_BUDGET_USD: '5.16384', AGENT_DAILY_BUDGET_USD: '5.16384', AGENT_TOTAL_BUDGET_USD: '5.16384' }));
    expect(capsBelowAttemptCeiling(exact.live)).toEqual([]);
    expect(agentCapability(exact, view).live.enabled).toBe(true);
  });

  it('refuses zero, absent, invalid or raised caps for each of the three caps independently', () => {
    const attempt = (env: Record<string, string>) => { try { loadAgentSettings(guarded(env)); } catch (error) { return error as AgentConfigError; } throw new Error('accepted'); };
    const live = { AGENT_GRAPH_PROVIDER: 'live', AGENT_RUN_BUDGET_USD: '5', AGENT_DAILY_BUDGET_USD: '20', AGENT_TOTAL_BUDGET_USD: '20' };
    const maxima = { AGENT_RUN_BUDGET_USD: 10, AGENT_DAILY_BUDGET_USD: 20, AGENT_TOTAL_BUDGET_USD: 20 } as const;
    for (const [name, max] of Object.entries(maxima)) {
      const problem = `${name} must be a positive amount of at most ${max} USD when AGENT_GRAPH_PROVIDER=live`;
      for (const value of ['0', '0.0000000', `${max}.0000001`, '25', '-1', '1e1', 'five', '0.00000001']) expect(attempt({ ...live, [name]: value }).problems).toEqual([problem]);
      expect(attempt(Object.fromEntries(Object.entries(live).filter(([key]) => key !== name))).problems).toEqual([problem]);
    }
  });

  it('refuses the old provider name, nonzero budgets outside live mode, external tracing and out-of-range limits without echoing values', () => {
    const attempt = (env: Record<string, string>) => { try { loadAgentSettings(guarded(env)); } catch (error) { return error as AgentConfigError; } throw new Error('accepted'); };
    expect(attempt({ AGENT_GRAPH_PROVIDER: 'anthropic' }).problems[0]).toMatch(/select live explicitly/);
    expect(attempt({ AGENT_GRAPH_PROVIDER: 'sk-secret' }).message).not.toContain('sk-secret');
    expect(attempt({ AGENT_RUN_BUDGET_USD: '5' }).problems).toEqual(['AGENT_RUN_BUDGET_USD must be 0 unless AGENT_GRAPH_PROVIDER=live']);
    expect(attempt({ AGENT_GRAPH_PROVIDER: 'recorded', AGENT_TOTAL_BUDGET_USD: '1' }).problems).toEqual(['AGENT_TOTAL_BUDGET_USD must be 0 unless AGENT_GRAPH_PROVIDER=live']);
    expect(attempt({ AGENT_DAILY_BUDGET_USD: '0.01' }).problems).toHaveLength(1);
    expect(attempt({ LANGSMITH_TRACING: 'true' }).problems[0]).toMatch(/external tracing/);
    for (const name of ['LANGSMITH_TRACING_V2', 'LANGCHAIN_TRACING', 'LANGCHAIN_TRACING_V2']) {
      expect(attempt({ [name]: 'true' }).problems).toEqual([`${name} must be unset or false: external tracing is not permitted`]);
    }
    expect(loadAgentSettings(guarded({ LANGSMITH_TRACING_V2: 'false', LANGCHAIN_TRACING: 'false' })).graphProvider).toBe('off');
    expect(attempt({ AGENT_MAX_MODEL_CALLS: '7' }).problems).toEqual(['AGENT_MAX_MODEL_CALLS must be an integer from 1 to 6']);
    expect(loadAgentSettings(guarded({ AGENT_RUN_BUDGET_USD: '0', AGENT_DAILY_BUDGET_USD: '0.00' })).live.runUnits).toBe(0);
  });
});
