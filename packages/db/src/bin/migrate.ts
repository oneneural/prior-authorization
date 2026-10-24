import { ConfigError, loadMigratorConfig } from '@pa/config';

import { runMigrations } from '../migrate.js';

try {
  const config = loadMigratorConfig();
  await runMigrations(config.databaseUrl, (message) => console.log(`migrator: ${message}`));
  console.log('migrator: complete');
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : `migration failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
