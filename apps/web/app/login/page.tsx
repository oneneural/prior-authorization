import { redirect } from 'next/navigation';

import { CASE_NOTICE } from '@pa/contracts';

import { SignIn } from '../../components/sign-in';
import { currentSession } from '../../lib/cases';

export default async function LoginPage() {
  if ((await currentSession()) !== null) redirect('/');
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 pt-6 pb-8">
      <h1 className="text-2xl font-semibold">Sign in to the fixture workbench</h1>
      <p className="rounded-md bg-accent-soft px-3 py-2 text-sm">
        Fixture identities only (AUTH_MODE=fixture): choose a seeded demo role. There is no password, registration or external account,
        and no role here is a professional, clinical or payer credential. {CASE_NOTICE}
      </p>
      <SignIn />
    </main>
  );
}
