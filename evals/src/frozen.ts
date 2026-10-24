// SHA-256 of the frozen first-slice oracles and the policy pack they depend on,
// frozen on 2026-10-19 from the reviewed Git blobs. The harness refuses to
// compare against bytes that differ. Changing this table needs a new,
// independent oracle review.

export const FROZEN_POLICY_PACK = {
  packId: 'lab-k0823-jd-20261018-v1',
  sha256: '0e88bb0b756be1eab93cd38f2ac17841ab0eeb807f12de042cc3da722cb1fc48',
} as const;

export const FROZEN_ORACLES: Readonly<Record<string, string>> = {
  F01: 'a04f29c8c136bacd751b6ffe0b662fc4ad385631709e3347c430a9f4b249ad11',
  F02: '3f4bb634c337cdde753bb079eb6476d26a3b44988683ba2250871221c6117f8d',
  F06: '72f28624e97c00378e8e9d684986944854b29e9363b1dc57498b2b6860c9dfc2',
  F08a: '18fd6099de11be5bc263d2c4490669dcd73ac9336cb1a4a2b4791c481e48196b',
  F08b: '51465853b508155c9bac495d05d2e99736b15c3bac1ae74e2b594b6560b9b279',
  F22: 'c3e2b031b3d058358e1486a4202cfe6fe10c5ecd6ce65b69cfe8e88460dd10a4',
  F23: '65ba1c9c4fed0f5c26c80cd78ddbd228e960f03459f74e990b1170fcce452412',
  F25: '1fe49231290324113c4b3367b8d643594cc295543b518518ff922f41c216b7b7',
};
