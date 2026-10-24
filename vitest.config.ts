import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Tests import workspace packages from source through the `@pa/source` export
// condition, so they never depend on stale `dist` output. Like Vitest's own
// default, `module` is excluded so dependencies resolve to Node-loadable builds.
const conditions = ['@pa/source', ...defaultServerConditions.filter((condition) => condition !== 'module')];

export default defineConfig({
  resolve: { conditions, mainFields: [] },
  ssr: { resolve: { conditions } },
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          // Web tests that need neither a build nor a database run here too. The
          // split is by file name only: a web test that needs the built server or
          // the database must be named *.build.test.ts, or it runs here without them.
          // Fixture, oracle and policy pack validation (evals/src) needs neither.
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'apps/web/test/**/*.test.ts', 'evals/src/**/*.test.ts'],
          exclude: ['apps/web/test/**/*.build.test.ts'],
        },
      },
      {
        // `pnpm test:evals`: the rules-only assessment against every frozen oracle.
        // Needs neither a build nor a database.
        extends: true,
        test: {
          name: 'evals',
          include: ['evals/src/**/*.eval.ts'],
        },
      },
      {
        // `pnpm test:evals:live`: paid Anthropic calls, only with an explicit key
        // file, API admission and run cap (docs/development.md). Run it only on purpose.
        extends: true,
        test: {
          name: 'evals-live',
          include: ['evals/src/**/*.live.ts'],
          fileParallelism: false,
          testTimeout: 7_200_000,
        },
      },
      {
        // `pnpm test:oracles:v2`: structural validation of the registered v2
        // batches, fixtures, oracles and recipe pins. No assessment;
        // needs neither a build nor a database.
        extends: true,
        test: {
          name: 'oracles-v2',
          include: ['evals/src/v2/**/*.check.ts'],
        },
      },
      {
        // Requires the disposable PostgreSQL from compose.test.yaml.
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.integration.test.ts', 'apps/*/test/**/*.integration.test.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Requires `pnpm build` first and the same PostgreSQL; it starts the built web server.
        extends: true,
        test: {
          name: 'web',
          include: ['apps/web/test/**/*.build.test.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 90_000,
        },
      },
      {
        // Requires Docker; builds the app image and drives its own Compose project
        // (prior-authorization-ctest on 127.0.0.1:36105). See docs/operations.md.
        extends: true,
        test: {
          name: 'container',
          include: ['scripts/container/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 600_000,
          hookTimeout: 1_800_000,
        },
      },
    ],
  },
});
