/**
 * Block mapper service for converting timestamps to block numbers across chains
 */

import { ethers } from 'ethers';
import { RpcService } from '../utils/rateLimit';
import { logger } from '../utils/logger';

export class BlockMapperService {
  private provider: ethers.JsonRpcProvider;
  private rpcService: RpcService;
  private cache: Map<number, number> = new Map(); // timestamp -> blockNumber
  private minPolygonBlock: number;
  private maxPolygonBlock: number;

  // Polygon PoS average block time in seconds
  private readonly POLYGON_AVG_BLOCK_TIME = 2.1;

  constructor(
    rpcUrl: string,
    rpcService: RpcService,
    minPolygonBlock: number,
    maxPolygonBlock: number
  ) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.rpcService = rpcService;
    this.minPolygonBlock = minPolygonBlock;
    this.maxPolygonBlock = maxPolygonBlock;
  }

  /**
   * Find the largest Polygon block number with timestamp strictly less than the target
   * Uses binary search with caching for efficiency
   *
   * This ensures we capture the state of the fee contract just before the Ethereum
   * StakeUpdate event occurred.
   */
  async findBlockByTimestamp(targetTimestamp: number): Promise<number> {
    // Check cache with exact timestamp
    if (this.cache.has(targetTimestamp)) {
      logger.debug(`Cache hit for timestamp ${targetTimestamp}`);
      return this.cache.get(targetTimestamp)!;
    }

    logger.debug(`Searching for largest Polygon block with timestamp < ${targetTimestamp}`);

    // Use explicit block boundaries for binary search
    let result = await this.binarySearchForBlock(
      targetTimestamp,
      this.minPolygonBlock,
      this.maxPolygonBlock
    );

    // Validate result - ensure it's actually before the target
    const resultBlock = await this.rpcService.call(() => this.provider.getBlock(result));
    if (!resultBlock) {
      throw new Error(`Failed to fetch result block ${result}`);
    }

    if (resultBlock.timestamp >= targetTimestamp) {
      throw new Error(
        `Binary search failed to find valid block. ` +
        `Result block ${result} has timestamp ${resultBlock.timestamp} >= target ${targetTimestamp}. ` +
        `Search range was ${this.minPolygonBlock} to ${this.maxPolygonBlock}`
      );
    }

    const timeDiffSeconds = targetTimestamp - resultBlock.timestamp;
    logger.debug(
      `Found block ${result} at timestamp ${resultBlock.timestamp} ` +
      `(${timeDiffSeconds}s before target ${targetTimestamp})`
    );

    // Warn if result is suspiciously far from target (more than 1 minute)
    if (timeDiffSeconds > 60) {
      logger.warn(
        `Block ${result} is ${timeDiffSeconds}s before target - may indicate block time drift or search issues`
      );
    }

    this.cache.set(targetTimestamp, result);
    return result;
  }

  /**
   * Binary search helper to find largest block with timestamp < target
   */
  private async binarySearchForBlock(
    targetTimestamp: number,
    left: number,
    right: number
  ): Promise<number> {
    let result = left;

    logger.debug(`Binary search range: ${left} to ${right}`);

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);

      let block;
      try {
        block = await this.rpcService.call(() => this.provider.getBlock(mid));
      } catch (error) {
        logger.warn(`Failed to fetch block ${mid}, adjusting search range`);
        right = mid - 1;
        continue;
      }

      if (!block) {
        right = mid - 1;
        continue;
      }

      // We want the largest block where timestamp < targetTimestamp
      if (block.timestamp < targetTimestamp) {
        // This block qualifies, but there might be a larger one
        result = mid;
        left = mid + 1; // Search for larger blocks
      } else {
        // This block's timestamp >= targetTimestamp, search smaller blocks
        right = mid - 1;
      }
    }

    return result;
  }

  /**
   * Estimate block number based on average block time
   * This provides a good starting point for binary search
   */
  private async estimateBlockNumber(targetTimestamp: number): Promise<number> {
    const latestBlock = await this.rpcService.call(() => this.provider.getBlock('latest'));

    if (!latestBlock) {
      throw new Error('Failed to fetch latest block');
    }

    const timeDiff = latestBlock.timestamp - targetTimestamp;
    const blockDiff = Math.floor(timeDiff / this.POLYGON_AVG_BLOCK_TIME);
    const estimatedBlock = latestBlock.number - blockDiff;

    logger.debug(
      `Estimated block: ${estimatedBlock} (latest: ${latestBlock.number}, diff: ${blockDiff})`
    );

    return Math.max(1, estimatedBlock);
  }

  /**
   * Batch find blocks for multiple timestamps
   * More efficient than individual queries
   */
  async findBlocksForTimestamps(timestamps: number[]): Promise<Map<number, number>> {
    const results = new Map<number, number>();

    logger.info(`Finding blocks for ${timestamps.length} timestamps`);

    // Sort timestamps to optimize search
    const sortedTimestamps = [...timestamps].sort((a, b) => a - b);

    for (let i = 0; i < sortedTimestamps.length; i++) {
      const timestamp = sortedTimestamps[i];
      logger.debug(`Processing timestamp ${i + 1}/${sortedTimestamps.length}`);

      const blockNumber = await this.findBlockByTimestamp(timestamp);
      results.set(timestamp, blockNumber);
    }

    logger.info(`Successfully mapped ${results.size} timestamps to blocks`);
    return results;
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
    logger.debug('Block mapper cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; entries: Array<{ timestamp: number; block: number }> } {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.entries()).map(([timestamp, block]) => ({
        timestamp,
        block,
      })),
    };
  }
}
