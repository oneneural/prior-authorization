import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { ACCOUNTING_POLICY, formatUnits } from '@pa/agents/admission';

import { AccountingLedger, dayCommitted, LedgerUnavailable, lifetimeCommitted, parseLedger, utcDay } from './ledger.js';
import { MigrationConflict, migrateLedger } from './migrate.js';

/**
 * Maintenance for the canonical accounting ledger. Run it only while the API
 * is stopped: every writing command takes the account writer lock. Output is
 * counts and amounts only, never keys, paths of secrets or provider bodies.
 *
 *   status  --ledger <path>
 *   migrate --ledger <path> --source-copy <retained v1 copy>
 *   recover --ledger <path> --confirm-writer-stopped --confirm-dispatch-owners-stopped [--clear-block] [--remove-temporary-files]
 */
const usage = 'usage: cli.js <status|migrate|recover> --ledger <path> [options]';
const policyCaps = { runUnits: ACCOUNTING_POLICY.caps.runUnits, dayUnits: ACCOUNTING_POLICY.caps.dayUnits, totalUnits: ACCOUNTING_POLICY.caps.lifetimeUnits };

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest, strict: true,
    options: {
      ledger: { type: 'string' }, 'source-copy': { type: 'string' }, 'confirm-writer-stopped': { type: 'boolean' },
      'confirm-dispatch-owners-stopped': { type: 'boolean' }, 'clear-block': { type: 'boolean' }, 'remove-temporary-files': { type: 'boolean' },
    },
  });
  if (values.ledger === undefined) {
    console.error(usage);
    return 2;
  }
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  switch (command) {
    case 'status': {
      const ledger = parseLedger(await readFile(values.ledger, 'utf8'));
      const day = utcDay(new Date());
      const count = (state: string) => ledger.attempts.filter((attempt) => attempt.state === state).length;
      print({
        schemaVersion: ledger.schemaVersion, revision: ledger.revision, writerGeneration: ledger.writerGeneration, blocked: ledger.blocked,
        attempts: { total: ledger.attempts.length, reserved: count('reserved'), dispatching: count('dispatching'), unknown: count('unknown'), reconciled: count('reconciled'), released: count('released') },
        committedUsd: { lifetime: formatUnits(lifetimeCommitted(ledger)), [day]: formatUnits(dayCommitted(ledger, day)) },
        migration: { sourceSha256: ledger.account.migration.sourceSha256, entries: ledger.account.migration.entries, committedUsd: formatUnits(ledger.account.migration.committedUnits) },
      });
      return 0;
    }
    case 'migrate': {
      if (values['source-copy'] === undefined) {
        console.error('migrate needs --source-copy, the separately retained byte-identical v1 file');
        return 2;
      }
      const result = await migrateLedger({ ledgerPath: values.ledger, sourceCopy: values['source-copy'] });
      print({ outcome: result.outcome, entries: result.manifest.entries, byStatus: result.manifest.byStatus, committedUsd: formatUnits(result.manifest.committedUnits), sourceSha256: result.manifest.sourceSha256 });
      return 0;
    }
    case 'recover': {
      if (values['confirm-writer-stopped'] !== true || values['confirm-dispatch-owners-stopped'] !== true) {
        console.error('recover needs --confirm-writer-stopped and --confirm-dispatch-owners-stopped after verifying both');
        return 2;
      }
      const ledger = await AccountingLedger.open({ path: values.ledger, caps: policyCaps, purpose: 'maintenance', confirmedPredecessorStopped: true });
      try {
        const result = await ledger.recover({ clearBlock: values['clear-block'] === true });
        const removed = values['remove-temporary-files'] === true ? await ledger.removeTemporaryFiles() : 0;
        print({ ...result, removedTemporaryFiles: removed, status: ledger.status() });
      } finally {
        await ledger.close();
      }
      return 0;
    }
    default:
      console.error(usage);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof LedgerUnavailable || error instanceof MigrationConflict) {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
