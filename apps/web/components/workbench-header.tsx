import Link from 'next/link';

import { ACTOR_ROLE_LABELS, CASE_NOTICE, type SessionView } from '@pa/contracts';

import { SignOut } from './sign-in';

/** Signed-in identity with its permanent fixture label, and the case notice. */
export function WorkbenchHeader({ session }: { session: SessionView }) {
  return (
    <header className="flex flex-col gap-3 border-b border-line pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-accent">Prior authorization evidence workbench</Link>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm" data-testid="session-actor">
            {session.actor.name}: <span className="font-medium">{ACTOR_ROLE_LABELS[session.actor.role]}</span>
          </p>
          <SignOut />
        </div>
      </div>
      <p className="w-fit rounded-md bg-accent-soft px-3 py-1 text-sm">
        Fixture identity (AUTH_MODE=fixture): a demo role, not a professional, clinical or payer credential. {CASE_NOTICE}
      </p>
    </header>
  );
}
