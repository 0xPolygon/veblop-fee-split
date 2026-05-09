import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config/env';

const REQUIRED_ENV = {
  ETHEREUM_RPC_URL: 'https://ethereum.local',
  POLYGON_RPC_URL: 'https://polygon.local',
  HEIMDALL_RPC_URL: 'https://heimdall.local',
};

function withEnv(overrides: Record<string, string>, fn: () => void): void {
  const keys = new Set([...Object.keys(REQUIRED_ENV), ...Object.keys(overrides)]);
  const previousValues = new Map<string, string | undefined>();

  for (const key of keys) {
    previousValues.set(key, process.env[key]);
  }

  try {
    Object.assign(process.env, REQUIRED_ENV, overrides);
    fn();
  } finally {
    for (const [key, value] of previousValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('getConfig rejects malformed fee-split fraction values at startup', () => {
  const cases: Array<[string, string, RegExp]> = [
    [
      'BLOCK_PRODUCER_COMMISSION',
      'abc',
      /BLOCK_PRODUCER_COMMISSION must be a finite number/,
    ],
    [
      'STAKERS_FEE_RATE',
      ' ',
      /STAKERS_FEE_RATE must be a finite number/,
    ],
    [
      'EQUALITY_FACTOR',
      '0.5abc',
      /EQUALITY_FACTOR must be a finite number/,
    ],
    [
      'EQUALITY_FACTOR',
      'Infinity',
      /EQUALITY_FACTOR must be a finite number/,
    ],
  ];

  for (const [name, value, expectedError] of cases) {
    withEnv({ [name]: value }, () => {
      assert.throws(() => getConfig(), expectedError);
    });
  }
});

test('getConfig accepts finite fee-split fraction values', () => {
  withEnv(
    {
      BLOCK_PRODUCER_COMMISSION: '0.26',
      STAKERS_FEE_RATE: '0.5',
      EQUALITY_FACTOR: '0.75',
    },
    () => {
      const config = getConfig();
      assert.equal(config.blockProducerCommission, 0.26);
      assert.equal(config.stakersFeeRate, 0.5);
      assert.equal(config.equalityFactor, 0.75);
    }
  );
});
