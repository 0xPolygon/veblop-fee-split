/**
 * Heimdall service for querying validator performance scores
 * Uses Tendermint ABCI queries to get historical performance data at specific block heights
 */

import axios from 'axios';
import { PerformanceScore } from '../models/types';
import { logger } from '../utils/logger';
import { RpcService } from '../utils/rateLimit';
import { HeimdallBlockMapperService } from './heimdallBlockMapper.service';

interface TendermintAbciQueryResponse {
  jsonrpc: string;
  id: number;
  result: {
    response: {
      code: number;
      value?: string; // Base64 encoded
      height: string;
    };
  };
}

export class HeimdallService {
  private rpcUrl: string;
  private rpcService: RpcService;
  private blockMapper: HeimdallBlockMapperService;

  constructor(rpcUrl: string, rpcService: RpcService, blockMapper: HeimdallBlockMapperService) {
    this.rpcUrl = rpcUrl;
    this.rpcService = rpcService;
    this.blockMapper = blockMapper;
  }

  /**
   * Query interval-based performance scores for validators
   * Queries Heimdall at each timestamp
   *
   * @param stakeUpdateTimestamps - Unique timestamps when stake updates occurred
   * @param validatorIds - List of validator IDs to query
   * @returns Map of interval number to (validator ID -> performance delta)
   */
  async queryPerformanceScores(
    uniqueTimestamps: number[],
    validatorIds: number[]
  ): Promise<{
    performanceScores: PerformanceScore[];
  }> {
    logger.info(`Heimdall: Querying performance scores for ${validatorIds.length} validators across ${uniqueTimestamps.length} timestamps`);

    const performanceScores: PerformanceScore[] = [];

    for (const timestamp of uniqueTimestamps) {
      const performanceScore = await this.queryPerformanceScoreByTimestamp(timestamp, validatorIds);
      performanceScores.push(performanceScore);
    }

    logger.info(`Heimdall: Mapped ${performanceScores.length} timestamps to Heimdall blocks`);

    return { performanceScores };
  }

  async queryPerformanceScoreByTimestamp(
    timestamp: number,
    validatorIds: number[]
  ): Promise<PerformanceScore> {
    logger.info(`Heimdall: Querying performance scores for ${validatorIds.length} validators at timestamp ${timestamp}`);
    // Map Ethereum timestamps to Heimdall blocks
    const heimdallBlock = await this.blockMapper.findBlockByTimestamp(timestamp);
    logger.info(`Heimdall: Found Heimdall block ${heimdallBlock.height} for timestamp ${timestamp}`);
    const scores = await this.queryAllPerformanceScoresAtHeight(
      validatorIds,
      heimdallBlock.height
    );
    return {
      ethereumTimestamp: timestamp,
      heimdallBlock: heimdallBlock.height,
      performanceScores: scores
    };
  }

  /**
   * Generate storage key for validator performance score
   * Format: 0x3A (prefix) + validator ID as uint64 big-endian
   */
  private generatePerformanceScoreKey(validatorId: number): string {
    // Create 8-byte buffer for uint64
    const buffer = Buffer.allocUnsafe(8);
    // Write as big-endian uint64
    buffer.writeBigUInt64BE(BigInt(validatorId), 0);

    // Prefix for PerformanceScore (0x3A)
    const prefix = Buffer.from([0x3A]);

    // Combine prefix + validator_id
    const fullKey = Buffer.concat([prefix, buffer]);

    return fullKey.toString('hex');
  }

  /**
   * Query performance score for a specific validator at a specific Heimdall block height
   * Uses Tendermint ABCI query to access Bor module state
   *
   * @param validatorId - Validator ID
   * @param height - Heimdall block height (0 for latest)
   * @returns Raw performance score (uint64) or null if not found
   */
  async queryPerformanceScoreAtHeight(
    validatorId: number,
    height: number
  ): Promise<bigint | null> {
    const keyHex = this.generatePerformanceScoreKey(validatorId);

    const executeQuery = async () => {
      const response = await axios.post<TendermintAbciQueryResponse>(
        this.rpcUrl,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'abci_query',
          params: {
            path: '/store/bor/key',
            data: keyHex,
            height: height.toString(),
            prove: false
          }
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );

      return response.data;
    };

    try {
      const response = this.rpcService
        ? await this.rpcService.call(executeQuery)
        : await executeQuery();

      if (!response.result?.response) {
        logger.warn(`No response data for validator ${validatorId} at height ${height}`);
        return null;
      }

      const responseData = response.result.response;

      // Check if key exists (code 0 = success)
      if (responseData.code !== 0) {
        logger.debug(`Validator ${validatorId} not found at height ${height} (code: ${responseData.code})`);
        return null;
      }

      const valueB64 = responseData.value;
      if (!valueB64) {
        logger.debug(`No value for validator ${validatorId} at height ${height}`);
        return null;
      }

      // Decode base64 and parse as uint64 big-endian
      const valueBytes = Buffer.from(valueB64, 'base64');
      if (valueBytes.length !== 8) {
        throw new Error(
          `Unexpected value length for validator ${validatorId} at height ${height}: ` +
          `${valueBytes.length} bytes (expected 8)`
        );
      }

      const score = valueBytes.readBigUInt64BE(0);
      logger.debug(`Validator ${validatorId} at height ${height}: score=${score}`);

      return score;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.error(`Error querying validator ${validatorId} at height ${height}`, {
          status: error.response?.status,
          message: error.message
        });
        throw new Error(
          `Failed to query performance score for validator ${validatorId} at height ${height}: ${error.message}`
        );
      }
      throw error;
    }
  }

  /**
   * Query performance scores for all validators at a specific Heimdall block height
   * Uses rate-limited parallel queries
   *
   * @param validatorIds - Array of validator IDs to query
   * @param height - Heimdall block height
   * @returns Map of validator ID to raw performance score (bigint)
   */
  async queryAllPerformanceScoresAtHeight(
    validatorIds: number[],
    height: number
  ): Promise<Map<number, bigint>> {
    logger.info(`Querying performance scores for ${validatorIds.length} validators at Heimdall height ${height}`);

    const scores = new Map<number, bigint>();
    let successCount = 0;
    let notFoundCount = 0;

    // Query all validators in parallel (rate limiting handled by RpcService)
    const promises = validatorIds.map(async (validatorId) => {
      const score = await this.queryPerformanceScoreAtHeight(validatorId, height);

      if (score !== null) {
        scores.set(validatorId, score);
        logger.debug(`Score for validator ${validatorId} at height ${height}: ${score}`);
        successCount++;
      } else {
        // Validator doesn't exist at this height, set score to 0
        scores.set(validatorId, 0n);
        notFoundCount++;
      }
    });

    await Promise.all(promises);

    logger.info(
      `Successfully queried ${successCount} validators at height ${height} ` +
      `(${notFoundCount} not found, set to 0)`
    );

    return scores;
  }
}
