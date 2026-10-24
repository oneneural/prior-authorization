import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { PilotNotice } from './pilot-notice';

import './globals.css';

export const metadata: Metadata = {
  title: 'Prior authorization evidence workbench',
  description: 'Synthetic administrative evidence workbench. Administrative review only. No payer submission.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans text-base antialiased">
        {/* The root layout also wraps not-found and error UI; global-error.tsx repeats the notice. */}
        <PilotNotice />
        {children}
      </body>
    </html>
  );
}
