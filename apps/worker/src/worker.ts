import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import type { WorkerConfig } from '@pa/config';
import { API_ORIGIN } from '@pa/config/topology';
import {
  AGENT_QUEUE,
  CASE_QUEUE,
  WORKFLOW_QUEUE,
  ErrorResponse,
  PilotJobPayload,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_PATH,
  WORKER_RESULT_PATH,
  type WorkerHeartbeatReport,
  type WorkerResult,
  type WorkerResultReport,
} from '@pa/contracts';
import { PILOT_QUEUE, recordHeartbeat, type Database, type JobResult, type PgBoss } from '@pa/db';

import { startAgentJobs, type AgentWorkerDeps } from './agent.js';
import { startCaseJobs } from './cases.js';
import { startWorkflowJobs } from './workflow.js';

const RESULT_TIMEOUT_MS = 10_000;
const HEARTBEAT_REPORT_TIMEOUT_MS = 3_000;

export interface WorkerDependencies {
  config: WorkerConfig;
  /** Worker-role connection; it can reach only the heartbeat table and the queue. */
  db: Database;
  /** A started runtime pg-boss instance for the worker role. */
  boss: PgBoss;
  apiOrigin?: string;
  workerId?: string;
  heartbeatIntervalMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Investigation runs; the agent queue is consumed only when this is set and recorded or live mode is enabled. */
  agent?: AgentWorkerDeps;
}

export interface DrainResult {
  /** True when every claimed job settled before the deadline. */
  drained: boolean;
  /** Jobs still running at the deadline; pg-boss failed them back to the queue for retry. */
  interruptedJobIds: string[];
}

export interface RunningWorker {
  workerId: string;
  bootId: string;
  /** Stops claiming jobs and waits up to `deadlineMs` for claimed jobs to settle. */
  drain(deadlineMs: number): Promise<DrainResult>;
}

/** Deterministic, so a redelivered job reports a result identical to the first attempt. */
export function pilotResult(probeId: string): WorkerResult {
  return { outcome: 'processed', probeDigest: createHash('sha256').update(probeId).digest('hex') };
}

/**
 * Consumes pilot jobs one at a time per slot. The worker has no application-table
 * access: it reports each result to the API's internal route, which derives the
 * probe from its own job record. Throwing fails the attempt so pg-boss retries it.
 */
export async function startWorker(deps: WorkerDependencies): Promise<RunningWorker> {
  const workerId = deps.workerId ?? `${hostname()}-${process.pid}`;
  const bootId = randomUUID();
  const startedAt = new Date();
  const apiOrigin = deps.apiOrigin ?? API_ORIGIN;
  const log = deps.log ?? (() => undefined);
  const authorization = `Bearer ${deps.config.workerServiceToken}`;
  const active = new Set<string>();
  let lastJobId: string | null = null;
  let heartbeatFailing = false;

  const beat = () => recordHeartbeat(deps.db, { workerId, bootId, startedAt, lastJobId });

  // The API counts only heartbeats it receives from this boot, and only after the
  // database write succeeded, so readiness reflects both worker database access
  // and a live worker process.
  async function heartbeat(): Promise<void> {
    await beat();
    const report: WorkerHeartbeatReport = { workerId, bootId, startedAt: startedAt.toISOString() };
    const response = await fetch(new URL(WORKER_HEARTBEAT_PATH, apiOrigin), {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(HEARTBEAT_REPORT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`API rejected the heartbeat: ${response.status}`);
    }
  }

  await beat();
  const timer = setInterval(() => {
    heartbeat().then(
      () => {
        if (heartbeatFailing) {
          heartbeatFailing = false;
          log('heartbeat recovered');
        }
      },
      (error: unknown) => {
        // Logged once per failure episode rather than on every interval.
        if (!heartbeatFailing) {
          heartbeatFailing = true;
          log('heartbeat failed', { error: (error as Error).message });
        }
      },
    );
  }, deps.heartbeatIntervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  // The API may not be listening yet when the worker starts; the interval retries.
  void heartbeat().catch(() => undefined);

  // perJobResults lets a payload that can never succeed fail terminally (no retries);
  // a thrown error still fails the job for a bounded retry.
  await deps.boss.work(
    PILOT_QUEUE,
    { batchSize: 1, localConcurrency: deps.config.concurrency, pollingIntervalSeconds: 1, perJobResults: true },
    async ([job]): Promise<JobResult[]> => {
      if (job === undefined) {
        return [];
      }
      const payload = PilotJobPayload.safeParse(job.data);
      if (!payload.success) {
        log('pilot job rejected permanently: malformed payload', { jobId: job.id });
        return [{ id: job.id, status: 'deadletter', output: { error: 'malformed_payload' } }];
      }
      const { probeId } = payload.data;
      active.add(job.id);
      try {
        lastJobId = job.id;
        await beat();
        log('pilot job started', { jobId: job.id });
        if (deps.config.testJobDelayMs > 0) {
          // Container shutdown tests only (fixture mode): holds the job active so a
          // stop signal provably arrives mid-job. pg-boss aborts the signal when a
          // drain deadline fails the job back to the queue.
          await delay(deps.config.testJobDelayMs, undefined, { signal: job.signal });
        }

        const report: WorkerResultReport = { jobId: job.id, probeId, result: pilotResult(probeId) };
        const response = await fetch(new URL(WORKER_RESULT_PATH, apiOrigin), {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify(report),
          signal: AbortSignal.timeout(RESULT_TIMEOUT_MS),
        });
        if (!response.ok) {
          const parsed = ErrorResponse.safeParse(await response.json().catch(() => undefined));
          throw new Error(`API rejected the pilot result: ${response.status} ${parsed.success ? parsed.data.error.code : 'unknown'}`);
        }
        log('pilot job processed', { jobId: job.id });
        return [{ id: job.id, status: 'completed' }];
      } finally {
        active.delete(job.id);
      }
    },
  );

  await startCaseJobs(deps.boss, apiOrigin, authorization, deps.config.concurrency, active, async (jobId) => {
    lastJobId = jobId;
    await beat();
  });

  await startWorkflowJobs(deps.boss, apiOrigin, authorization, deps.config.concurrency, active, async (jobId) => { lastJobId = jobId; await beat(); });

  const agentEnabled = deps.agent !== undefined && deps.agent.settings.graphProvider !== 'off';
  if (agentEnabled) {
    await startAgentJobs(deps.boss, { apiOrigin, authorization }, deps.config.concurrency, active, async (jobId) => { lastJobId = jobId; await beat(); }, { log, ...deps.agent! });
  }

  return {
    workerId,
    bootId,
    /**
     * Stops fetching with pg-boss 12.38.0 `offWork(name, { wait: true })`, which
     * resolves once running handlers have returned. If the deadline passes first,
     * `stop({ graceful: false })` fails every job still active ("pg-boss shut down
     * while active"), returning it to the queue under the retry policy, aborts its
     * signal and closes the pool. An interrupted job is never recorded as completed.
     */
    async drain(deadlineMs) {
      clearInterval(timer);
      const queues = [PILOT_QUEUE, CASE_QUEUE, WORKFLOW_QUEUE, ...(agentEnabled ? [AGENT_QUEUE] : [])];
      const settled = Promise.all(queues.map((queue) => deps.boss.offWork(queue, { wait: true }))).then(() => 'drained' as const);
      const outcome = await Promise.race([settled, delay(deadlineMs, 'deadline' as const, { ref: false })]);
      const interruptedJobIds = outcome === 'deadline' ? [...active] : [];
      await deps.boss.stop({ graceful: false, close: true });
      return { drained: outcome === 'drained', interruptedJobIds };
    },
  };
}
