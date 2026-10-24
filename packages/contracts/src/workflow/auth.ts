import { z } from 'zod';

/** Seeded fixture identities. Selecting one is a fixture-mode shortcut, never a credential check. */
export const FixtureUserKey = z.enum(['operator', 'reviewer', 'outsider']);
export type FixtureUserKey = z.infer<typeof FixtureUserKey>;
export const FixtureSignInRequest = z.strictObject({ user: FixtureUserKey });

/** Demo roles. Neither is a clinical, payer or professional credential. */
export const ActorRole = z.enum(['fixture_operator', 'fixture_administrative_reviewer']);
export type ActorRole = z.infer<typeof ActorRole>;
export const ACTOR_ROLE_LABELS: Record<ActorRole, string> = {
  fixture_operator: 'Fixture operator (demo role)',
  fixture_administrative_reviewer: 'Fixture administrative reviewer (demo role, not a clinical credential)',
};

export const SessionActor = z.strictObject({ userId: z.string(), name: z.string(), role: ActorRole, teamId: z.string() });
export type SessionActor = z.infer<typeof SessionActor>;
export const SessionView = z.strictObject({ authMode: z.literal('fixture'), actor: SessionActor });
export type SessionView = z.infer<typeof SessionView>;

/** One sanitized durable case event on the scoped SSE stream; the SSE id is `sequence`. */
export const CaseEventFrame = z.strictObject({
  sequence: z.int().positive(), type: z.string(), actor: z.string(), inputRevision: z.int().positive(), occurredAt: z.string(),
});
export type CaseEventFrame = z.infer<typeof CaseEventFrame>;
