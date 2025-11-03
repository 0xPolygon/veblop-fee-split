/**
 * Fee split calculator using PIP-65 formula
 *
 * Formula: Rv = (Sv × Pv / Σ(Sv × Pv)) × Pool_validators
 *
 * Where:
 * - Rv = Validator reward
 * - Sv = Validator's staked amount
 * - Pv = Performance score (0-1)
 * - Pool_validators = Total fees × (1 - block_producer_commission)
 */

import { ethers } from 'ethers';
import {
  StakeUpdateEvent,
  FeeSnapshot,
  ValidatorPerformance,
  FeeSplitResult,
  ValidatorStake,
  StakingInterval
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
   * - Sum allocations across all intervals
   *
   * @param initialStakes - Initial stake amounts for all validators at period start
   * @param stakeUpdates - Stake update events defining interval boundaries (applied as deltas)
   * @param feeSnapshots - Fee snapshots at each checkpoint with deltas
   * @param performanceScores - Performance scores from Heimdall (applied uniformly)
   * @param totalFees - Total fees collected (in wei)
   * @returns Array of fee split results for each validator
   */
  calculate(
    initialStakes: Map<number, bigint>,
    stakeUpdates: StakeUpdateEvent[],
    feeSnapshots: FeeSnapshot[],
    performanceScores: Map<number, ValidatorPerformance>,
    totalFees: bigint
  ): { feeSplits: FeeSplitResult[]; intervals: StakingInterval[] } {
    // Validate inputs
    if (initialStakes.size === 0) {
      throw new Error('No initial stakes provided. Cannot calculate fee splits.');
    }

    if (performanceScores.size === 0) {
      throw new Error('No performance scores provided. Cannot calculate fee splits.');
    }

    if (totalFees < 0n) {
      throw new Error(`Total fees cannot be negative: ${totalFees}`);
    }

    if (this.blockProducerCommission < 0 || this.blockProducerCommission >= 1) {
      throw new Error(
        `Invalid block producer commission: ${this.blockProducerCommission}. ` +
        `Must be between 0 and 1.`
      );
    }

    logger.info('Calculating fee splits using PIP-65 formula with interval-based allocation');
    logger.info(`Starting with ${initialStakes.size} validators`);
    logger.info(`Total fees collected: ${ethers.formatEther(totalFees)} POL`);
    logger.info(`Block producer commission: ${(this.blockProducerCommission * 100).toFixed(1)}%`);

    // Calculate validator pool (after block producer commission)
    const validatorPool = this.calculateValidatorPool(totalFees);
    logger.info(`Validator pool: ${ethers.formatEther(validatorPool)} POL`);

    // Process intervals and accumulate fee allocations
    const { validatorAllocations, intervals } = this.calculateIntervalBasedAllocations(
      initialStakes,
      stakeUpdates,
      feeSnapshots,
      performanceScores
    );

    logger.info(`Processing ${validatorAllocations.size} validators`);
    logger.info(`Tracked ${intervals.length} staking intervals`);

    // Convert to results format
    const results = this.formatResults(validatorAllocations, performanceScores);

    // Validate total allocation
    this.validateAllocation(results, validatorPool);

    return { feeSplits: results, intervals };
  }

  /**
   * Calculate validator pool after block producer commission
   */
  private calculateValidatorPool(totalFees: bigint): bigint {
    const commission = BigInt(Math.floor(this.blockProducerCommission * 1e18));
    const validatorShare = BigInt(1e18) - commission;
    return (totalFees * validatorShare) / BigInt(1e18);
  }

  /**
   * Calculate interval-based fee allocations
   *
   * Process each interval between consecutive checkpoints:
   * 1. Start with initial stakes for all validators
   * 2. Apply StakeUpdate events as deltas to update stakes
   * 3. Allocate fees collected during each interval based on current stake distribution
   * 4. Accumulate allocations for each validator
   */
  private calculateIntervalBasedAllocations(
    initialStakes: Map<number, bigint>,
    stakeUpdates: StakeUpdateEvent[],
    feeSnapshots: FeeSnapshot[],
    performanceScores: Map<number, ValidatorPerformance>
  ): {
    validatorAllocations: Map<number, { totalFees: bigint; blendedStake: bigint }>;
    intervals: StakingInterval[];
  } {
    // Sort updates by timestamp to process chronologically
    const sortedUpdates = [...stakeUpdates].sort((a, b) =>
      a.blockTimestamp - b.blockTimestamp
    );

    // Group updates by timestamp (multiple validators can update in same block)
    const updatesByTimestamp = new Map<number, StakeUpdateEvent[]>();
    for (const update of sortedUpdates) {
      if (!updatesByTimestamp.has(update.blockTimestamp)) {
        updatesByTimestamp.set(update.blockTimestamp, []);
      }
      updatesByTimestamp.get(update.blockTimestamp)!.push(update);
    }

    // Get unique timestamps sorted chronologically
    const uniqueTimestamps = Array.from(updatesByTimestamp.keys()).sort((a, b) => a - b);

    // Create a map from ethereum timestamp to fee snapshot for quick lookup
    // If multiple snapshots exist for the same timestamp (due to multiple stake updates
    // in the same block), keep only the first one which has the correct feeDelta
    const snapshotMap = new Map<number, FeeSnapshot>();
    for (const snapshot of feeSnapshots) {
      if (!snapshotMap.has(snapshot.ethereumTimestamp)) {
        snapshotMap.set(snapshot.ethereumTimestamp, snapshot);
      }
    }

    // Initialize current stakes with initial state
    const currentStakes = new Map(initialStakes);

    // Track accumulated fee allocations for each validator
    const accumulatedFees = new Map<number, bigint>();

    // Track weighted stakes for blended calculation
    // For each validator: sum(stake_i × validatorPool_i) / sum(validatorPool_i)
    const weightedStakeSum = new Map<number, bigint>();
    let totalValidatorPoolWeight = 0n;

    // Track intervals for CSV export
    const intervals: StakingInterval[] = [];

    logger.info(`Processing ${uniqueTimestamps.length} unique checkpoints (${sortedUpdates.length} total stake updates)`);
    logger.info(`Initial validator count: ${currentStakes.size}`);

    // Process each unique timestamp checkpoint
    for (let i = 0; i < uniqueTimestamps.length; i++) {
      const timestamp = uniqueTimestamps[i];
      const updatesAtTimestamp = updatesByTimestamp.get(timestamp)!;
      const snapshot = snapshotMap.get(timestamp);

      if (!snapshot) {
        throw new Error(
          `Missing fee snapshot for timestamp ${timestamp} (${new Date(timestamp * 1000).toISOString()}). ` +
          `This indicates a data collection error. All stake update timestamps must have corresponding fee snapshots.`
        );
      }

      // Get the first update at this timestamp for interval tracking
      const firstUpdate = updatesAtTimestamp[0];
      const prevTimestamp = i > 0 ? uniqueTimestamps[i - 1] : timestamp;
      const prevSnapshot = i > 0 ? snapshotMap.get(prevTimestamp) : snapshot;

      // Track this interval
      intervals.push({
        intervalNumber: i,
        startTimestamp: prevTimestamp,
        startTimestampISO: new Date(prevTimestamp * 1000).toISOString(),
        startEthereumBlock: prevSnapshot?.ethereumBlock || firstUpdate.blockNumber,
        startPolygonBlock: prevSnapshot?.polygonBlock || 0,
        endTimestamp: timestamp,
        endTimestampISO: new Date(timestamp * 1000).toISOString(),
        endEthereumBlock: firstUpdate.blockNumber,
        endPolygonBlock: snapshot.polygonBlock,
        feeBalance: snapshot.feeBalance,
        feeDelta: snapshot.feeDelta,
        validatorStakes: new Map(currentStakes), // Snapshot of stakes at start of interval
      });

      if (i === 0) {
        logger.debug(`First interval: feeDelta=${ethers.formatEther(snapshot.feeDelta)} POL, feeBalance=${ethers.formatEther(snapshot.feeBalance)} POL`);
      }

      // Allocate fees for this interval (before applying stake updates)
      if (snapshot.feeDelta > 0n) {
        // Calculate validator pool for this interval (after block producer commission)
        const intervalValidatorPool = this.calculateValidatorPool(snapshot.feeDelta);

        const intervalFees = this.allocateFeesForInterval(
          intervalValidatorPool,
          currentStakes,
          performanceScores
        );

        // Accumulate fees for each validator
        for (const [valId, fees] of intervalFees.entries()) {
          const current = accumulatedFees.get(valId) || 0n;
          accumulatedFees.set(valId, current + fees);
        }

        // Accumulate weighted stakes for blended calculation
        totalValidatorPoolWeight += intervalValidatorPool;
        for (const [valId, stake] of currentStakes.entries()) {
          const currentWeighted = weightedStakeSum.get(valId) || 0n;
          // Multiply stake by pool weight (need to scale down later)
          // We'll use integer math: weighted += stake * pool / 1e18
          const weighted = (stake * intervalValidatorPool) / BigInt(1e18);
          weightedStakeSum.set(valId, currentWeighted + weighted);
        }

        logger.debug(
          `Checkpoint ${i + 1}: Allocated ${ethers.formatEther(intervalValidatorPool)} POL ` +
          `to ${intervalFees.size} validators (from ${ethers.formatEther(snapshot.feeDelta)} POL total fees, ` +
          `${updatesAtTimestamp.length} validator update(s))`
        );
      }

      // Now apply all stake updates at this timestamp
      for (const update of updatesAtTimestamp) {
        const validatorId = Number(update.validatorId);
        currentStakes.set(validatorId, update.newAmount);

        logger.debug(
          `  Validator ${validatorId} stake updated to ${ethers.formatEther(update.newAmount)} POL`
        );
      }
    }

    // Calculate blended stakes for each validator
    // blendedStake = sum(stake_i × validatorPool_i) / sum(validatorPool_i)
    const validatorAllocations = new Map<number, { totalFees: bigint; blendedStake: bigint }>();

    for (const [validatorId] of currentStakes.entries()) {
      const weightedSum = weightedStakeSum.get(validatorId) || 0n;

      // Calculate blended stake: (weightedSum / totalWeight) * 1e18
      // We divided by 1e18 when accumulating, so multiply back and divide by total weight
      const blendedStake = totalValidatorPoolWeight > 0n
        ? (weightedSum * BigInt(1e18)) / totalValidatorPoolWeight
        : 0n;

      validatorAllocations.set(validatorId, {
        totalFees: accumulatedFees.get(validatorId) || 0n,
        blendedStake,
      });
    }

    return { validatorAllocations, intervals };
  }

  /**
   * Allocate fees for a single interval based on performance-weighted stakes
   */
  private allocateFeesForInterval(
    intervalFees: bigint,
    currentStakes: Map<number, bigint>,
    performanceScores: Map<number, ValidatorPerformance>
  ): Map<number, bigint> {
    const allocations = new Map<number, bigint>();

    // Calculate total performance-weighted stake
    let totalWeightedStake = 0;
    const weightedStakes = new Map<number, number>();

    for (const [validatorId, stake] of currentStakes.entries()) {
      const performance = performanceScores.get(validatorId);
      const performanceScore = performance?.normalizedScore || 0;
      const stakeInEther = Number(ethers.formatEther(stake));
      const weightedStake = stakeInEther * performanceScore;

      weightedStakes.set(validatorId, weightedStake);
      totalWeightedStake += weightedStake;
    }

    // Allocate fees proportionally
    if (totalWeightedStake > 0) {
      for (const [validatorId, weightedStake] of weightedStakes.entries()) {
        const shareRatio = weightedStake / totalWeightedStake;
        const allocation = (intervalFees * BigInt(Math.floor(shareRatio * 1e18))) / BigInt(1e18);
        allocations.set(validatorId, allocation);
      }
    }

    return allocations;
  }

  /**
   * Format results for output
   */
  private formatResults(
    validatorAllocations: Map<number, { totalFees: bigint; blendedStake: bigint }>,
    performanceScores: Map<number, ValidatorPerformance>
  ): FeeSplitResult[] {
    const results: FeeSplitResult[] = [];

    // Calculate total blended stake for ratio calculation
    let totalBlendedStake = 0n;
    for (const { blendedStake } of validatorAllocations.values()) {
      totalBlendedStake += blendedStake;
    }

    for (const [validatorId, { totalFees, blendedStake }] of validatorAllocations.entries()) {
      const stakeRatio = Number(blendedStake) / Number(totalBlendedStake);
      const stakeInEther = Number(ethers.formatEther(blendedStake));

      // Get the actual performance score for this validator
      const performance = performanceScores.get(validatorId);
      const performanceScore = performance?.normalizedScore || 0;
      const performanceWeightedStake = stakeInEther * performanceScore;

      results.push({
        validatorId,
        stakedAmount: blendedStake,
        stakedAmountFormatted: ethers.formatEther(blendedStake),
        stakeRatio,
        performanceScore,
        performanceWeightedStake,
        feeAllocation: totalFees,
        feeAllocationFormatted: ethers.formatEther(totalFees),
      });
    }

    // Sort by fee allocation (highest first)
    results.sort((a, b) => {
      if (a.feeAllocation > b.feeAllocation) return -1;
      if (a.feeAllocation < b.feeAllocation) return 1;
      return 0;
    });

    return results;
  }


  /**
   * Validate that total allocation matches validator pool
   */
  private validateAllocation(results: FeeSplitResult[], validatorPool: bigint): void {
    const totalAllocated = results.reduce(
      (sum, r) => sum + r.feeAllocation,
      0n
    );

    const difference = validatorPool - totalAllocated;
    const differenceInEther = Number(ethers.formatEther(difference < 0n ? -difference : difference));

    logger.info(`Total allocated: ${ethers.formatEther(totalAllocated)} POL`);
    logger.info(`Validator pool: ${ethers.formatEther(validatorPool)} POL`);
    logger.info(`Difference: ${differenceInEther.toFixed(6)} POL`);

    // Allow for small rounding errors (less than 0.001 POL)
    if (differenceInEther > 0.001) {
      logger.warn(
        `Fee allocation validation warning: difference of ${differenceInEther.toFixed(6)} POL detected. ` +
        'This may be due to rounding in the calculation.'
      );
    } else {
      logger.info('Fee allocation validated successfully');
    }
  }
}
