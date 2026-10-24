import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { ACCOUNTING_POLICY, InvalidAmount, usdToUnits } from '../admission/units.js';
import { AgentConfigError, loadAgentSettings, type Env } from '../config.js';
import { LIVE_MODEL_DEFAULTS, type LiveEffort, type LiveSettings } from './anthropic.js';

export interface LiveEvaluationSettings {
  settings: LiveSettings;
  apiKeyFile: string;
  /** Decimal USD cap requested for this run; the API freezes the smaller of it and the policy. */
  runCapUsd: string;
  /** Loopback origin of the API that owns the canonical accounting ledger. */
  admissionOrigin: string;
  /** `Bearer <token>` for the evaluation admission routes. */
  admissionAuthorization: string;
}

// Only these names are read. The key itself is never in the environment.
type Read = 'PA_ANTHROPIC_API_KEY_FILE' | 'PA_ANTHROPIC_LEDGER_FILE' | 'PA_LIVE_RUN_CAP_USD' | 'PA_LIVE_EFFORT' | 'PA_ADMISSION_API_ORIGIN' | 'PA_EVALUATION_ADMISSION_TOKEN_FILE';

/**
 * Settings for the live evaluation command only. Live calls need an explicit
 * key file, a positive run cap and the API's evaluation admission service;
 * there is no file ledger fallback. The retired `PA_ANTHROPIC_LEDGER_FILE` is
 * refused so a JSON ledger can never act as a separate live account.
 * Messages name variables and never echo values.
 */
export function loadLiveEvaluationSettings(env: Env = process.env, readFile: (path: string) => string = (path) => readFileSync(path, 'utf8')): LiveEvaluationSettings {
  loadAgentSettings(env);
  const problems: string[] = [];
  const value = (name: Read) => { const raw = env[name]; return raw === undefined || raw === '' ? undefined : raw; };
  const file = (name: Read) => {
    const raw = value(name);
    if (raw === undefined || !isAbsolute(raw)) problems.push(`${name} must be an absolute file path`);
    return raw ?? '';
  };
  if (value('PA_ANTHROPIC_LEDGER_FILE') !== undefined) problems.push('PA_ANTHROPIC_LEDGER_FILE is retired: the JSON ledger is migration input only and live calls use the API admission service');
  const apiKeyFile = file('PA_ANTHROPIC_API_KEY_FILE');
  const runCapUsd = value('PA_LIVE_RUN_CAP_USD') ?? '';
  let capUnits = Number.NaN;
  try { capUnits = usdToUnits(runCapUsd); } catch (error) { if (!(error instanceof InvalidAmount)) throw error; }
  if (!(capUnits > 0 && capUnits <= ACCOUNTING_POLICY.caps.runUnits)) problems.push('PA_LIVE_RUN_CAP_USD must be a positive amount of at most 10 USD');
  const effort = value('PA_LIVE_EFFORT') ?? LIVE_MODEL_DEFAULTS.effort;
  if (effort !== 'low' && effort !== 'medium' && effort !== 'high') problems.push('PA_LIVE_EFFORT must be low, medium or high');
  const origin = value('PA_ADMISSION_API_ORIGIN');
  let admissionOrigin = '';
  try {
    const url = new URL(origin ?? '');
    if (url.protocol !== 'http:' || url.origin !== origin || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('not loopback');
    admissionOrigin = url.origin;
  } catch {
    problems.push('PA_ADMISSION_API_ORIGIN must be an exact loopback http origin such as http://127.0.0.1:4105');
  }
  const tokenFile = file('PA_EVALUATION_ADMISSION_TOKEN_FILE');
  let token = '';
  if (tokenFile !== '') {
    try {
      token = readFile(tokenFile).replace(/\r?\n$/, '');
      if (token.length < 32) problems.push('PA_EVALUATION_ADMISSION_TOKEN_FILE must hold at least 32 characters');
    } catch {
      problems.push('PA_EVALUATION_ADMISSION_TOKEN_FILE could not be read');
    }
  }
  if (problems.length > 0) throw new AgentConfigError(problems);
  return {
    apiKeyFile, runCapUsd, admissionOrigin, admissionAuthorization: `Bearer ${token}`,
    settings: { ...LIVE_MODEL_DEFAULTS, effort: effort as LiveEffort },
  };
}
