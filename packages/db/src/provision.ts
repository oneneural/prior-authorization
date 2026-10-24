import pg from 'pg';

import type { ProvisionConfig } from '@pa/config';

import { ROLES } from './constants.js';

export interface ProvisionPlan {
  database: string;
  passwords: Record<keyof typeof ROLES, string>;
}

/**
 * Derives the database name and role passwords from the three role URLs, and
 * refuses URLs that name other roles or different databases.
 */
export function planFromUrls(config: Omit<ProvisionConfig, 'adminDatabaseUrl'>): ProvisionPlan {
  const urls = {
    migrator: new URL(config.migratorDatabaseUrl),
    api: new URL(config.apiDatabaseUrl),
    worker: new URL(config.workerDatabaseUrl),
  };
  const problems: string[] = [];
  const databases = new Set<string>();
  for (const [key, url] of Object.entries(urls) as [keyof typeof ROLES, URL][]) {
    if (decodeURIComponent(url.username) !== ROLES[key]) {
      problems.push(`the ${key} URL must use role ${ROLES[key]}`);
    }
    if (url.password === '') {
      problems.push(`the ${key} URL must include a password`);
    }
    databases.add(decodeURIComponent(url.pathname.replace(/^\//, '')));
  }
  const [database] = databases;
  if (databases.size !== 1 || database === undefined || database === '') {
    problems.push('the migrator, API and worker URLs must name the same non-empty database');
  }
  if (problems.length > 0 || database === undefined) {
    throw new Error(`Cannot provision: ${problems.join('; ')}`);
  }
  return {
    database,
    passwords: {
      migrator: decodeURIComponent(urls.migrator.password),
      api: decodeURIComponent(urls.api.password),
      worker: decodeURIComponent(urls.worker.password),
    },
  };
}

function withDatabase(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

async function withClient<T>(connectionString: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString, application_name: 'pa-provision' });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/**
 * Idempotent superuser step that runs before migrations: login roles without
 * elevated attributes, a database owned by the migrator, and CONNECT for the
 * runtime roles only. Every object-level grant is made later by the migrator.
 */
export async function provisionDatabase(adminUrl: string, plan: ProvisionPlan): Promise<{ databaseCreated: boolean }> {
  const { escapeIdentifier: ident, escapeLiteral: literal } = pg;
  const db = ident(plan.database);

  const databaseCreated = await withClient(adminUrl, async (client) => {
    for (const key of Object.keys(ROLES) as (keyof typeof ROLES)[]) {
      const role = ident(ROLES[key]);
      const attributes = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(plan.passwords[key])}`;
      const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLES[key]]);
      await client.query(rowCount === 0 ? `CREATE ROLE ${role} ${attributes}` : `ALTER ROLE ${role} ${attributes}`);
    }

    const { rows } = await client.query<{ owner: string }>(
      'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
      [plan.database],
    );
    if (rows.length === 0) {
      await client.query(`CREATE DATABASE ${db} OWNER ${ident(ROLES.migrator)}`);
      return true;
    }
    if (rows[0]?.owner !== ROLES.migrator) {
      throw new Error(`database ${plan.database} exists but is not owned by ${ROLES.migrator}`);
    }
    return false;
  });

  await withClient(withDatabase(adminUrl, plan.database), async (client) => {
    // Removes PUBLIC's default CONNECT and TEMPORARY so runtime roles cannot create temp objects.
    await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${ident(ROLES.api)}, ${ident(ROLES.worker)}`);
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  });
  return { databaseCreated };
}
