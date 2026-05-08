/**
 * Fee split calculator using the PIP-85 adjusted validator formula
 *
 * Stake-weighted component:
 *   Rv(stake) = (Sv × Pv / Σ(Sv × Pv)) × Pool_validators_stake
 *
 * Equal component:
 *   Rv(equal) = (Pool_validators_equal / N) × (Pv / Pmax)
 *
 * Total:
 *   Rv = Rv(stake) + Rv(equal)
 */

import { ethers } from 'ethers';
import {
  StakeUpdateEvent,
  FeeSnapshot,
  PerformanceScore,
  CalculationResult,
  IntervalData,
  ValidatorIntervalData,
  CalculationMetadata,
  CalculationSummary
} from '../models/types';
import { logger } from '../utils/logger';

export class FeeSplitCalculator {
  constructor(
    private readonly blockProducerCommission: number = 0.26,
    private readonly stakersFeeRate: number = 0.5,
    private readonly equalityFactor: number = 0.75,
  ) {}

  /**
   * Calculate fee splits for all validators using interval-based allocation
   *
   * For each interval between consecutive stake updates:
   * - Determine the stake distribution at the start of that interval
   * - Allocate the fees collected during that interval proportionally
   * - Use interval-specific performance deltas (milestones signed during that interval)
   * - Sum allocations across all intervals
   *
   * @param uniqueTimestamps - Unique timestamps of each staking update, followed by the final end block timestamp
   * @param initialStakes - Initial stake amounts for all validators at period start
   * @param stakeUpdates - Stake update events defining interval boundaries
   * @param initialFeeBalance - Initial fee balance at the start of the period
   * @param feeSnapshots - Fee snapshots at each timestamp
   * @param initialPerformanceScore - Performance score snapshot at the start of the period
   * @param performanceScores - Performance score snapshots for each timestamp
   * @param startPolygonBlock - Starting Polygon block number
   * @param endPolygonBlock - Ending Polygon block number
   * @param startTimestamp - Starting timestamp
   * @param endTimestamp - Ending timestamp
   * @param initialEthereumBlock - Initial Ethereum block used for stake queries
   * @returns Complete calculation result with interval details
   */
  calculate(
    uniqueTimestamps: number[],
    initialStakes: Map<number, bigint>,
    stakeUpdates: StakeUpdateEvent[],
    initialFeeBalance: bigint,
    feeSnapshots: FeeSnapshot[],
    initialPerformanceScore: PerformanceScore,
    performanceScores: PerformanceScore[],
    startPolygonBlock: number,
    endPolygonBlock: number,
    startTimestamp: number,
    endTimestamp: number,
    initialEthereumBlock: number,
  ): CalculationResult {
    // Validate inputs
    if (initialStakes.size === 0) {
      throw new Error('No initial stakes provided. Cannot calculate fee splits.');
    }

    if (this.blockProducerCommission < 0 || this.blockProducerCommission >= 1) {
      throw new Error(
        `Invalid block producer commission: ${this.blockProducerCommission}. ` +
        `Must be between 0 and 1.`
      );
    }

    if (this.stakersFeeRate < 0 || this.stakersFeeRate > 1) {
      throw new Error(
        `Invalid stakers fee rate: ${this.stakersFeeRate}. Must be between 0 and 1.`
      );
    }

    if (this.equalityFactor < 0 || this.equalityFactor > 1) {
      throw new Error(
        `Invalid equality factor: ${this.equalityFactor}. Must be between 0 and 1.`
      );
    }

    logger.info('Calculating fee splits using PIP-85 formula with interval-based allocation');
    logger.info(`Starting with ${initialStakes.size} validators`);
    logger.info(`Block producer commission: ${(this.blockProducerCommission * 100).toFixed(1)}%`);
    logger.info(`Stakers fee rate: ${(this.stakersFeeRate * 100).toFixed(1)}%`);
    logger.info(`Equality factor: ${(this.equalityFactor * 100).toFixed(1)}%`);

    // Process intervals and accumulate fee allocations
    const {
      validatorAllocations,
      stakeWeightedAllocations,
      equalAllocations,
      intervals,
      totalFeesCollected,
      totalPostCommissionPool,
      totalStakersPool,
      totalValidatorPool,
      totalStakeWeightedValidatorPool,
      totalEqualValidatorPool,
      totalEqualValidatorPoolDistributed,
      totalEqualPoolBurn,
    } =
      this.calculateIntervalBasedAllocations(
        uniqueTimestamps,
        initialStakes,
        stakeUpdates,
        initialFeeBalance,
        feeSnapshots,
        initialPerformanceScore,
        performanceScores,
        initialEthereumBlock
      );

    // Build metadata
    const metadata: CalculationMetadata = {
      startPolygonBlock,
      endPolygonBlock,
      startTimestamp,
      endTimestamp,
      startTimestampISO: new Date(startTimestamp * 1000).toISOString(),
      endTimestampISO: new Date(endTimestamp * 1000).toISOString(),
      blockProducerCommission: this.blockProducerCommission,
      stakersFeeRate: this.stakersFeeRate,
      equalityFactor: this.equalityFactor,
      totalIntervals: intervals.length,
      generatedAt: new Date().toISOString(),
    };

    // Build summary
    const summary: CalculationSummary = {
      totalFeesCollected: ethers.formatEther(totalFeesCollected),
      totalPostCommissionPool: ethers.formatEther(totalPostCommissionPool),
      totalStakersPool: ethers.formatEther(totalStakersPool),
      totalValidatorPool: ethers.formatEther(totalValidatorPool),
      totalStakeWeightedValidatorPool: ethers.formatEther(totalStakeWeightedValidatorPool),
      totalEqualValidatorPool: ethers.formatEther(totalEqualValidatorPool),
      totalEqualValidatorPoolDistributed: ethers.formatEther(totalEqualValidatorPoolDistributed),
      totalEqualPoolBurn: ethers.formatEther(totalEqualPoolBurn),
      validatorCount: validatorAllocations.size,
    };

    return {
      finalAllocations: validatorAllocations,
      finalStakeWeightedAllocations: stakeWeightedAllocations,
      finalEqualAllocations: equalAllocations,
      intervals,
      metadata,
      summary,
    };
  }

  /**
   * Scale an amount by a decimal rate using fixed-point integer arithmetic.
   *
   * The result is rounded down to the nearest wei. When splitting one pool into
   * two complementary pools, calculate one side with this helper and derive the
   * other by subtraction so rounding does not create or lose wei.
   */
  private scaleByRate(amount: bigint, rate: number): bigint {
    const rateWei = BigInt(Math.floor(rate * 1e18));
    return (amount * rateWei) / BigInt(1e18);
  }

  /**
   * Calculate interval-based fee allocations
   *
   * Process each interval between consecutive timestamps:
   * 1. Start with initial stakes for all validators
   * 2. Apply StakeUpdate events as deltas to update stakes
   * 3. Allocate fees collected during each interval based on current stake distribution × performance deltas
   * 4. Accumulate allocations for each validator
   */
  private calculateIntervalBasedAllocations(
    uniqueTimestamps: number[],
    initialStakes: Map<number, bigint>,
    stakeUpdates: StakeUpdateEvent[],
    initialFeeBalance: bigint,
    feeSnapshots: FeeSnapshot[],
    initialPerformanceScore: PerformanceScore,
    performanceScores: PerformanceScore[],
    initialEthereumBlock: number
  ): {
    validatorAllocations: Map<number, bigint>;
    stakeWeightedAllocations: Map<number, bigint>;
    equalAllocations: Map<number, bigint>;
    intervals: IntervalData[];
    totalFeesCollected: bigint;
    totalPostCommissionPool: bigint;
    totalStakersPool: bigint;
    totalValidatorPool: bigint;
    totalStakeWeightedValidatorPool: bigint;
    totalEqualValidatorPool: bigint;
    totalEqualValidatorPoolDistributed: bigint;
    totalEqualPoolBurn: bigint;
  } {

    // Ensure uniqueTimestamps are sorted in ascending order before use
    uniqueTimestamps = [...uniqueTimestamps].sort((a, b) => a - b);

    // Create a map from ethereum timestamp to stake update events for quick lookup
    const stakeUpdateMap = new Map<number, StakeUpdateEvent[]>();
    for (const update of stakeUpdates) {
      const group = stakeUpdateMap.get(update.blockTimestamp) ?? [];
      group.push(update);
      stakeUpdateMap.set(update.blockTimestamp, group);
    }

    // Create a map from ethereum timestamp to fee snapshot for quick lookup
    const feeSnapshotMap = new Map<number, FeeSnapshot>();
    for (const snapshot of feeSnapshots) {
      if (!feeSnapshotMap.has(snapshot.ethereumTimestamp)) {
        feeSnapshotMap.set(snapshot.ethereumTimestamp, snapshot);
      }
    }

    // Create a map from ethereum timestamp to performance score for quick lookup
    const performanceMap = new Map<number, PerformanceScore>();
    for (const score of performanceScores) {
      if (!performanceMap.has(score.ethereumTimestamp)) {
        performanceMap.set(score.ethereumTimestamp, score);
      }
    }

    // Initialize current stakes with initial state
    let currentStakes = new Map(initialStakes);
    let currentPerformanceScore = new Map(initialPerformanceScore.performanceScores);
    let currentFee = initialFeeBalance;
    let currentEthereumBlock = initialEthereumBlock;
    let currentTimestamp = initialPerformanceScore.ethereumTimestamp;

    // Track accumulated fee allocations for each validator
    const accumulatedStakeWeightedFees = new Map<number, bigint>();
    const accumulatedEqualFees = new Map<number, bigint>();

    // Collect interval data for reporting
    const intervals: IntervalData[] = [];
    let totalFeesCollected = 0n;
    let totalPostCommissionPool = 0n;
    let totalStakersPool = 0n;
    let totalValidatorPool = 0n;
    let totalStakeWeightedValidatorPool = 0n;
    let totalEqualValidatorPool = 0n;
    let totalEqualValidatorPoolDistributed = 0n;
    let totalEqualPoolBurn = 0n;

    logger.info(`Processing ${uniqueTimestamps.length} unique timestamps`);
    logger.info(`Initial validator count: ${currentStakes.size}`);

    // Process each unique timestamp
    for (let i = 0; i < uniqueTimestamps.length; i++) {
      const timestamp = uniqueTimestamps[i];
      const feeSnapshot = feeSnapshotMap.get(timestamp);

      if (!feeSnapshot) {
        throw new Error(
          `Missing fee snapshot for timestamp ${timestamp} (${new Date(timestamp * 1000).toISOString()}). ` +
          `This indicates a data collection error. All stake update timestamps must have corresponding fee snapshots.`
        );
      }

      const performanceScore = performanceMap.get(timestamp)?.performanceScores;
      if (!performanceScore) {
        throw new Error(
          `Missing performance score for timestamp ${timestamp} (${new Date(timestamp * 1000).toISOString()}). ` +
          `This indicates a data collection error. All stake update timestamps must have corresponding performance scores.`
        );
      }
      logger.info(`Processing interval ${i + 1} with ending timestamp ${timestamp} (${new Date(timestamp * 1000).toISOString()})`);

      // Calculate the fee accrued from previous timestamp to this timestamp
      const previousFee = currentFee;
      const feeDelta = feeSnapshot.feeBalance - previousFee;
      if (feeDelta < 0n) {
        throw new Error(
          `Negative fee delta detected for interval ${i} ending at ${timestamp} ` +
          `(${new Date(timestamp * 1000).toISOString()}, Polygon block ${feeSnapshot.polygonBlock}). ` +
          `Previous adjusted fee balance was ${ethers.formatEther(previousFee)} POL, ` +
          `current adjusted fee balance is ${ethers.formatEther(feeSnapshot.feeBalance)} POL, ` +
          `delta is ${ethers.formatEther(feeDelta)} POL. ` +
          `Fees should never be negative; check distributions.json for an incorrectly recorded distribution block.`
        );
      }
      currentFee = feeSnapshot.feeBalance;
      logger.info(`Fee delta: ${ethers.formatEther(feeDelta)} POL`);

      // Calculate the performance score delta from previous timestamp to this timestamp
      const performanceScoreDeltas = new Map<number, bigint>();

      // Get all unique validator IDs from both current and new performance scores
      const allValidatorIds = new Set<number>([
        ...currentPerformanceScore.keys(),
        ...performanceScore.keys()
      ]);

      // Calculate delta for each validator
      for (const validatorId of allValidatorIds) {
        const previousScore = currentPerformanceScore.get(validatorId) ?? 0n;
        const currentScore = performanceScore.get(validatorId) ?? 0n;
        const delta = currentScore - previousScore;
        logger.debug(`Performance score delta for validator ${validatorId}: ${currentScore} - ${previousScore} = ${delta}`);
        // Only record validators that will receive some rewards for this interval
        if (delta > 0n) {
          performanceScoreDeltas.set(validatorId, delta);
        }
      }

      // Allocate fees for this interval (before applying stake updates)
      let intervalPostCommissionPool = 0n;
      let intervalStakersPool = 0n;
      let intervalValidatorPool = 0n;
      let intervalStakeWeightedPool = 0n;
      let intervalEqualPool = 0n;
      let intervalEqualPoolDistributed = 0n;
      let intervalEqualPoolBurn = 0n;
      let intervalPerfectPerformance = 0n;
      let intervalRewardedValidatorCount = 0;
      let intervalStakeWeightedFees = new Map<number, bigint>();
      let intervalEqualFees = new Map<number, bigint>();
      let intervalFees = new Map<number, bigint>();

      if (feeDelta > 0n) {
        intervalPostCommissionPool = feeDelta - this.scaleByRate(feeDelta, this.blockProducerCommission);
        intervalStakersPool = this.scaleByRate(intervalPostCommissionPool, this.stakersFeeRate);
        intervalValidatorPool = intervalPostCommissionPool - intervalStakersPool;
        intervalStakeWeightedPool = intervalValidatorPool - this.scaleByRate(intervalValidatorPool, this.equalityFactor);
        intervalEqualPool = intervalValidatorPool - intervalStakeWeightedPool;

        totalPostCommissionPool += intervalPostCommissionPool;
        totalStakersPool += intervalStakersPool;
        totalValidatorPool += intervalValidatorPool;
        totalStakeWeightedValidatorPool += intervalStakeWeightedPool;
        totalEqualValidatorPool += intervalEqualPool;
        logger.info(`Interval validator pool: ${ethers.formatEther(intervalValidatorPool)} POL`);

        intervalStakeWeightedFees = this.allocateStakeWeightedFeesForInterval(
          intervalStakeWeightedPool,
          currentStakes,
          performanceScoreDeltas,
        );

        const equalShareResult = this.allocateEqualFeesForInterval(
          intervalEqualPool,
          performanceScoreDeltas,
        );
        intervalEqualFees = equalShareResult.allocations;
        intervalEqualPoolBurn = equalShareResult.burnAmount;
        intervalEqualPoolDistributed = intervalEqualPool - intervalEqualPoolBurn;
        intervalPerfectPerformance = equalShareResult.perfectPerformance;
        intervalRewardedValidatorCount = equalShareResult.rewardedValidatorCount;
        totalEqualValidatorPoolDistributed += intervalEqualPoolDistributed;
        totalEqualPoolBurn += intervalEqualPoolBurn;

        intervalFees = this.combineAllocations(intervalStakeWeightedFees, intervalEqualFees);

        // Accumulate fees for each validator
        for (const [valId, fees] of intervalStakeWeightedFees.entries()) {
          const current = accumulatedStakeWeightedFees.get(valId) || 0n;
          accumulatedStakeWeightedFees.set(valId, current + fees);
        }

        for (const [valId, fees] of intervalEqualFees.entries()) {
          const current = accumulatedEqualFees.get(valId) || 0n;
          accumulatedEqualFees.set(valId, current + fees);
        }

        const intervalAllocatedFees = Array.from(intervalFees.values()).reduce(
          (sum, fees) => sum + fees,
          0n
        );

        logger.info(
          `Checkpoint ${i + 1}: Allocated ${ethers.formatEther(intervalAllocatedFees)} POL ` +
          `to ${intervalFees.size} validators and burned ${ethers.formatEther(intervalEqualPoolBurn)} POL ` +
          `(from ${ethers.formatEther(feeDelta)} POL total fees)`
        );
      }

      totalFeesCollected += feeDelta;

      // Get all validator IDs that participated (had stake or performance)
      const allParticipatingValidators = new Set<number>([
        //...currentStakes.keys(), // if they have a positive performance delta, they should have had a stake!
        ...performanceScoreDeltas.keys(),
      ]);

      // Build validator data for this interval using stakes from BEFORE the updates
      const validators: Record<number, ValidatorIntervalData> = {};

      for (const validatorId of allParticipatingValidators) {
        const stakeAtStart = currentStakes.get(validatorId) ?? 0n;
        const performanceDelta = performanceScoreDeltas.get(validatorId) ?? 0n;
        const stakeWeightedFeesAllocated = intervalStakeWeightedFees.get(validatorId) ?? 0n;
        const equalFeesAllocated = intervalEqualFees.get(validatorId) ?? 0n;
        const feesAllocated = intervalFees.get(validatorId) ?? 0n;

        validators[validatorId] = {
          stakeAtStart: ethers.formatEther(stakeAtStart),
          performanceDelta: performanceDelta.toString(),
          stakeWeightedFeesAllocated: ethers.formatEther(stakeWeightedFeesAllocated),
          equalFeesAllocated: ethers.formatEther(equalFeesAllocated),
          feesAllocated: ethers.formatEther(feesAllocated),
        };
      }

      // Create interval data
      const intervalData: IntervalData = {
        intervalNumber: i,
        startTimestamp: currentTimestamp,
        endTimestamp: timestamp,
        startTimestampISO: new Date(currentTimestamp * 1000).toISOString(),
        endTimestampISO: new Date(timestamp * 1000).toISOString(),
        ethereumBlockAtStart: currentEthereumBlock,
        polygonBlockAtEnd: feeSnapshot.polygonBlock,
        heimdallBlockAtEnd: performanceMap.get(timestamp)!.heimdallBlock,
        feesCollected: ethers.formatEther(feeDelta),
        postCommissionPoolFees: ethers.formatEther(intervalPostCommissionPool),
        stakersPoolFees: ethers.formatEther(intervalStakersPool),
        validatorPoolFees: ethers.formatEther(intervalValidatorPool),
        stakeWeightedValidatorPoolFees: ethers.formatEther(intervalStakeWeightedPool),
        equalValidatorPoolFees: ethers.formatEther(intervalEqualPool),
        equalValidatorPoolDistributedFees: ethers.formatEther(intervalEqualPoolDistributed),
        equalPoolBurnFees: ethers.formatEther(intervalEqualPoolBurn),
        perfectPerformance: intervalPerfectPerformance.toString(),
        rewardedValidatorCount: intervalRewardedValidatorCount,
        validators,
      };
      intervals.push(intervalData);

      // Update current values for next iteration unless we're on the last interval
      if (i < uniqueTimestamps.length - 1) {
        currentTimestamp = timestamp;
        currentPerformanceScore = new Map(performanceScore);
      
        // Now apply all stake updates at this timestamp
        const stakeUpdatesAtTimestamp = stakeUpdateMap.get(timestamp) ?? [];
        logger.info(`Updating ${stakeUpdatesAtTimestamp.length} validators at timestamp ${timestamp}`);

        for (const update of stakeUpdatesAtTimestamp) {
          const validatorId = Number(update.validatorId);
          // Update current stakes for next interval
          currentStakes.set(validatorId, update.newAmount);
          logger.debug(
            `  Validator ${validatorId} stake updated to ${ethers.formatEther(update.newAmount)} POL`
          );
          currentEthereumBlock = update.blockNumber; // every entry will have the same block number
        }
      }      
    }

    const finalAllocations = this.combineAllocations(accumulatedStakeWeightedFees, accumulatedEqualFees);

    return {
      validatorAllocations: finalAllocations,
      stakeWeightedAllocations: accumulatedStakeWeightedFees,
      equalAllocations: accumulatedEqualFees,
      intervals,
      totalFeesCollected,
      totalPostCommissionPool,
      totalStakersPool,
      totalValidatorPool,
      totalStakeWeightedValidatorPool,
      totalEqualValidatorPool,
      totalEqualValidatorPoolDistributed,
      totalEqualPoolBurn,
    };
  }

  /**
   * Allocate fees for a single interval based on performance-weighted stakes
   * Uses raw performance deltas (milestones signed) without normalization
   *
   * @param intervalFees - Total fees to allocate in this interval
   * @param currentStakes - Current stake for each validator
   * @param performanceDeltas - Performance score deltas for this interval (optional)
   */
  private allocateStakeWeightedFeesForInterval(
    intervalFees: bigint,
    currentStakes: Map<number, bigint>,
    performanceDeltas: Map<number, bigint>
  ): Map<number, bigint> {
    const allocations = new Map<number, bigint>();

    // Calculate total performance-weighted stake using BigInt for precision
    let totalWeightedStake = 0n;
    const weightedStakes = new Map<number, bigint>();

    for (const [validatorId, stake] of currentStakes.entries()) {
      const performanceDelta = performanceDeltas.get(validatorId) || 0n;

      // weighted = stake * performanceDelta
      // Both are bigints, result will be very large
      const weightedStake = stake * performanceDelta;

      weightedStakes.set(validatorId, weightedStake);
      totalWeightedStake += weightedStake;
    }

    if (totalWeightedStake === 0n) {
      if (intervalFees === 0n) {
        return allocations;
      }

      throw new Error(
        `Cannot allocate non-zero stake-weighted validator pool (${ethers.formatEther(intervalFees)} POL) ` +
        `because total performance-weighted stake is 0. This means no validator with positive stake had ` +
        `positive performance in the interval; aborting to avoid unaccounted validator funds.`
      );
    }

    // Allocate fees proportionally
    for (const [validatorId, weightedStake] of weightedStakes.entries()) {
      // allocation = intervalFees * weightedStake / totalWeightedStake
      const allocation = (intervalFees * weightedStake) / totalWeightedStake;
      if (allocation > 0n) {
        allocations.set(validatorId, allocation);
      }
    }

    return allocations;
  }

  private allocateEqualFeesForInterval(
    equalPool: bigint,
    performanceDeltas: Map<number, bigint>
  ): {
    allocations: Map<number, bigint>;
    burnAmount: bigint;
    perfectPerformance: bigint;
    rewardedValidatorCount: number;
  } {
    const allocations = new Map<number, bigint>();
    const rewardedValidators = Array.from(performanceDeltas.entries())
      .filter(([, delta]) => delta > 0n);

    if (equalPool === 0n || rewardedValidators.length === 0) {
      return {
        allocations,
        burnAmount: equalPool,
        perfectPerformance: 0n,
        rewardedValidatorCount: rewardedValidators.length,
      };
    }

    const perfectPerformance = rewardedValidators.reduce(
      (maxDelta, [, delta]) => (delta > maxDelta ? delta : maxDelta),
      0n
    );

    if (perfectPerformance === 0n) {
      return {
        allocations,
        burnAmount: equalPool,
        perfectPerformance,
        rewardedValidatorCount: rewardedValidators.length,
      };
    }

    const validatorCount = BigInt(rewardedValidators.length);
    const equalBaseShare = equalPool / validatorCount;
    let allocatedTotal = 0n;

    for (const [validatorId, performanceDelta] of rewardedValidators) {
      const allocation = (equalBaseShare * performanceDelta) / perfectPerformance;
      if (allocation > 0n) {
        allocations.set(validatorId, allocation);
        allocatedTotal += allocation;
      }
    }

    return {
      allocations,
      burnAmount: equalPool - allocatedTotal,
      perfectPerformance,
      rewardedValidatorCount: rewardedValidators.length,
    };
  }

  private combineAllocations(
    left: Map<number, bigint>,
    right: Map<number, bigint>
  ): Map<number, bigint> {
    const combined = new Map<number, bigint>();

    for (const [validatorId, amount] of left.entries()) {
      combined.set(validatorId, amount);
    }

    for (const [validatorId, amount] of right.entries()) {
      const current = combined.get(validatorId) ?? 0n;
      combined.set(validatorId, current + amount);
    }

    return combined;
  }
}
