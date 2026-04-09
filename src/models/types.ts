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
 * Heimdall block information
 */
export interface HeimdallBlockInfo {
  height: number;
  timestamp: number;
  timestampISO: string;
}

/**
 * Fee balance snapshot at a specific point in time
 */
export interface FeeSnapshot {
  ethereumTimestamp: number;
  polygonBlock: number;
  feeBalance: bigint;
}

/**
 * Performance score snapshot at a specific point in time
 */
export interface PerformanceScore {
  ethereumTimestamp: number;
  heimdallBlock: number;
  performanceScores: Map<number, bigint>; // validatorId -> performance score
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
  stakersFeeRate: number;
  equalityFactor: number;
  outputPath: string;
  maxConcurrentRequests: number;
  requestDelayMs: number;
  requestTimeoutMs?: number; // Optional timeout for network calls in milliseconds
  maxRetries: number;
}

/**
 * Rate limiter options
 */
export interface RateLimiterOptions {
  maxConcurrent: number;
  minDelayMs: number;
  timeoutMs?: number; // Optional timeout for network calls in milliseconds
}

/**
 * Retry options
 */
export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Per-validator data for a single interval
 */
export interface ValidatorIntervalData {
  stakeAtStart: string; // POL amount as decimal string
  performanceDelta: string; // Raw milestone count as string
  stakeWeightedFeesAllocated: string; // POL amount as decimal string
  equalFeesAllocated: string; // POL amount as decimal string
  feesAllocated: string; // POL amount as decimal string
}

/**
 * Complete data for a single interval
 */
export interface IntervalData {
  intervalNumber: number;
  startTimestamp: number;
  endTimestamp: number;
  startTimestampISO: string;
  endTimestampISO: string;
  ethereumBlockAtStart: number;
  polygonBlockAtEnd: number;
  heimdallBlockAtEnd: number;
  feesCollected: string; // POL amount as decimal string
  postCommissionPoolFees: string; // POL amount as decimal string
  stakersPoolFees: string; // POL amount as decimal string
  validatorPoolFees: string; // POL amount as decimal string
  stakeWeightedValidatorPoolFees: string; // POL amount as decimal string
  equalValidatorPoolFees: string; // POL amount as decimal string
  equalPoolBurnFees: string; // POL amount as decimal string
  perfectPerformance: string; // Max observed performance delta for interval
  rewardedValidatorCount: number;
  validators: Record<number, ValidatorIntervalData>; // validatorId -> data
}

/**
 * Summary metadata for the entire calculation
 */
export interface CalculationMetadata {
  startPolygonBlock: number;
  endPolygonBlock: number;
  startTimestamp: number;
  endTimestamp: number;
  startTimestampISO: string;
  endTimestampISO: string;
  blockProducerCommission: number;
  stakersFeeRate: number;
  equalityFactor: number;
  totalIntervals: number;
  generatedAt: string;
}

/**
 * Summary statistics for the calculation
 */
export interface CalculationSummary {
  totalFeesCollected: string; // POL amount as decimal string
  totalPostCommissionPool: string; // POL amount as decimal string
  totalStakersPool: string; // POL amount as decimal string
  totalValidatorPool: string; // POL amount as decimal string
  totalStakeWeightedValidatorPool: string; // POL amount as decimal string
  totalEqualValidatorPool: string; // POL amount as decimal string
  totalEqualPoolBurn: string; // POL amount as decimal string
  validatorCount: number;
}

/**
 * Complete calculation result with interval details
 */
export interface CalculationResult {
  finalAllocations: Map<number, bigint>; // validatorId -> total allocated fees (bigint for precision)
  intervals: IntervalData[];
  metadata: CalculationMetadata;
  summary: CalculationSummary;
}

/**
 * Transfer file structure (for executing actual transfers)
 */
export interface TransferData {
  metadata: {
    startPolygonBlock: number;
    endPolygonBlock: number;
    totalAmount: string; // POL amount as decimal string
    validatorCount: number;
    blockProducerCommission: number;
    stakersFeeRate: number;
    equalityFactor: number;
    totalStakersPool: string;
    totalEqualPoolBurn: string;
    generatedAt: string;
  };
  allocations: Array<{
    validatorId: number;
    signer: string; // Signer wallet address from Polygon Staking API
    amount: string; // POL amount as decimal string
  }>;
}

/**
 * Distribution made from the fee address
 */
export interface Distribution {
  polygonBlock: number;
  amount: string; // POL amount as decimal string
  description?: string;
}

/**
 * Configuration file for tracking distributions
 */
export interface DistributionConfig {
  distributions: Distribution[];
}
