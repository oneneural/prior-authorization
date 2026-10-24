import type { AgentVersions } from '@pa/contracts';

import { PROMPT_VERSION } from './prompt.js';
import { LIVE_TOOLS_VERSION } from './providers/live-tools.js';

export const GRAPH_VERSION = 'pa-evidence-graph.v1';
export const STATE_SCHEMA_VERSION = 'pa-agent-state.v1';

/** Stored on the run and in the checkpoint; any difference refuses a resume. */
export function runVersions(providerVersion: string): AgentVersions {
  return { graph: GRAPH_VERSION, stateSchema: STATE_SCHEMA_VERSION, prompt: PROMPT_VERSION, provider: providerVersion };
}

/** The frozen live model settings; the API and the review-only resume derive versions from these alone. */
export interface LiveModelSettings { model: string; effort: 'low' | 'medium' | 'high'; maxOutputTokens: number }
export const LIVE_MODEL_DEFAULTS = { model: 'claude-opus-5-5', effort: 'medium', maxOutputTokens: 8192 } as const satisfies LiveModelSettings;

/** Recorded in run and checkpoint versions; review-only resumption reproduces it without a client. */
export const liveProviderVersion = (settings: LiveModelSettings) => `anthropic:${settings.model}:${settings.effort}:${PROMPT_VERSION}:tools-${LIVE_TOOLS_VERSION}`;

/** The run versions frozen in the accounting ledger when a live budget run is registered. */
export const liveRunVersionsRecord = (providerVersion: string, build: string) => ({
  source: GRAPH_VERSION, build, prompt: PROMPT_VERSION, tools: LIVE_TOOLS_VERSION, provider: providerVersion,
});

export { createRecordedProvider, loadRecording, RecordingUnavailable } from './providers/recorded.js';
