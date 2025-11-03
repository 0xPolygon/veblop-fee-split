/**
 * Type definitions for the Polygon PoS validator fee split calculator
 */

/**
 * StakeUpdate event data from Ethereum staking contract
 */
export interface StakeUpdateEvent {
  validatorId: bigint;
  newAmount: bigint;
  blockNumber: number;
  blockTimestamp: number;
  transactionHash: string;
}

/**
 * Fee balance snapshot at a specific point in time
 */
export interface FeeSnapshot {
  ethereumBlock: number;
  ethereumTimestamp: number;
  polygonBlock: number;
  feeBalance: bigint;
  feeDelta: bigint; // Change since last snapshot
}

/**
 * Validator performance data from Heimdall API
 */
export interface ValidatorPerformance {
  validatorId: number;
  rawScore: number; // Raw score from API (0-1000000)
  normalizedScore: number; // Normalized to 0-1
}

/**
 * Validator stake information at a checkpoint
 */
export interface ValidatorStake {
  validatorId: number;
  stakedAmount: bigint;
}

/**
 * Heimdall API response structure
 */
export interface HeimdallPerformanceResponse {
  validator_performance_score: {
    [validatorId: string]: string; // Score as string
  };
}

/**
 * Fee split calculation result for a single validator
 */
export interface FeeSplitResult {
  validatorId: number;
  stakedAmount: bigint; // Time-weighted blended stake across all intervals
  stakedAmountFormatted: string;
  stakeRatio: number; // Ratio of blended stake to total blended stake
  performanceScore: number;
  performanceWeightedStake: number; // Blended stake × performance score
  feeAllocation: bigint;
  feeAllocationFormatted: string;
}

/**
 * Staking interval data for CSV export
 */
export interface StakingInterval {
  intervalNumber: number;
  startTimestamp: number;
  startTimestampISO: string;
  startEthereumBlock: number;
  startPolygonBlock: number;
  endTimestamp?: number;
  endTimestampISO?: string;
  endEthereumBlock?: number;
  endPolygonBlock?: number;
  feeBalance: bigint;
  feeDelta: bigint;
  validatorStakes: Map<number, bigint>; // validatorId -> stake amount
}

/**
 * Complete output data structure
 */
export interface OutputData {
  metadata: {
    generatedAt: string;
    polygonBlockRange: {
      from: number;
      to: number;
    };
    ethereumBlockRange: {
      from: number;
      to: number;
    };
    totalFeesCollected: string;
    validatorPoolSize: string; // After 26% producer commission
    blockProducerCommission: number;
  };
  stakeUpdates: Array<{
    validatorId: number;
    totalStaked: string;
    ethereumBlock: number;
    ethereumTimestamp: number;
    ethereumTimestampISO: string;
    polygonBlock: number;
    feeBalance: string;
    feeDelta: string;
  }>;
  validatorPerformance: Array<{
    validatorId: number;
    rawScore: number;
    normalizedScore: number;
  }>;
  feeSplits: Array<{
    validatorId: number;
    stakedAmount: string; // Formatted as POL
    stakeRatio: number;
    performanceScore: number;
    performanceWeightedStake: number;
    feeAllocation: string; // Formatted as POL
  }>;
}

/**
 * Environment configuration interface
 */
export interface Config {
  ethereumRpcUrl: string;
  polygonRpcUrl: string;
  heimdallRpcUrl: string;
  ethereumStakingContract: string;
  polygonFeeContract: string;
  blockProducerCommission: number;
  outputPath: string;
  maxConcurrentRequests: number;
  requestDelayMs: number;
  maxRetries: number;
}

/**
 * Rate limiter options
 */
export interface RateLimiterOptions {
  maxConcurrent: number;
  minDelayMs: number;
}

/**
 * Retry options
 */
export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}
