// SHA-256 pins for the v2 version decision oracle batch: hash data
// only, in the FrozenBatch shape specified in docs/policy-slice.md ("Batch
// extension interface"). It pins the same reviewed pack as the core batch and
// adds the 16 approved Part B fixtures. Changing a pin needs a new, independent
// oracle review.

export const VERSION_DECISIONS_BATCH = {
  batchId: 'policy-v2-version-decisions',
  root: 'evals/suites/policy-v2',
  formatVersions: { manifest: 'pa.fixture-manifest.v2', oracle: 'pa.oracle.v3' },
  policyPack: {
    packId: 'lab-k0823-jd-20261018-v2',
    path: 'policy-packs/lab-k0823-jd-20261018-v2.json',
    sha256: '0792ccad775e5b65e9f1e84d5a76321c8ab7a39f6b08c2f0c443bb34ea2a385c',
  },
  policyInputs: [],
  fixtures: {
    F08x1: { manifestSha256: '7f212038844bd0a0f9975c28b1773d400f93d6809bf4791bed9d7b589acd8eb1', oracleSha256: '15f10e198218ce67deed505f8c51cbeaec59bfe15eafef892d55427ab1469210' },
    F08x2: { manifestSha256: '5ef49b45cb1f471c6d0e5aaf90a7eddf78b2e6747bd51b6119f7f911c4e90b78', oracleSha256: '2edcb862ae97ee911a0d385a3796247fd08a4d5e8ee35b279b2ccdfce5619265' },
    F08x4: { manifestSha256: '134160097035b35f33faea66f98b715bebee97aa7a7144e37092117b05dd24a0', oracleSha256: '2438637ed5353b765da86433486dcfa07d15e85ab950b0fab256bfd706784535' },
    F10x1: { manifestSha256: '1367024b8645f0bbcb2c5b34dcb9825282699e4c8a8a4060eb579e05fdd1e736', oracleSha256: '25e94bb163aab4d5bb07c08ad0ac1c0791f615b1da3ff622e65a63336347c89b' },
    F10x2: { manifestSha256: '3d9ec86924d4d38560bfc0aa7f795221d8936a1ab6cdcf8a6688b3c151bae14e', oracleSha256: 'd8aabe3a2f4546ac71aa89c9e6565d9de003fc91665a9c5f46866fb64fe34eb1' },
    F13x1: { manifestSha256: '70ef009c071f2eff9191a3bf2563ceb99ecee5480a4129fe4daff7d42f2f918f', oracleSha256: '18bfe4fcff75b6a91a6532ba21cc41aaf0da0bdd3af05747c4602652f49d5e44' },
    F13x2: { manifestSha256: '827a7c17fb5dba09d14c1976e604ed4495e96482399d5b43ddac7ba119c9521a', oracleSha256: 'fdada145d20aa12477e4c5ee208428c9d8345ce3b5b14ae6ab7d4c0ccd7f2faf' },
    F13x3: { manifestSha256: 'd6430d2671bb79d194289565654c75a944ae0dd946dc8cf8b079f381ab2f0530', oracleSha256: '6c997e685e0bbe2f4dd49c800506fd8b18b6e51375be8c0a5cda239e194c81c6' },
    F13x4: { manifestSha256: '9051612b71ffd7dc5ae77539693a0c8c61a1add0cc36033703ccea83bbac19db', oracleSha256: 'dab953be187330117742d9c3dfcd6434ebbd5ebd5cfa53eb6f74b113b4992ca2' },
    F13x5: { manifestSha256: '8a66ed67b764e6cf0ed024e0fd8b3f7296880e84bad0dba13555d13a8021e54c', oracleSha256: 'df576ae87e883a214582cd88a977fb3acbf16f0840cc3fd7e935a68dce7f2c2e' },
    F13x6: { manifestSha256: 'f1007fcee643451bc8d8b1d7248d0d6976693d6d9fe1c65ca8b55fe364e65180', oracleSha256: '957e960ab3bde7fc71a481efcc8c98ddacc70aa99b115ce055e86fc7de7a8878' },
    F13x7: { manifestSha256: 'eede0ab8fb2d8bcc567f497d8ef4e2b70070972aa40606f78d4889e5c25353d5', oracleSha256: '2fd3aab484ad1b048188a2ae98b3a1ad00e1991e7383f88a636ff5d4c5a4009c' },
    F13x8: { manifestSha256: '30d4be6d09f94034b680ec3d4f081a83fd36749a3a4c63f934b722e7391ac741', oracleSha256: 'cc9292345e390ea83f963b671ff0b7364cb57c59d4fe37123c3d1cdefc156b31' },
    F13x9: { manifestSha256: '1b8288c73796de456dea2af973a29b782f76abac426ab12a86cc015915dda2b6', oracleSha256: '3416a9eb1fc3301126215584a2e53d9a13d2bbf1fbe6b5e06501997c462b35b6' },
    F13x10: { manifestSha256: 'fec2f5797b6127a989cd7ad43135fca67b5a024bb4bf9cac8926d0527b3c4d62', oracleSha256: 'c2a301b60642b84d82523007eae9715bc387e59d5a2158515a9d92000bf92a12' },
    F13x11: { manifestSha256: 'fb7327c1cdf5b0eb26b361cef73ff7d2ccca056b6c7cd037aca2a755502b7a06', oracleSha256: '1cfd1fee1902ff0e1dba76506eb2157cf77b8996e990813788cfa0027f81b3c2' },
  },
} as const;
