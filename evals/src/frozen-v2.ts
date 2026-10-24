// SHA-256 pins for the v2 core batch: hash data only, in the
// FrozenBatch shape specified in docs/policy-slice.md ("Batch extension
// interface"). The candidate pack and the F15 negative policy input are pinned
// here so that any byte change fails a gate. Fixtures are pinned by the other
// batch tables. Changing a pin needs a new, independent oracle review.

export const CORE_BATCH = {
  batchId: 'policy-v2-core',
  root: 'evals/suites/policy-v2',
  formatVersions: { manifest: 'pa.fixture-manifest.v2', oracle: 'pa.oracle.v3' },
  policyPack: {
    packId: 'lab-k0823-jd-20261018-v2',
    path: 'policy-packs/lab-k0823-jd-20261018-v2.json',
    sha256: '0792ccad775e5b65e9f1e84d5a76321c8ab7a39f6b08c2f0c443bb34ea2a385c',
  },
  policyInputs: [
    {
      packId: 'lab-k0823-jd-20261018-v2-unreviewed',
      path: 'evals/suites/policy-v2/policy-inputs/lab-k0823-jd-20261018-unreviewed.json',
      sha256: '71249e79af2e9df81b912bcf3020ebbd683be5080dc412789a1747d8a44827b6',
    },
  ],
  fixtures: {},
} as const;
