/**
 * Heimdall Block Mapper Service
 *
 * Maps Ethereum timestamps to Heimdall block numbers using binary search.
 * Uses Tendermint RPC to query block information.
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import { RpcService } from '../utils/rateLimit';
import { HeimdallBlockInfo } from '../models/types';
import {
  validateBlockNearTimestamp,
  BlockTimestampCache,
  TimestampedBlock,
  binarySearchBlockByTimestampGte
} from '../utils/binarySearch';

interface TendermintStatusResponse {
  jsonrpc: string;
  id: number;
  result: {
    sync_info: {
      latest_block_height: string;
      latest_block_time: string;
    };
  };
}

interface TendermintBlockResponse {
  jsonrpc: string;
  id: number;
  result: {
    block: {
      header: {
        height: string;
        time: string;
      };
    };
  };
}

export class HeimdallBlockMapperService {
  private rpcService: RpcService;
  private rpcUrl: string;
  private blockCache: Map<number, HeimdallBlockInfo> = new Map();
  private cache: BlockTimestampCache;

  constructor(rpcUrl: string, rpcService: RpcService) {
    this.rpcUrl = rpcUrl;
    this.rpcService = rpcService;
    this.cache = new BlockTimestampCache();
  }

  /**
   * Get current Heimdall block height
   */
  async getCurrentBlockHeight(): Promise<number> {
    logger.debug('Querying current Heimdall block height');

    const response = await this.rpcService.call<TendermintStatusResponse>(async () => {
      const result = await axios.post(
        this.rpcUrl,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'status',
          params: []
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );
      return result.data;
    });

    if (!response.result?.sync_info?.latest_block_height) {
      throw new Error('Invalid response format from Heimdall status query');
    }

    const height = parseInt(response.result.sync_info.latest_block_height, 10);
    logger.info(`Current Heimdall block height: ${height}`);

    return height;
  }

  /**
   * Get block information at specific height
   */
  async getBlockInfo(height: number): Promise<HeimdallBlockInfo> {
    // Check cache first
    if (this.blockCache.has(height)) {
      return this.blockCache.get(height)!;
    }

    logger.debug(`Querying Heimdall block ${height}`);

    const response = await this.rpcService.call<TendermintBlockResponse>(async () => {
      const result = await axios.post(
        this.rpcUrl,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'block',
          params: {
            height: height.toString()
          }
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );
      return result.data;
    });

    if (!response.result?.block?.header) {
      throw new Error(`Invalid response format from Heimdall block query for height ${height}`);
    }

    const header = response.result.block.header;
    const timestampISO = header.time;
    const timestamp = Math.floor(new Date(timestampISO).getTime() / 1000);

    const blockInfo: HeimdallBlockInfo = {
      height: parseInt(header.height, 10),
      timestamp,
      timestampISO
    };

    // Cache the result
    this.blockCache.set(height, blockInfo);
    this.cache.set(timestamp, height);

    return blockInfo;
  }

  /**
   * Find smallest Heimdall block with a timestamp greater than or equal to the target using binary search
   * Returns the smallest Heimdall block with timestamp greater than or equal to the target
   *
   * @param ethereumTimestamp - Unix timestamp in seconds
   * @returns Heimdall block info
   */
  async findBlockByTimestamp(ethereumTimestamp: number): Promise<HeimdallBlockInfo> {
    logger.debug(`Heimdall: Finding block for Ethereum timestamp ${ethereumTimestamp} (${new Date(ethereumTimestamp * 1000).toISOString()})`);

    // Check timestamp cache first
    const cachedHeight = this.cache.getBlock(ethereumTimestamp);
    if (cachedHeight !== undefined) {
      logger.debug(`Heimdall: Cache hit for timestamp ${ethereumTimestamp}`);
      return this.getBlockInfo(cachedHeight);
    }

    const currentHeight = await this.getCurrentBlockHeight();
    const currentBlock = await this.getBlockInfo(currentHeight);

    // Validate timestamp is not in the future
    if (ethereumTimestamp > currentBlock.timestamp) {
      throw new Error(
        `Heimdall: Target timestamp ${ethereumTimestamp} (${new Date(ethereumTimestamp * 1000).toISOString()}) ` +
        `is after current Heimdall block time ${currentBlock.timestamp} ` +
        `(${currentBlock.timestampISO}). Cannot query future blocks.`
      );
    }

    // Create block fetcher for binary search utility
    const fetchBlock = async (height: number): Promise<TimestampedBlock | null> => {
      try {
        const info = await this.getBlockInfo(height);
        return {
          number: info.height,
          timestamp: info.timestamp
        };
      } catch (error) {
        throw new Error(`Heimdall: Failed to fetch block ${height}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    // Use shared binary search utility
    const resultHeight = await binarySearchBlockByTimestampGte(
      ethereumTimestamp,
      30000000, // a block a few days before VEBloP started
      currentHeight,
      fetchBlock
    );

    logger.debug(`Heimdall: Binary search returned block ${resultHeight}`);

    // Validate result using shared utility
    await validateBlockNearTimestamp(resultHeight, ethereumTimestamp, fetchBlock, 'Heimdall');

    // Get full block info for result
    const resultBlock = await this.getBlockInfo(resultHeight);

    logger.info(
      `Heimdall: Mapped Ethereum timestamp ${ethereumTimestamp} (${new Date(ethereumTimestamp * 1000).toISOString()}) ` +
      `to Heimdall block ${resultBlock.height} (${resultBlock.timestampISO})`
    );

    // Cache this mapping
    this.cache.set(ethereumTimestamp, resultBlock.height);

    return resultBlock;
  }

  /**
   * Clear caches (useful for testing)
   */
  clearCache(): void {
    this.blockCache.clear();
    this.cache.clear();
    logger.debug('Heimdall block mapper cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    blockCacheSize: number;
    timestampCacheSize: number;
    timestampEntries: Array<{ timestamp: number; block: number }>;
  } {
    const timestampStats = this.cache.getStats();
    return {
      blockCacheSize: this.blockCache.size,
      timestampCacheSize: timestampStats.size,
      timestampEntries: timestampStats.entries
    };
  }
}
