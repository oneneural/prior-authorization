import { ConfigError, loadProvisionConfig } from '@pa/config';

import { planFromUrls, provisionDatabase } from '../provision.js';

// One-off superuser step: `DATABASE_URL_ADMIN` is used here only, never by services.
try {
  const config = loadProvisionConfig();
  const plan = planFromUrls(config);
  await provisionDatabase(config.adminDatabaseUrl, plan);
  console.log(`provisioned database ${plan.database} and roles`);
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : `provisioning failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
