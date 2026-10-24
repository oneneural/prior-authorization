# Security policy

This is a local synthetic-data experiment. It has no production support or
security assurance, and it must not receive real patient information. The
supported deployment is the current TypeScript application on loopback with
fixture identities; there is no public authentication or arbitrary upload flow.

## Report a vulnerability privately

Use the repository's GitHub **Security > Report a vulnerability** option if it
is enabled. If it is unavailable, contact the repository maintainer through an
existing private channel and request a secure reporting destination. No dedicated
security email or response-time commitment is published.

Do not open a public issue or PR containing exploit details, credentials, patient
information, session cookies or private deployment paths. Include the affected
commit, component, impact and minimal reproduction using synthetic inputs.
Redact logs and screenshots. Agree on disclosure with the maintainer before
publishing sensitive details.

## Data and credentials

- Use original synthetic fixtures or explicitly licensed synthetic records only.
  No real PHI, arbitrary real-record uploads or external patient-system access.
- Never commit keys, database URLs with passwords, secret files, local `.env`
  files, session cookies, backups or runtime ledgers. [.env.example](.env.example)
  contains blank configuration references only.
- Use `scripts/init-secrets.sh` for a fresh local deployment. Keep its ignored
  secret directory and the matching database together; do not regenerate keys
  against retained data. Follow [operations](docs/operations.md) for recovery.
- Keep the web listener on loopback. The API checks sessions, case scope and
  mutation origin; fixture identities do not establish clinical credentials.
- Treat document text and model output as untrusted input. Preserve exact source
  validation, tool allowlists and human approval boundaries.

The app's web, API and worker processes share a container and uid. Per-process
credential environments reduce accidental exposure but are not security
sandboxes. See [the credential matrix](docs/operations.md#credential-matrix).
Packaged live Claude is disabled. The separate live evaluator needs explicit
access, reconciled accounting and recorded budget authority.

If a credential is exposed, revoke or rotate it through its issuing system and
notify the maintainer privately. Removing it in a later commit does not remove
it from Git history. Coordinate retained-data recovery and any history repair
separately; do not erase evidence or reset deployments to hide the incident.
