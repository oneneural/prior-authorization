import { defineConfig } from 'drizzle-kit';

// Used only by `pnpm --filter @pa/db generate`; generated SQL is reviewed before commit.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  schemaFilter: ['pa_app', 'pa_worker'],
});
