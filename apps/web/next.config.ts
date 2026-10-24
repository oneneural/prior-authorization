import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

// Compression stays at the default (enabled). The SSE route also sends
// `Cache-Control: no-transform`; the web transport tests check that its frames
// arrive unbuffered and unencoded while compression is negotiated.
//
// The container image runs the standalone server. Tracing starts at the
// workspace root so workspace packages imported by the web app are included.
const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
