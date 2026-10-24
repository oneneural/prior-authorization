'use client';

import { PilotNotice } from './pilot-notice';

import './globals.css';

// Replaces the root layout when the layout itself fails, so it renders its own
// document, styles and the pilot notice.
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans text-base antialiased">
        <title>Prior authorization pilot status</title>
        <PilotNotice />
        <main className="mx-auto max-w-5xl px-4 pt-6 pb-8">
          <h1 className="text-lg font-semibold">The status page could not be displayed</h1>
          <button type="button" className="mt-4 rounded-lg border px-4 py-2 text-sm" onClick={() => retry()}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
