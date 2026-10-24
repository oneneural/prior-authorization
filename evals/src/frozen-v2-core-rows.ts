// SHA-256 pins for the v2 core-row oracle batch: hash data only, in
// the FrozenBatch shape specified in docs/policy-slice.md ("Batch extension
// interface"). It pins the same reviewed pack as the core batch and adds the
// 24 approved core-row fixtures. Changing a pin needs a new, independent
// oracle review.

export const CORE_ROWS_BATCH = {
  batchId: 'policy-v2-core-rows',
  root: 'evals/suites/policy-v2',
  formatVersions: { manifest: 'pa.fixture-manifest.v2', oracle: 'pa.oracle.v3' },
  policyPack: {
    packId: 'lab-k0823-jd-20261018-v2',
    path: 'policy-packs/lab-k0823-jd-20261018-v2.json',
    sha256: '0792ccad775e5b65e9f1e84d5a76321c8ab7a39f6b08c2f0c443bb34ea2a385c',
  },
  policyInputs: [],
  fixtures: {
    F03a: { manifestSha256: '09868f90e652a033b0dd6f8f410375dbc609bc3692dd52f1a564eac32e057706', oracleSha256: 'd46b665ee99405b72cef2376e081dfbf1426795e5294781b913028bcb7b1bb31' },
    F04a: { manifestSha256: '892987b0f16d980153a8e4d1ffc5eb9b929a169dd6e6bb2099a99b6701b4a444', oracleSha256: 'c86121f86f74a4b2949886cd124398d04f8e372d05c54ff8f6652cb43d2fea72' },
    F04b: { manifestSha256: 'c8a62bf3d585646e9ce6a7d81c20bddd19afb44a73474e7b4b392dfb21752aea', oracleSha256: '1201cb7bdb845df7fc441c3dee31c17dbf00df89407795fce7afeda87baca7d2' },
    F05a: { manifestSha256: '71b0375db96e81e531e70a9783d059af2e2a967c47c904932faab4de2a641d58', oracleSha256: '42d1a6d801192b7140bc65d5bed5a558302266f6e62279ca20d1ee33f71dcc0a' },
    F05b: { manifestSha256: 'e7bfa5231ad31a10e4b440472f8073e06756952635ed98f3d1c45e5b3dab15e1', oracleSha256: 'f6d4551dd161a0088ecad622527ccd34bcdafc74b518af0d8746f5a8dc343167' },
    F05c: { manifestSha256: '3ffe91ed5179e683320d465c4113fa2ac9a038fcc84a1c6ddb0797e45e0773ab', oracleSha256: '45e8da0ee47eae5f091bbd00611e996c558524f957fe9e3a0200ea43d6458dbe' },
    F05d: { manifestSha256: '1f9e373b67bd09ce68490e4a81aee9174b1eead0a3108f2badc8d89e143fbe44', oracleSha256: '03af5685247b65cae70f386d4cb2a46dedcb0b540d8d88f3101ebb0230bc215c' },
    F07a: { manifestSha256: 'd9bcbc9f1b604f7764fdd76578dde0471a59a432e13c33a018f52b85141bce82', oracleSha256: '66fe02dddd5ea4e125bdd28cbc476c956557b56724d395df45f8537d3eb42fae' },
    F07b: { manifestSha256: 'ed550621d70aa846d635ee53549857fbd655311ccbfcc77d5eade0424ac37652', oracleSha256: 'cc0f85ddf39c910f9df11687d422f9200c26bd54f8ddcda708a533e13ca3a945' },
    F07c: { manifestSha256: 'a99c28f2e619af31c3914c7e490eefe7ab3e2fbc0d82dfa07fc0a89d7868d7e5', oracleSha256: '4fc6f8acc0ba18b17da544bf2cf80649d03ec5875b7ef09d749d02a0a75a5969' },
    F07d: { manifestSha256: '27821f8af1c1b73da88043bd2194e2b36935e99bd30590cdb78537270f111550', oracleSha256: 'c8bb33789a82b44e966fc2596ffff60174b0147a00adbf67910ec51a1d55e15d' },
    F07e: { manifestSha256: '1450faef40217a1b0b570c9a3f92420b2b840fab10134da18ecd9821e10c0d87', oracleSha256: '636f3ef448c9ded154c2686ff3ef2e582e37a56439410686c41ced86652a4344' },
    F07f: { manifestSha256: '5abf1d6c623a73e121c8a5058f0a282bf9ca5d549562a4d4f23cf14fac167be6', oracleSha256: 'e711586dcc9b7a7555fa656854bfc3342921f3914e606236b92780a535bf7b0a' },
    F07g: { manifestSha256: 'bdb83474c02b82c99b4e687a48ed7d2feedae4563ccbdd29a2f726f4dc14de3d', oracleSha256: 'bfd95a9e09f9bfb465b2102cd65260a7d1e4500c8e7d552164e98f5075e022bf' },
    F07h: { manifestSha256: '3a0799967c8a2403e12e3030fb1e7b68bd8838441932c0a30e9932d69bda74e9', oracleSha256: '4be65f45267183dcf110c57c0343fe94a5e54baee58a13b7648cb0fc9ec4191c' },
    F07i: { manifestSha256: 'd25ac863d83cb113a2d9a54613674b063f87c3097917374c04d6e6c99da513d2', oracleSha256: 'fb7406a927c3a4463d1cff7b36b7390def4878a6a8778e5ae4fa3db4ba01214a' },
    F07j: { manifestSha256: 'a7333b27ae55d13d17420b209d14eac5bbf99d8e2a9d54d28cfefa85c8224124', oracleSha256: '2e2265c126e8a12ebecd9d263c596f8c939ade0705e948f0dee4098922e408b9' },
    F14a: { manifestSha256: 'ab0adf6c64aa23029e74fc5ec63c910ab32e438b414679ebb9eae7c2465cc4ce', oracleSha256: '79a3f507f19d3454c94e3e2fe8e577f5e68cc12e32011ab0a8be7e2bfc38922a' },
    F16a: { manifestSha256: '44d2e8010b34abd4d744d725765f172cb9edca45925ce820c4fbd7b5e4775479', oracleSha256: '2499a95bc6bc1a6509ea93ff8bc36db9a70bfd5da18202c8ee8c7f6c071c872d' },
    F16b: { manifestSha256: '05ac193aec0040a3383e3e2a2733b5694e27a6ca1058fd2c6389ae9b609e03cf', oracleSha256: '670afa247bbcbeb069f9db22e8d29b719e95255988b7b885079b87d51258d122' },
    F16c: { manifestSha256: '528e79349d5a74bca99b1e130fe33bb3bf531979a77eb2fb42fd432ea581f2aa', oracleSha256: '61f09ddcf808bab1c27883594ec9eaaee58b2372f20c5ec8b28ecd803172375a' },
    F16d: { manifestSha256: '6db287d0e469829cdd98b92e324019e6267cb09684f98c4ff89024b456d6d244', oracleSha256: '4d4c27bba9e6ff2d036d53961d8bd8e7449553f9814814c3e2228f9436e2dd31' },
    F16e: { manifestSha256: 'b2412b345fdc3428bbe81bb4c8e9a38ea98ff64fed5e846c26ddff0c8b9a3457', oracleSha256: 'a4a022d443791406a5c0f5215b1b857bd5c3de1da985016a5a54c307ddac0fb2' },
    F16f: { manifestSha256: 'aabf24505c0027b31370f490691ffc6ae31ba30d41fad5c1b54ccc506d695f4f', oracleSha256: '4e1830bf4c1c8fd25ea9a964c9b508ff19fda8f9e3c66d8372f29a79add9fb03' },
  },
} as const;
