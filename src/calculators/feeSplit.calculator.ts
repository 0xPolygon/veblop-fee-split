/**
 * Fee split calculator using PIP-65 formula
 *
 * Formula: Rv = (Sv × Pv / Σ(Sv × Pv)) × Pool_validators
 *
 * Where:
 * - Rv = Validator reward
 * - Sv = Validator's staked amount
 * - Pv = Performance score delta (raw milestone count for the interval)
 * - Pool_validators = Total fees × (1 - block_producer_commission)
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
  constructor(private blockProducerCommission: number = 0.26) {}

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

    logger.info('Calculating fee splits using PIP-65 formula with interval-based allocation');
    logger.info(`Starting with ${initialStakes.size} validators`);
    logger.info(`Block producer commission: ${(this.blockProducerCommission * 100).toFixed(1)}%`);

    // Process intervals and accumulate fee allocations
    const { validatorAllocations, intervals, totalFeesCollected, totalValidatorPool } =
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
      totalIntervals: intervals.length,
      generatedAt: new Date().toISOString(),
    };

    // Build summary
    const summary: CalculationSummary = {
      totalFeesCollected: ethers.formatEther(totalFeesCollected),
      totalValidatorPool: ethers.formatEther(totalValidatorPool),
      validatorCount: validatorAllocations.size,
    };

    return {
      finalAllocations: validatorAllocations,
      intervals,
      metadata,
      summary,
    };
  }

  /**
   * Calculate validator pool after block producer commission
   * E.g., with 26% commission: validatorShare = 1 - 0.26 = 0.74 (74% goes to validators)
   */
  private calculateValidatorPool(totalFees: bigint): bigint {
    const commission = BigInt(Math.floor(this.blockProducerCommission * 1e18));
    const validatorShare = BigInt(1e18) - commission;
    return (totalFees * validatorShare) / BigInt(1e18);
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
    intervals: IntervalData[];
    totalFeesCollected: bigint;
    totalValidatorPool: bigint;
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
    const accumulatedFees = new Map<number, bigint>();

    // Collect interval data for reporting
    const intervals: IntervalData[] = [];
    let totalFeesCollected = 0n;
    let totalValidatorPool = 0n;

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
      const feeDelta = feeSnapshot.feeBalance - currentFee;
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
      let intervalValidatorPool = 0n;
      let intervalFees = new Map<number, bigint>();

      if (feeDelta > 0n) {
        // Calculate validator pool for this interval (after block producer commission)
        intervalValidatorPool = this.calculateValidatorPool(feeDelta);
        totalValidatorPool += intervalValidatorPool;
        logger.info(`Interval validator pool: ${ethers.formatEther(intervalValidatorPool)} POL`);
        intervalFees = this.allocateFeesForInterval(
          intervalValidatorPool,
          currentStakes,
          performanceScoreDeltas,
        );

        // Accumulate fees for each validator
        for (const [valId, fees] of intervalFees.entries()) {
          const current = accumulatedFees.get(valId) || 0n;
          accumulatedFees.set(valId, current + fees);
        }

        logger.info(
          `Checkpoint ${i + 1}: Allocated ${ethers.formatEther(intervalValidatorPool)} POL ` +
          `to ${intervalFees.size} validators (from ${ethers.formatEther(feeDelta)} POL total fees, `
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
        const feesAllocated = intervalFees.get(validatorId) ?? 0n;

        validators[validatorId] = {
          stakeAtStart: ethers.formatEther(stakeAtStart),
          performanceDelta: performanceDelta.toString(),
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
        validatorPoolFees: ethers.formatEther(intervalValidatorPool),
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

    return {
      validatorAllocations: accumulatedFees,
      intervals,
      totalFeesCollected,
      totalValidatorPool,
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
  private allocateFeesForInterval(
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

    // Allocate fees proportionally
    if (totalWeightedStake > 0n) {
      for (const [validatorId, weightedStake] of weightedStakes.entries()) {
        // allocation = intervalFees * weightedStake / totalWeightedStake
        const allocation = (intervalFees * weightedStake) / totalWeightedStake;
        if (allocation > 0n) {
          allocations.set(validatorId, allocation);
        }
      }
    } else {
      logger.warn('Total weighted stake is 0 for this interval, no fees allocated');
    }

    return allocations;
  }
}