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
