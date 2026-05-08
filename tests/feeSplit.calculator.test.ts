import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { FeeSplitCalculator } from '../src/calculators/feeSplit.calculator';
import { FeeSnapshot, PerformanceScore, StakeUpdateEvent } from '../src/models/types';

function makePerformanceScore(
  ethereumTimestamp: number,
  heimdallBlock: number,
  entries: Array<[number, bigint]>
): PerformanceScore {
  return {
    ethereumTimestamp,
    heimdallBlock,
    performanceScores: new Map(entries),
  };
}

function runSingleIntervalCalculation(performanceEntries: Array<[number, bigint]>) {
  const calculator = new FeeSplitCalculator(0.26, 0.5, 0.75);

  const result = calculator.calculate(
    [200],
    new Map([
      [1, ethers.parseEther('10')],
      [2, ethers.parseEther('20')],
      [3, ethers.parseEther('30')],
    ]),
    [] as StakeUpdateEvent[],
    0n,
    [
      {
        ethereumTimestamp: 200,
        polygonBlock: 1000,
        feeBalance: ethers.parseEther('100'),
      } satisfies FeeSnapshot,
    ],
    makePerformanceScore(100, 500, [
      [1, 0n],
      [2, 0n],
      [3, 0n],
    ]),
    [makePerformanceScore(200, 600, performanceEntries)],
    1,
    2,
    100,
    200,
    123,
  );

  return result;
}

test('splits validator pool into stake-weighted, equal, stakers, and burn amounts', () => {
  const result = runSingleIntervalCalculation([
    [1, 10n],
    [2, 5n],
    [3, 0n],
  ]);

  assert.equal(result.summary.totalFeesCollected, '100.0');
  assert.equal(result.summary.totalPostCommissionPool, '74.0');
  assert.equal(result.summary.totalStakersPool, '37.0');
  assert.equal(result.summary.totalValidatorPool, '37.0');
  assert.equal(result.summary.totalStakeWeightedValidatorPool, '9.25');
  assert.equal(result.summary.totalEqualValidatorPool, '27.75');
  assert.equal(result.summary.totalEqualPoolBurn, '6.9375');

  assert.equal(ethers.formatEther(result.finalAllocations.get(1) ?? 0n), '18.5');
  assert.equal(ethers.formatEther(result.finalAllocations.get(2) ?? 0n), '11.5625');
  assert.equal(ethers.formatEther(result.finalStakeWeightedAllocations.get(1) ?? 0n), '4.625');
  assert.equal(ethers.formatEther(result.finalEqualAllocations.get(1) ?? 0n), '13.875');
  assert.equal(result.finalAllocations.has(3), false);

  const interval = result.intervals[0];
  assert.equal(interval.stakersPoolFees, '37.0');
  assert.equal(interval.validators[1].stakeWeightedFeesAllocated, '4.625');
  assert.equal(interval.validators[2].stakeWeightedFeesAllocated, '4.625');
});

test('burn is zero when all rewarded validators have perfect performance', () => {
  const result = runSingleIntervalCalculation([
    [1, 10n],
    [2, 10n],
    [3, 0n],
  ]);

  assert.equal(result.summary.totalEqualPoolBurn, '0.0');
  assert.equal(ethers.formatEther(result.finalAllocations.get(1) ?? 0n), '16.958333333333333333');
  assert.equal(ethers.formatEther(result.finalAllocations.get(2) ?? 0n), '20.041666666666666666');
});

test('validators with zero performance are excluded from the equal-share denominator', () => {
  const result = runSingleIntervalCalculation([
    [1, 8n],
    [2, 0n],
    [3, 0n],
  ]);

  const interval = result.intervals[0];
  assert.equal(ethers.formatEther(result.finalEqualAllocations.get(1) ?? 0n), '27.75');
  assert.equal(result.finalEqualAllocations.has(2), false);
  assert.equal(interval.validators[2], undefined);
  assert.equal(interval.validators[3], undefined);
});

test('whole-period equal pool fully burns when no validator has positive aggregate performance', () => {
  const result = runSingleIntervalCalculation([
    [1, 0n],
    [2, 0n],
    [3, 0n],
  ]);

  assert.equal(result.summary.totalEqualValidatorPool, '27.75');
  assert.equal(result.summary.totalEqualPoolBurn, '27.75');
  assert.equal(result.finalAllocations.size, 0);
});
