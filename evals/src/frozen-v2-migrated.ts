// SHA-256 pins for the v2 migrated scenarios and decision regressions:
// hash data only, in the FrozenBatch shape specified in
// docs/policy-slice.md ("Batch extension interface"). It pins the same reviewed
// pack as the core batch and adds the eight migrated originals and the Part A
// decision regressions. Changing a pin needs a new, independent oracle review.

export const MIGRATED_DECISIONS_BATCH = {
  batchId: 'policy-v2-migrated-decisions',
  root: 'evals/suites/policy-v2',
  formatVersions: { manifest: 'pa.fixture-manifest.v2', oracle: 'pa.oracle.v3' },
  policyPack: {
    packId: 'lab-k0823-jd-20261018-v2',
    path: 'policy-packs/lab-k0823-jd-20261018-v2.json',
    sha256: '0792ccad775e5b65e9f1e84d5a76321c8ab7a39f6b08c2f0c443bb34ea2a385c',
  },
  policyInputs: [],
  fixtures: {
    F01: { manifestSha256: '867f4ee978aabef801e5f565c9038118b5ebb71602ae8b9ea0cb51093f676879', oracleSha256: '3cf5f1a59f4b432dc5ad6e17d849336c80bb1584b0ee2deaea4acc4038a521e4' },
    F02: { manifestSha256: 'e923aac006e87994affb00af0ce5a6aebe5a83b5a7382d23a9f5adb919e30801', oracleSha256: 'db1d402c2eb6b2b5601f9931e0b4c1bcf8fad504a4e4516ae6acc33d2731a4ea' },
    F06: { manifestSha256: '2b763e59234020dd607cb9ecc4d2ed223b2e62146fa7d7d3f7d58cb805a86f19', oracleSha256: 'ee2ed9afa3fe6b3b714cf521e9c99887476086cd9b6773820909c84c42691141' },
    F08a: { manifestSha256: '1bd2ec9b63c6499a599e49a4b35f3fab5a722433c962bbf87b2834e6c0b9b0d8', oracleSha256: '7766c879e7d4110bce2dbdb24b480ff50e804ad5ac8199040f8b81c566c0497e' },
    F08b: { manifestSha256: 'd794aea65950c4465100d91341ead1cb82644383a08017ba6cc86ab7fa89c480', oracleSha256: 'd69bab62c6ee47920b5dafcc0cb2a7840b32bb856abf4910c6fe148ade6c1c59' },
    F22: { manifestSha256: '39695ba4743fa9d399dcf3f533f8d82bf2ee3e7edf8ef1f51901cb24a523b9a8', oracleSha256: 'e83c8e2f717e87242937211bedf6ffa3a7cc95d214c2a967199929977d205cfa' },
    F23: { manifestSha256: 'f4646c5de25b6b0ced633b612a10b1f181f56d8049ee8c758ad37f9cda7ef108', oracleSha256: '618a2a8111b35035721e660b80a07fc1a7b7c4dbc8082e246f8cc1b1692a57a7' },
    F25: { manifestSha256: '0b078b4aed76ed606fff8d796655375130d524557fac8fcf69fae3047bb8061c', oracleSha256: '18f3c907c3743837df073e1c4eb709a3ac42a02a2e902f73b3102715364869fb' },
    F01x1: { manifestSha256: 'e909c93a80ae592029a1a260a987543e943fd3aec4f6250f593431d5375adc5d', oracleSha256: 'a6750c282d31a8e354c732cdbdc8dd337687d9412d9424be157a26481a71f5de' },
    F01x2: { manifestSha256: '7331739383e503e18f931468c978b70420fa7d99c049e43aecc248eeda42d3a2', oracleSha256: '075c5bcec3a3ae27435f80dd84e9913c32d4f50ce7508fff0d74fea6aa58cd39' },
    F01x3: { manifestSha256: 'a4b626f639f8cd27d458e02f06e32575e78739c293800f8c5de177515f45c0e6', oracleSha256: '9b0b32ab77dc2ff7c458f8efd4061f19ba384c857fb131738e8088ae4fa1c6dc' },
    F25x1: { manifestSha256: 'f397cf99ef38fc8ce65951e43cfe455e3ab4f54b31d650a25622582d8508c8e1', oracleSha256: '8741e2d97872bf5983dd445d2c2323914219b06186f35ddabcd5e4b3c5f16d3f' },
    F25x2: { manifestSha256: '74b3b4243ca038de4f57879a359b80f2435d38877aa7413d719d7b16320a9801', oracleSha256: '2fb882c6c289e8aa85a134a4ad505b64a29ef1b68fce54d1705a4636ed239cff' },
    F08x3: { manifestSha256: 'f08bbe8085074541a2599e3adce6ec2d23eb6f2b784b250be4d1539b32ab0fb2', oracleSha256: '709dc6b24900db26801fe5ee393c315ed01c61dc2a95a6472d0704b33da5d90f' },
    F14x1: { manifestSha256: 'b98adbb4e44249e73b1aa502548e9e3fd43c822d271543efe318f74744f3787e', oracleSha256: 'a6a236bee4b46f5aa1589a3e21720d5947e572b8edb939ab2b3583ab23cbc840' },
    F14x2: { manifestSha256: '488470b2e1c642b9e876be7226c7575d4fd3334fa200b64565d5bacd80fa405b', oracleSha256: 'ddd0d5a4bae0c664fb45b111436e970c24f2f5fba10c65f501e6093a47cf5f22' },
    F03x1: { manifestSha256: '9dd62a60fae4a56d32a0473ae3d77e5f4aa6406fb15639e231a590d61f241b80', oracleSha256: '5538e02de175a0dabf37117663f30d66d526be2c89827749c91c959f522c20e3' },
    F03x2: { manifestSha256: '18a308f69f19d7ce99385cf80aa479d9e1dfc124be16699360b3cf78384fb8e6', oracleSha256: '9e7a4537762d53527e9b8683d72399c50f6b43b7c71425e644ec063573fe674d' },
    F14x3: { manifestSha256: '86f0defbc2847c1ca122fa02b965af151a5f0e52248b0da240d44f8832653af3', oracleSha256: '27b47a7b9df2270e6350ad6c2b6fe44b41dadb4d6e4ccca473d197d7b9225119' },
    F26x1: { manifestSha256: 'd046e182a405296b8296a85b39aef9a191d330812c05e3d9f4a4b1ecb70007c1', oracleSha256: '13fc524bfe42c2c4528ad9f137c9cbd03f790183ab080842d4f98c77a35d9eeb' },
    F26x2: { manifestSha256: 'b368f2a26b854c6262bb5757378b5c4911315ff4b6f75bb67f4f555d395cf0b6', oracleSha256: '49deb6fa54d49ab5566852997581d63b1f1ceec4bfb75f94528f4a1c0def342a' },
  },
} as const;
