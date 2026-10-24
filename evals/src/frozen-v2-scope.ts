// SHA-256 pins for the v2 scope oracle batch: hash data only, in the
// FrozenBatch shape specified in docs/policy-slice.md ("Batch extension
// interface"). It pins the same reviewed pack as the core batch, reuses the
// frozen F15 negative policy input pin and adds the 20 approved scope fixtures
// Changing a pin needs a new, independent oracle review.

export const SCOPE_BATCH = {
  batchId: 'policy-v2-scope',
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
  fixtures: {
    F09a: { manifestSha256: 'fdc4f0dcaf5b6d875f11fb5b05322f05ba73599115a18c13e0beb3d689b1d32c', oracleSha256: '253d4a442c96d3466851a032a038fe5b2d52afaf89322e0db6486255323477d0' },
    F09b: { manifestSha256: 'af2d4555f1d6f838ebc77308b869a2b846cdaf593606acd2ddc7e8624f4f2c06', oracleSha256: '21a6043299301d9435e9384b69aa96f97e525f73ffa710e722e06ad4bc23d597' },
    F09c: { manifestSha256: '01c94278104cf89e9b8680d13b82d68dd43b65957a6e965262575f0afc8b37c1', oracleSha256: '986ba28e34b4d3903ff1453b7c21f176f076219a2f728ef93ba737ca46133d8e' },
    F09d: { manifestSha256: 'c0d11a45a72a258982b6b894faadf9e9ca28a18628004aebb0b7bd035af59deb', oracleSha256: 'bb848565fa1919af60389c7e5b9abc93532dc639077dda7c515b7b167445148a' },
    F10a: { manifestSha256: '907aa634edc40255088ff320872aced1d7316345b84f5db95b7610e1ffa88b49', oracleSha256: 'b9fcd2307efe1a843b33f07393d0298d7d74918586e77cd33017da78ad1c9420' },
    F10b: { manifestSha256: 'aed6baac53ee177173913c996830bfe535b9411c6a6eaf3a36fd5f98812abe76', oracleSha256: 'd470634e0fefb2c9d4598899d9706a502210c9d493adf642cc61385b5e707e22' },
    F10c: { manifestSha256: '3965b51b18f27ca4907e62aaf1cb1d02ac203e638ffb2a7b7ef5e9d7936f1799', oracleSha256: '7b20a57f2d5550958a6abdbcf57381387c97e66e51931d270592ac5f1ad71034' },
    F10d: { manifestSha256: '94d9e5e9db348858e66da10993286bea91bfd0a53a81582d1344f10c70b3deff', oracleSha256: '453efae5520937f2447e4dbddce604660eca7247810c0363f20f3bee89361d0b' },
    F10e: { manifestSha256: '36c910f2e1a5aae1cd58b622f10ceb5b82677ee2fb88ee21b7b40d31e44f3b13', oracleSha256: 'a46bcf278fbcbfa92e0a52de7b8195e5579e3ff36923665f90abbebb574b78d2' },
    F10f: { manifestSha256: 'ffd88ebc05e5abf6093a78df9d7496ec39fc57ff119c6333da645e9425b75ebc', oracleSha256: '229014c8df85291c8ea8b929a5ea3ebabe05be44c414801ae17b3d612fc2513e' },
    F11a: { manifestSha256: '02dbc3f869c1c17da3906095f939793330ade9f2cd8d87cf9922e92f4f8413f1', oracleSha256: 'dad201005f6d3ddf2a588d4659d239b58e51457aa651f56c995c7fc096caf8d5' },
    F11b: { manifestSha256: '4087a9ec32ff8d27ad4e22e4f270b4e7a57190a540f7f5b82be5147ce057c16a', oracleSha256: '682beafc8cfc3011ed8988bc94676f7662d5670d9d3ce0b7c9efd485925f7e9f' },
    F11c: { manifestSha256: '28408ecfdd60c9eb1ec34b8b5d43f29fd08fc0530f02c4e7d2e59889978be096', oracleSha256: '746ed388492d5697fe780566229345dd55205a7ab56af7a85d2340db4ca0e448' },
    F11d: { manifestSha256: '952fc9b32a219a7145cb69dbaa3f6f95ccde8c9423e0e95f8895884a4fb8035f', oracleSha256: '7d3cb34ad246268097b49bd7724a76115e9afb79908297ece5d009d6f3acc079' },
    F11e: { manifestSha256: 'e2a65ba39e9f206b5cf3f9c167670d374258d572c2d172a1f42599b5650f6e75', oracleSha256: '6245296df22c0f682aa7e0dff1f2c5e162d5d3141e841033c7ae0bbee121f063' },
    F11f: { manifestSha256: 'f1a7285fd24ea3d726676c791291187214f5b39f9a07e7c7c8d4be297ff1c45f', oracleSha256: 'c921bb14239e441de91a92376289d634c2ee3bfde5779566b3a316a1de4043b3' },
    F15a: { manifestSha256: '8267deea47762dd390f7bca6a0c87e6c066a40d8293bdbaabf3f19558f39e18b', oracleSha256: '31bb7dd7044d57459adc407de9aff175500e76a3863801a1e3690a635acb41fd' },
    F15b: { manifestSha256: '79acc96fab6c0ed740f18664c02a8a46c0d5f6a4a3d292c6738c337ae531442d', oracleSha256: 'b40463a193d206ceaa3fb85fd7dd3bdb06e50907b27a4428c83e359f27fb4aab' },
    F16g: { manifestSha256: '74c3654b73ffe0c9c3639fe47daf9a42d15d1ec52ade38d88d74715725597ea2', oracleSha256: '60ff65f9cdbac7c827b21851da2a73e991176f3160f2653b32172f54f83f16e4' },
    F28a: { manifestSha256: '4749c70d08f3a81547809ecd45f35e6e79318cf84208c575335fc61b3cc9a6eb', oracleSha256: 'ac4624231f850290a8e8228819f15f9e9587c26c3103d19803f6300066e0335b' },
  },
} as const;
