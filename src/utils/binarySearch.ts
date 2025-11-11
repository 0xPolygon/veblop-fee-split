/**
 * Binary Search Utilities
 *
 * Generic binary search implementations for finding blocks by timestamp
 * across different blockchain data sources.
 */

import { logger } from './logger';

/**
 * Interface for a block with timestamp
 */
export interface TimestampedBlock {
  number: number;
  timestamp: number;
}

/**
 * Interface for block fetcher function
 */
export type BlockFetcher = (blockNumber: number) => Promise<TimestampedBlock | null>;

/**
 * Binary search to find the largest block with timestamp less than or equal to target
 * Use this when you need the latest block at or before a specific timestamp
 * (e.g., querying state that was valid at a specific point in time)
 *
 * @param targetTimestamp - Target timestamp to search for
 * @param minBlock - Minimum block number to search
 * @param maxBlock - Maximum block number to search
 * @param fetchBlock - Function to fetch block data by number
 * @returns Block number of largest block with timestamp <= targetTimestamp
 */
export async function binarySearchBlockByTimestampLte(
  targetTimestamp: number,
  minBlock: number,
  maxBlock: number,
  fetchBlock: BlockFetcher
): Promise<number> {
  let left = minBlock;
  let right = maxBlock;
  let result = left;

  logger.debug(`Binary search (<=) range: ${left} to ${right} for timestamp ${targetTimestamp}`);

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);

    let block: TimestampedBlock | null;
    try {
      block = await fetchBlock(mid);
    } catch (error) {
      logger.warn(`Failed to fetch block ${mid}, searching earlier blocks`, {
        error: error instanceof Error ? error.message : String(error)
      });
      right = mid - 1;
      continue;
    }

    if (!block) {
      logger.debug(`Block ${mid} not found, searching earlier blocks`);
      right = mid - 1;
      continue;
    }

    logger.debug(`Checking block ${mid}: timestamp=${block.timestamp}, target=${targetTimestamp}`);

    // We want the largest block where timestamp <= targetTimestamp
    if (block.timestamp <= targetTimestamp) {
      // This block qualifies, but there might be a larger one
      result = mid;
      left = mid + 1; // Search for larger blocks
      logger.debug(`Block ${mid} qualifies (timestamp <= target), searching higher`);
    } else {
      // This block's timestamp > targetTimestamp, search smaller blocks
      right = mid - 1;
      logger.debug(`Block ${mid} too late (timestamp > target), searching lower`);
    }
  }

  logger.debug(`Binary search (<=) result: block ${result}`);
  return result;
}

/**
 * Binary search to find the smallest block with timestamp greater than or equal to target
 * This is the inverse of binarySearchBlockByTimestamp
 *
 * @param targetTimestamp - Target timestamp to search for
 * @param minBlock - Minimum block number to search
 * @param maxBlock - Maximum block number to search
 * @param fetchBlock - Function to fetch block data by number
 * @returns Block number of smallest block with timestamp >= targetTimestamp
 */
export async function binarySearchBlockByTimestampGte(
  targetTimestamp: number,
  minBlock: number,
  maxBlock: number,
  fetchBlock: BlockFetcher
): Promise<number> {
  let left = minBlock;
  let right = maxBlock;
  let result = right;

  logger.debug(`Binary search (>=) range: ${left} to ${right} for timestamp ${targetTimestamp}`);

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);

    let block: TimestampedBlock | null;
    try {
      block = await fetchBlock(mid);
    } catch (error) {
      logger.warn(`Failed to fetch block ${mid}, searching earlier blocks`, {
        error: error instanceof Error ? error.message : String(error)
      });
      right = mid - 1;
      continue;
    }

    if (!block) {
      logger.debug(`Block ${mid} not found, searching earlier blocks`);
      right = mid - 1;
      continue;
    }

    logger.debug(`Checking block ${mid}: timestamp=${block.timestamp}, target=${targetTimestamp}`);

    // We want the smallest block where timestamp >= targetTimestamp
    if (block.timestamp >= targetTimestamp) {
      // This block qualifies, but there might be a smaller one
      result = mid;
      right = mid - 1; // Search for smaller blocks
      logger.debug(`Block ${mid} qualifies (timestamp >= target), searching lower`);
    } else {
      // This block's timestamp < targetTimestamp, search larger blocks
      left = mid + 1;
      logger.debug(`Block ${mid} too early (timestamp < target), searching higher`);
    }
  }

  logger.debug(`Binary search (>=) result: block ${result}`);
  return result;
}

/**
 * Validate that a block is truly before the target timestamp
 *
 * @param blockNumber - Block number to validate
 * @param targetTimestamp - Target timestamp
 * @param fetchBlock - Function to fetch block data
 * @param chainName - Name of the chain (for logging)
 * @returns The validated block
 * @throws Error if validation fails
 */
export async function validateBlockNearTimestamp(
  blockNumber: number,
  targetTimestamp: number,
  fetchBlock: BlockFetcher,
  chainName: string = 'Chain'
): Promise<TimestampedBlock> {
  const block = await fetchBlock(blockNumber);

  if (!block) {
    throw new Error(
      `${chainName}: Failed to fetch result block ${blockNumber} for validation`
    );
  }

  const timeDiffSeconds = Math.abs(targetTimestamp - block.timestamp);
  logger.debug(
    `${chainName}: Validated block ${blockNumber} at timestamp ${block.timestamp} ` +
    `(${timeDiffSeconds}s before target ${targetTimestamp})`
  );

  // Warn if result is suspiciously far from target (more than 1 minute)
  if (timeDiffSeconds > 60) {
    throw new Error(
      `${chainName}: Block ${blockNumber} is ${timeDiffSeconds}s before target - ` +
      `may indicate block time drift or search issues`
    );
  }

  return block;
}

/**
 * Cache implementation for block timestamp mappings
 */
export class BlockTimestampCache {
  private timestampToBlock = new Map<number, number>();
  private blockToTimestamp = new Map<number, number>();

  /**
   * Get block number for timestamp
   */
  getBlock(timestamp: number): number | undefined {
    return this.timestampToBlock.get(timestamp);
  }

  /**
   * Get timestamp for block number
   */
  getTimestamp(blockNumber: number): number | undefined {
    return this.blockToTimestamp.get(blockNumber);
  }

  /**
   * Set block-timestamp mapping (bidirectional)
   */
  set(timestamp: number, blockNumber: number): void {
    this.timestampToBlock.set(timestamp, blockNumber);
    this.blockToTimestamp.set(blockNumber, timestamp);
  }

  /**
   * Check if timestamp is cached
   */
  hasTimestamp(timestamp: number): boolean {
    return this.timestampToBlock.has(timestamp);
  }

  /**
   * Check if block is cached
   */
  hasBlock(blockNumber: number): boolean {
    return this.blockToTimestamp.has(blockNumber);
  }

  /**
   * Clear cache
   */
  clear(): void {
    this.timestampToBlock.clear();
    this.blockToTimestamp.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    entries: Array<{ timestamp: number; block: number }>;
  } {
    return {
      size: this.timestampToBlock.size,
      entries: Array.from(this.timestampToBlock.entries()).map(
        ([timestamp, block]) => ({ timestamp, block })
      ),
    };
  }
}
