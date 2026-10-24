'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { FixtureUserKey } from '@pa/contracts';

import { PRIMARY, SECONDARY } from './command-button';

const CHOICES: { user: FixtureUserKey; label: string; detail: string }[] = [
  { user: 'operator', label: 'Fixture operator', detail: 'Assesses cases, drafts and locally approves neutral requests, records fixture responses.' },
  { user: 'reviewer', label: 'Fixture administrative reviewer', detail: 'Accepts or returns administrative packets and reviews recorded proposals. Not a clinical credential.' },
  { user: 'outsider', label: 'Fixture user outside the case team', detail: 'Signs in with no case access, to show scope denial.' },
];

/** Fixture-mode sign-in: a seeded identity is chosen, never a password or external account. */
export function SignIn() {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function signIn(user: FixtureUserKey) {
    setBusy(true);
    setMessage('');
    const response = await fetch('/api/auth/fixture/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user }) }).catch(() => null);
    setBusy(false);
    if (response?.ok) {
      router.push('/');
      router.refresh();
    } else {
      setMessage(`Sign-in failed (${response === null ? 'web server unreachable' : `HTTP ${response.status}`}).`);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3">
        {CHOICES.map((choice, index) => (
          <li key={choice.user} className="flex flex-col gap-2 rounded-lg border border-line p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">{choice.label}</p>
              <p className="text-sm text-muted">{choice.detail}</p>
            </div>
            <button type="button" disabled={busy} className={index === 0 ? PRIMARY : SECONDARY} onClick={() => void signIn(choice.user)}>
              Sign in as {choice.label.toLowerCase()}
            </button>
          </li>
        ))}
      </ul>
      <p role="status" aria-live="polite" className="text-sm text-warning">{message}</p>
    </div>
  );
}

export function SignOut() {
  const router = useRouter();
  return (
    <button
      type="button"
      className={SECONDARY}
      onClick={() => void fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).finally(() => { router.push('/login'); router.refresh(); })}
    >
      Sign out
    </button>
  );
}
