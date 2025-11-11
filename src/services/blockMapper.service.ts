/**
 * Block mapper service for converting timestamps to block numbers across chains
 */

import { ethers } from 'ethers';
import { RpcService } from '../utils/rateLimit';
import { logger } from '../utils/logger';
import {
  validateBlockNearTimestamp,
  BlockTimestampCache,
  TimestampedBlock,
  binarySearchBlockByTimestampGte
} from '../utils/binarySearch';

export class BlockMapperService {
  private provider: ethers.JsonRpcProvider;
  private rpcService: RpcService;
  private cache: BlockTimestampCache;
  private minPolygonBlock: number;
  private maxPolygonBlock: number;

  constructor(
    rpcUrl: string,
    rpcService: RpcService,
    minPolygonBlock: number,
    maxPolygonBlock: number
  ) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.rpcService = rpcService;
    this.cache = new BlockTimestampCache();
    this.minPolygonBlock = minPolygonBlock;
    this.maxPolygonBlock = maxPolygonBlock;
  }

  /**
   * Find the smallest Polygon block number with timestamp greater than or equal to the target
   * Uses binary search with caching for efficiency
   *
   * This ensures we capture the state of the fee contract just before the Ethereum
   * StakeUpdate event occurred.
   */
  async findBlockByTimestamp(targetTimestamp: number): Promise<number> {
    // Check cache with exact timestamp
    const cachedBlock = this.cache.getBlock(targetTimestamp);
    if (cachedBlock !== undefined) {
      logger.debug(`Polygon: Cache hit for timestamp ${targetTimestamp}`);
      return cachedBlock;
    }

    logger.debug(`Polygon: Searching for largest block with timestamp < ${targetTimestamp}`);

    // Create block fetcher that uses our RPC service
    const fetchBlock = async (blockNumber: number): Promise<TimestampedBlock | null> => {
      const block = await this.rpcService.call(() => this.provider.getBlock(blockNumber));
      if (!block) return null;
      return {
        number: block.number,
        timestamp: block.timestamp
      };
    };

    // Use shared binary search utility
    const result = await binarySearchBlockByTimestampGte(
      targetTimestamp,
      this.minPolygonBlock,
      this.maxPolygonBlock,
      fetchBlock
    );

    // Validate result using shared utility
    await validateBlockNearTimestamp(result, targetTimestamp, fetchBlock, 'Polygon');

    this.cache.set(targetTimestamp, result);
    return result;
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
    return this.cache.getStats();
  }
}
