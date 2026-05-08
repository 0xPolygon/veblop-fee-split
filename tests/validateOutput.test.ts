import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateOutputFiles } from '../src/utils/validateOutput';

function makeDetailedReport() {
  return {
    metadata: {
      startPolygonBlock: 1,
      endPolygonBlock: 2,
      blockProducerCommission: 0.26,
      stakersFeeRate: 0.5,
      equalityFactor: 0.75,
      totalIntervals: 1,
      generatedAt: '2026-05-08T00:00:00.000Z',
    },
    summary: {
      totalFeesCollected: '100.0',
      totalPostCommissionPool: '74.0',
      totalStakersPool: '37.0',
      totalValidatorPool: '37.0',
      totalStakeWeightedValidatorPool: '9.25',
      totalEqualValidatorPool: '27.75',
      totalEqualValidatorPoolDistributed: '20.8125',
      totalEqualPoolBurn: '6.9375',
      validatorCount: 2,
    },
    intervals: [
      {
        intervalNumber: 0,
        startTimestamp: 100,
        endTimestamp: 200,
        feesCollected: '100.0',
        postCommissionPoolFees: '74.0',
        stakersPoolFees: '37.0',
        validatorPoolFees: '37.0',
        stakeWeightedValidatorPoolFees: '9.25',
        equalValidatorPoolFees: '27.75',
        equalValidatorPoolDistributedFees: '20.8125',
        equalPoolBurnFees: '6.9375',
        perfectPerformance: '10',
        rewardedValidatorCount: 2,
        validators: {
          '1': {
            stakeAtStart: '10.0',
            performanceDelta: '10',
            stakeWeightedFeesAllocated: '4.625',
            equalFeesAllocated: '13.875',
            feesAllocated: '18.5',
          },
          '2': {
            stakeAtStart: '20.0',
            performanceDelta: '5',
            stakeWeightedFeesAllocated: '4.625',
            equalFeesAllocated: '6.9375',
            feesAllocated: '11.5625',
          },
        },
      },
    ],
    finalAllocations: {
      '1': {
        stakeWeightedFeesAllocated: '4.625',
        equalFeesAllocated: '13.875',
        feesAllocated: '18.5',
      },
      '2': {
        stakeWeightedFeesAllocated: '4.625',
        equalFeesAllocated: '6.9375',
        feesAllocated: '11.5625',
      },
    },
  };
}

function makeTransferFile(overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      startPolygonBlock: 1,
      endPolygonBlock: 2,
      totalAmount: '30.0625',
      validatorCount: 2,
      blockProducerCommission: 0.26,
      stakersFeeRate: 0.5,
      equalityFactor: 0.75,
      totalStakersPool: '37.0',
      totalEqualPoolBurn: '6.9375',
      generatedAt: '2026-05-08T00:00:00.000Z',
      ...overrides,
    },
    allocations: [
      { validatorId: 1, amount: '18.5' },
      { validatorId: 2, amount: '11.5625' },
    ],
  };
}

function weiString(wei: bigint): string {
  const digits = wei.toString().padStart(19, '0');
  const whole = digits.slice(0, -18);
  const fractional = digits.slice(-18);
  return `${whole}.${fractional}`;
}

function makeMultiIntervalRoundingReport() {
  const intervals = Array.from({ length: 3 }, (_, index) => ({
    intervalNumber: index,
    startTimestamp: 100 + index,
    endTimestamp: 101 + index,
    feesCollected: weiString(3n),
    postCommissionPoolFees: weiString(3n),
    stakersPoolFees: '0.0',
    validatorPoolFees: weiString(3n),
    stakeWeightedValidatorPoolFees: weiString(3n),
    equalValidatorPoolFees: '0.0',
    equalValidatorPoolDistributedFees: '0.0',
    equalPoolBurnFees: '0.0',
    perfectPerformance: '1',
    rewardedValidatorCount: 2,
    validators: {
      '1': {
        stakeAtStart: '1.0',
        performanceDelta: '1',
        stakeWeightedFeesAllocated: weiString(1n),
        equalFeesAllocated: '0.0',
        feesAllocated: weiString(1n),
      },
      '2': {
        stakeAtStart: '1.0',
        performanceDelta: '1',
        stakeWeightedFeesAllocated: weiString(1n),
        equalFeesAllocated: '0.0',
        feesAllocated: weiString(1n),
      },
    },
  }));

  return {
    metadata: {
      startPolygonBlock: 1,
      endPolygonBlock: 2,
      blockProducerCommission: 0,
      stakersFeeRate: 0,
      equalityFactor: 0,
      totalIntervals: 3,
      generatedAt: '2026-05-08T00:00:00.000Z',
    },
    summary: {
      totalFeesCollected: weiString(9n),
      totalPostCommissionPool: weiString(9n),
      totalStakersPool: '0.0',
      totalValidatorPool: weiString(9n),
      totalStakeWeightedValidatorPool: weiString(9n),
      totalEqualValidatorPool: '0.0',
      totalEqualValidatorPoolDistributed: '0.0',
      totalEqualPoolBurn: '0.0',
      validatorCount: 2,
    },
    intervals,
    finalAllocations: {
      '1': {
        stakeWeightedFeesAllocated: weiString(3n),
        equalFeesAllocated: '0.0',
        feesAllocated: weiString(3n),
      },
      '2': {
        stakeWeightedFeesAllocated: weiString(3n),
        equalFeesAllocated: '0.0',
        feesAllocated: weiString(3n),
      },
    },
  };
}

function writeJson(dir: string, name: string, value: unknown): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
  return filePath;
}

function withQuietConsole(fn: () => void): void {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('validation passes when transfer non-validator metadata matches detailed report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-split-validation-'));
  const detailedPath = writeJson(dir, 'detailed.json', makeDetailedReport());
  const transferPath = writeJson(dir, 'transfer.json', makeTransferFile());

  withQuietConsole(() => validateOutputFiles(detailedPath, transferPath));
});

test('validation fails when transfer non-validator metadata does not match detailed report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-split-validation-'));
  const detailedPath = writeJson(dir, 'detailed.json', makeDetailedReport());
  const transferPath = writeJson(
    dir,
    'transfer.json',
    makeTransferFile({ totalStakersPool: '36.0' })
  );

  const originalExit = process.exit;
  process.exit = ((code?: string | number | null) => {
    throw new Error(`process.exit:${code}`);
  }) as typeof process.exit;

  try {
    withQuietConsole(() => {
      assert.throws(
        () => validateOutputFiles(detailedPath, transferPath),
        /process\.exit:1/
      );
    });
  } finally {
    process.exit = originalExit;
  }
});

test('validation allows stake-weighted rounding remainders accumulated across intervals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-split-validation-'));
  const detailedPath = writeJson(dir, 'detailed.json', makeMultiIntervalRoundingReport());

  withQuietConsole(() => validateOutputFiles(detailedPath));
});
