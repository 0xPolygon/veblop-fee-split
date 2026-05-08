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
  assert.equal(result.summary.totalEqualValidatorPoolDistributed, '20.8125');
  assert.equal(result.summary.totalEqualPoolBurn, '6.9375');

  assert.equal(ethers.formatEther(result.finalAllocations.get(1) ?? 0n), '18.5');
  assert.equal(ethers.formatEther(result.finalAllocations.get(2) ?? 0n), '11.5625');
  assert.equal(ethers.formatEther(result.finalStakeWeightedAllocations.get(1) ?? 0n), '4.625');
  assert.equal(ethers.formatEther(result.finalEqualAllocations.get(1) ?? 0n), '13.875');
  assert.equal(result.finalAllocations.has(3), false);

  const interval = result.intervals[0];
  assert.equal(interval.stakersPoolFees, '37.0');
  assert.equal(interval.equalValidatorPoolFees, '27.75');
  assert.equal(interval.equalValidatorPoolDistributedFees, '20.8125');
  assert.equal(interval.equalPoolBurnFees, '6.9375');
  assert.equal(interval.perfectPerformance, '10');
  assert.equal(interval.rewardedValidatorCount, 2);
  assert.equal(interval.validators[1].stakeWeightedFeesAllocated, '4.625');
  assert.equal(interval.validators[1].equalFeesAllocated, '13.875');
  assert.equal(interval.validators[1].feesAllocated, '18.5');
  assert.equal(interval.validators[2].stakeWeightedFeesAllocated, '4.625');
  assert.equal(interval.validators[2].equalFeesAllocated, '6.9375');
  assert.equal(interval.validators[2].feesAllocated, '11.5625');
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

test('throws when a non-zero stake-weighted pool has zero total weighted stake', () => {
  assert.throws(
    () => runSingleIntervalCalculation([
      [1, 0n],
      [2, 0n],
      [3, 0n],
    ]),
    /Cannot allocate non-zero stake-weighted validator pool.*total performance-weighted stake is 0/s,
  );
});

test('allocates equal pool independently for each interval', () => {
  const calculator = new FeeSplitCalculator(0, 0, 1);

  const result = calculator.calculate(
    [200, 300],
    new Map([
      [1, ethers.parseEther('10')],
      [2, ethers.parseEther('10')],
    ]),
    [] as StakeUpdateEvent[],
    0n,
    [
      {
        ethereumTimestamp: 200,
        polygonBlock: 1000,
        feeBalance: ethers.parseEther('100'),
      } satisfies FeeSnapshot,
      {
        ethereumTimestamp: 300,
        polygonBlock: 1001,
        feeBalance: ethers.parseEther('200'),
      } satisfies FeeSnapshot,
    ],
    makePerformanceScore(100, 500, [
      [1, 0n],
      [2, 0n],
    ]),
    [
      makePerformanceScore(200, 600, [
        [1, 10n],
        [2, 5n],
      ]),
      makePerformanceScore(300, 700, [
        [1, 10n],
        [2, 15n],
      ]),
    ],
    1,
    2,
    100,
    300,
    123,
  );

  assert.equal(result.summary.totalValidatorPool, '200.0');
  assert.equal(result.summary.totalStakeWeightedValidatorPool, '0.0');
  assert.equal(result.summary.totalEqualValidatorPool, '200.0');
  assert.equal(result.summary.totalEqualValidatorPoolDistributed, '175.0');
  assert.equal(result.summary.totalEqualPoolBurn, '25.0');

  assert.equal(ethers.formatEther(result.finalAllocations.get(1) ?? 0n), '50.0');
  assert.equal(ethers.formatEther(result.finalAllocations.get(2) ?? 0n), '125.0');
  assert.equal(ethers.formatEther(result.finalEqualAllocations.get(1) ?? 0n), '50.0');
  assert.equal(ethers.formatEther(result.finalEqualAllocations.get(2) ?? 0n), '125.0');

  assert.equal(result.intervals[0].equalValidatorPoolFees, '100.0');
  assert.equal(result.intervals[0].equalValidatorPoolDistributedFees, '75.0');
  assert.equal(result.intervals[0].equalPoolBurnFees, '25.0');
  assert.equal(result.intervals[0].perfectPerformance, '10');
  assert.equal(result.intervals[0].rewardedValidatorCount, 2);
  assert.equal(result.intervals[0].validators[1].equalFeesAllocated, '50.0');
  assert.equal(result.intervals[0].validators[2].equalFeesAllocated, '25.0');

  assert.equal(result.intervals[1].equalValidatorPoolFees, '100.0');
  assert.equal(result.intervals[1].equalValidatorPoolDistributedFees, '100.0');
  assert.equal(result.intervals[1].equalPoolBurnFees, '0.0');
  assert.equal(result.intervals[1].perfectPerformance, '10');
  assert.equal(result.intervals[1].rewardedValidatorCount, 1);
  assert.equal(result.intervals[1].validators[1], undefined);
  assert.equal(result.intervals[1].validators[2].equalFeesAllocated, '100.0');
});

test('throws when an interval has a negative fee delta', () => {
  const calculator = new FeeSplitCalculator(0.26, 0.5, 0.75);

  assert.throws(
    () => calculator.calculate(
      [200],
      new Map([[1, ethers.parseEther('10')]]),
      [] as StakeUpdateEvent[],
      ethers.parseEther('100'),
      [
        {
          ethereumTimestamp: 200,
          polygonBlock: 1000,
          feeBalance: ethers.parseEther('99'),
        } satisfies FeeSnapshot,
      ],
      makePerformanceScore(100, 500, [[1, 0n]]),
      [makePerformanceScore(200, 600, [[1, 1n]])],
      1,
      2,
      100,
      200,
      123,
    ),
    /Negative fee delta detected.*Polygon block 1000.*distributions\.json/s,
  );
});
