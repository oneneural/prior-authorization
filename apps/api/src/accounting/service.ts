import { capsBelowAttemptCeiling, type AgentSettings, type LiveAdmissionView } from '@pa/agents/config';

import { AccountingLedger, LedgerUnavailable, type LedgerOptions } from './ledger.js';

/** Live admission is configured but cannot be used; the route answers 503 and nothing is sent. */
export class AdmissionServiceUnavailable extends Error {
  override name = 'AdmissionServiceUnavailable';
  constructor(readonly reason: string) {
    super('live admission is unavailable');
  }
}

/**
 * The API's handle on live accounting. Outside live mode it is inert: no
 * ledger path is resolved and no file is opened. In live mode a missing,
 * corrupt, foreign or locked ledger leaves the application running with
 * live admission unavailable, so offline work continues.
 */
export class LiveAdmission {
  private constructor(
    readonly settings: AgentSettings,
    /** Image revision recorded with each registered live run. */
    readonly build: string,
    private readonly opened: AccountingLedger | null,
    private readonly startupFailure: string | null,
  ) {}

  static disabled(settings: AgentSettings): LiveAdmission {
    return new LiveAdmission(settings, 'unknown', null, null);
  }

  static async start(settings: AgentSettings, ledgerFile: string | null, build: string, options: Partial<LedgerOptions> = {}): Promise<LiveAdmission> {
    if (settings.graphProvider !== 'live') return LiveAdmission.disabled(settings);
    if (ledgerFile === null) return new LiveAdmission(settings, build, null, 'ledger_not_configured');
    // A cap that cannot hold one full reservation would refuse every attempt; the ledger is not opened.
    if (capsBelowAttemptCeiling(settings.live).length > 0) return new LiveAdmission(settings, build, null, 'cap_below_attempt_ceiling');
    try {
      const ledger = await AccountingLedger.open({ ...options, path: ledgerFile, caps: settings.live, purpose: 'api' });
      return new LiveAdmission(settings, build, ledger, null);
    } catch (error) {
      if (error instanceof LedgerUnavailable) return new LiveAdmission(settings, build, null, error.reason);
      throw error;
    }
  }

  get live(): boolean {
    return this.settings.graphProvider === 'live';
  }

  /** Why live admission is closed, or null while it is open. */
  get reason(): string | null {
    if (!this.live) return 'disabled_by_configuration';
    return this.startupFailure ?? this.opened?.status().reason ?? null;
  }

  /** The ledger, only while live admission is open. */
  ledger(): AccountingLedger {
    const reason = this.reason;
    if (reason !== null || this.opened === null) throw new AdmissionServiceUnavailable(reason ?? 'ledger_unavailable');
    return this.opened;
  }

  /** The ledger for accounting-only reports, which still settle after a run is cancelled. */
  settlementLedger(): AccountingLedger {
    if (this.opened === null) throw new AdmissionServiceUnavailable(this.reason ?? 'ledger_unavailable');
    return this.opened;
  }

  view(): LiveAdmissionView | null {
    if (!this.live) return null;
    const reason = this.reason;
    const status = this.opened?.status();
    return {
      open: reason === null,
      reason: reason === null ? 'available'
        : reason === 'cap_below_attempt_ceiling' ? reason
          : status === undefined || status.failure !== null ? 'accounting_unavailable' : 'admission_blocked',
      remaining: status === undefined ? null : status.remaining,
    };
  }

  async close(): Promise<void> {
    await this.opened?.close();
  }
}
