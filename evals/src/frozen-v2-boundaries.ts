// SHA-256 pins for the v2 receipt and loader-boundary oracle batch:
// hash data only, in the FrozenBatch shape specified in docs/policy-slice.md
// ("Batch extension interface"). It pins the same reviewed pack as the core
// batch and adds the 14 approved receipt and loader-boundary fixtures.
// Changing a pin needs a new, independent oracle review.

export const BOUNDARY_BATCH = {
  batchId: 'policy-v2-boundaries',
  root: 'evals/suites/policy-v2',
  formatVersions: { manifest: 'pa.fixture-manifest.v2', oracle: 'pa.oracle.v3' },
  policyPack: {
    packId: 'lab-k0823-jd-20261018-v2',
    path: 'policy-packs/lab-k0823-jd-20261018-v2.json',
    sha256: '0792ccad775e5b65e9f1e84d5a76321c8ab7a39f6b08c2f0c443bb34ea2a385c',
  },
  policyInputs: [],
  fixtures: {
    F26a: { manifestSha256: 'e55f3ba7d4592fa15d5ed17d6b7a3badad73d21896de80dab689c6b625faae00', oracleSha256: '6c11811f97422d540f8050ba3667e19374bae6b7df69af216fd39758730fbf6d' },
    F26b: { manifestSha256: '9e1c088d426efc15dbd39820773d8dd20dd38954841c48cdbd143126b8047236', oracleSha256: '6a46e78943f634c681798ebd0045665da622184a8fae455277d66c3b5f07252a' },
    F26c: { manifestSha256: '7f79c41e70782e0cf744b04b69c3ba2453cacf0a90aaf9d73f7d791d5a666296', oracleSha256: '5625800b09b99a5241081abc0645306703bf2a3625947a4e2c3e27ef6f6ed522' },
    F26d: { manifestSha256: '6f144b917014e86aca24e64b6fa7b944a1c563f81dc45278eb0ea6a79a015649', oracleSha256: '5b415e90081b2dc7fe41378e06e78053335b2414892a13c58e4b974bccf0b50b' },
    F26e: { manifestSha256: '5f6a4f8eaaf2d512fe6aec6034f6cf73bdef2b83537c60d31253c54c82a4c4af', oracleSha256: 'c75ab09799bc74694833ae56d78e7a0e42548c642d9dc84aa30713bf2a24e028' },
    F26f: { manifestSha256: '22d7c5e47a5500ed7414e42f1994c38a615059c61ee2ab52a4d1e2010ef4b30b', oracleSha256: '5acc40806c0d7551a13f165c95d92e85c2eef66f0cb9df78ca8eaa205f019ea3' },
    F26g: { manifestSha256: '9b9dcde0d2b87c665340aa72f700d1196d0587cd138a8dd2f7ef69cdfebcff1e', oracleSha256: 'c82f5902cae5c04a301a808094045bf3363e8f260b3504bc9f5e8202108c89f2' },
    F26h: { manifestSha256: '5695615b169e90071414fa7b74159b01eb35f4772f5b35e50ee2960a1b8eb805', oracleSha256: 'a698d93a0c97ddc1d6a717975537c6950e59fae2fd24748b1f375703ec220c9c' },
    F26i: { manifestSha256: 'db885ea04054279c0d55d75216a74a34e37c6b0703f1623f3f7a92bdbd76e30f', oracleSha256: 'd17089dc6e369d0cd11e80f517705b2bc8023480aaa1a103260c8febf0be9e7b' },
    F26j: { manifestSha256: '88147a574cc8a8140179ef788157b59bba5fdbda8053b2dfc8681c78775bc4b8', oracleSha256: 'bed7bcfd96a3deab977de002424212b7b2df072f78d636b21eda9625e98e04ea' },
    F26k: { manifestSha256: '154e54562dfb33ca99677f830fbde3ac78af3cf05316c9481f23f949d74bfd25', oracleSha256: '1e1582eea7bca897d6ed6979efc34af2aaf4bc1b9680b1232b03c6040497590d' },
    F26l: { manifestSha256: '23ea1692417c389f986bdf20888f2aa37eefdf84bcf3ba35756ea50dbda0d4e0', oracleSha256: 'ef403d0f8c39f47c063049f41ae49b9ade4085b2439bbaacdbba4fefdc8b8aff' },
    F26m: { manifestSha256: '1b03163e5993ccc3811e99db3ea576104acfdc1f42f8bb99fe8ebf931d20bb50', oracleSha256: '61cc87f7df3c8cbdf977a6b690b5a6bc1620071897d6cc0c77b86df27dd4d3d8' },
    F26n: { manifestSha256: '3e7721fec3842bbc6897594b21ed55bcd62f3c56152a858995dba5b4c4417fd9', oracleSha256: '66074665b1c52c42c390de78455f2ad923e962a1b9113c5a30d0e8bd1e5c7b91' },
  },
} as const;
