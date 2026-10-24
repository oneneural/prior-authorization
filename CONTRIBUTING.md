# Contributing

This project explores administrative evidence readiness using synthetic cases.
Read [the README](README.md), [SPEC.md](SPEC.md) and
[ARCHITECTURE.md](ARCHITECTURE.md) before proposing a behavior change.
[AGENTS.md](AGENTS.md) is the instruction guide for coding agents and records
the project's engineering and healthcare boundaries.

## Set up locally

Use Node **24.22.0** and pnpm **12.14.0** for source development. Docker with
Compose is needed for integration/container checks and the packaged demo.
From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm test:evals
pnpm test:oracles:v2
```

Typecheck must precede lint on a fresh clone because it generates Next route
types. These offline checks need no provider key. Use the
[development guide](docs/development.md) for the disposable test database,
build, web and container checks, and [the demo](docs/demo.md) to inspect the
packaged workflow. There is no root development-server or formatting script.

## Make a focused change

Inspect Git status first and preserve unrelated work. Keep changes within the
agreed scope and stage only the files you changed. Put pure rules in
`packages/domain`, API authority in `apps/api`, and UI presentation in `apps/web`.
Preserve import boundaries, source provenance, immutable document versions and
revision-bound human decisions. Use the exact dependency pins and pnpm lockfile.

Use only original or explicitly licensed synthetic data. Never add real patient
records, keys, local environment files, build output or runtime state. Do not
generate orders, medical notes, diagnoses, signatures or medical necessity
statements. Request existing finalized documents neutrally. See
[SECURITY.md](SECURITY.md) for reporting and secret handling.

Policy or scope changes need SPEC/ADR review, sourced justification, independent
expected outcomes and fresh verification. Keep model proposals separate from
deterministic findings and human authority. Do not claim clinical validity,
customer savings, payer connectivity or production readiness without evidence.

## Verify and describe the result

Run checks appropriate to the changed behavior, including failure/recovery and
stale-input handling where relevant. The [check reference](docs/development.md#checks)
explains prerequisites and coverage. Preserve frozen oracles; expected outcomes
must not be derived from the implementation being tested.

For documentation-only changes, verify links, commands, formatting and preserved
contents. Report those as documentation checks. For UI changes, distinguish
HTTP/build checks from actual browser and accessibility inspection. Paid
evaluation is separately authorized and budgeted, never a default test step.

Use the [pull request template](.github/pull_request_template.md). Lead with the
problem and resulting behavior; include scope, any linked issue, exact
tested revision, commands/outcomes, evidence links and unrun gates or remaining
limitations. Independent review and final-revision verification are required
before merge.

## Naming and writing conventions

- Commits and PR titles use `type(scope): summary`, with optional scope, a
  lowercase imperative summary and no trailing period.
- Supported types are `feat`, `fix`, `content`, `docs`, `style`, `refactor`,
  `perf`, `test` and `chore`. Use branches such as `docs/improve-setup` or
  `fix/stale-approval-check`, without tool or agent prefixes.
- Do not add AI attribution, co-author trailers, generated-by notices or
  assistant signatures to commits, PRs or review comments.
- Write plain prose with sentence-case headings and GitHub-flavored Markdown.
  Use descriptive relative links, language-tagged fences and blank lines around
  lists and tables. Do not use em dashes.

## License

The project is available under the [MIT license](LICENSE), copyright (c) 2026
Subodh Jena. Preserve third-party notices and source citations in contributions.
