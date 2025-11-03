/**
 * Ethereum service for querying StakeUpdate events
 */

import { ethers, Contract, EventLog } from 'ethers';
import { StakeUpdateEvent } from '../models/types';
import { STAKING_CONTRACT_ABI } from '../config/contracts';
import { RpcService } from '../utils/rateLimit';
import { logger, logProgress } from '../utils/logger';

export class EthereumService {
  private provider: ethers.JsonRpcProvider;
  private contract: Contract;
  private rpcService: RpcService;

  constructor(
    rpcUrl: string,
    contractAddress: string,
    rpcService: RpcService
  ) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.contract = new Contract(contractAddress, STAKING_CONTRACT_ABI, this.provider);
    this.rpcService = rpcService;
  }

  /**
   * Get StakeUpdate events for the specified time period
   */
  async getStakeUpdateEvents(daysBack: number): Promise<StakeUpdateEvent[]> {
    logger.info(`Fetching StakeUpdate events for the last ${daysBack} days`);

    // Get current block
    const currentBlock = await this.rpcService.call(() => this.provider.getBlockNumber());
    const currentBlockData = await this.rpcService.call(() =>
      this.provider.getBlock(currentBlock)
    );

    if (!currentBlockData) {
      throw new Error('Failed to fetch current block data');
    }

    // Calculate target timestamp
    const targetTimestamp = currentBlockData.timestamp - (daysBack * 24 * 60 * 60);
    logger.info(`Target timestamp: ${targetTimestamp} (${new Date(targetTimestamp * 1000).toISOString()})`);

    // Find starting block using binary search
    const fromBlock = await this.findBlockByTimestamp(targetTimestamp);
    logger.info(`Block range: ${fromBlock} to ${currentBlock} (${currentBlock - fromBlock} blocks)`);

    // Query events in chunks
    const events = await this.queryEventsInChunks(fromBlock, currentBlock);

    logger.info(`Found ${events.length} StakeUpdate events`);
    return events;
  }

  /**
   * Get StakeUpdate events for the specified timestamp range
   */
  async getStakeUpdateEventsByTimestamp(
    startTimestamp: number,
    endTimestamp: number
  ): Promise<StakeUpdateEvent[]> {
    logger.info(
      `Fetching StakeUpdate events between timestamps ${startTimestamp} (${new Date(startTimestamp * 1000).toISOString()}) ` +
      `and ${endTimestamp} (${new Date(endTimestamp * 1000).toISOString()})`
    );

    // Find Ethereum block numbers for the timestamp range
    const fromBlock = await this.findBlockByTimestamp(startTimestamp);
    const toBlock = await this.findBlockByTimestamp(endTimestamp);

    logger.info(`Ethereum block range: ${fromBlock} to ${toBlock} (${toBlock - fromBlock} blocks)`);

    // Query events in chunks
    const events = await this.queryEventsInChunks(fromBlock, toBlock);

    logger.info(`Found ${events.length} StakeUpdate events`);
    return events;
  }

  /**
   * Find block number by timestamp using binary search
   */
  async findBlockByTimestamp(targetTimestamp: number): Promise<number> {
    logger.info('Searching for Ethereum block using binary search...');

    let left = 1;
    let right = await this.rpcService.call(() => this.provider.getBlockNumber());
    let result = right;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const block = await this.rpcService.call(() => this.provider.getBlock(mid));

      if (!block) {
        right = mid - 1;
        continue;
      }

      if (block.timestamp >= targetTimestamp) {
        result = mid;
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }

    return result;
  }

  /**
   * Query events in chunks to avoid RPC limits
   */
  private async queryEventsInChunks(
    fromBlock: number,
    toBlock: number,
    chunkSize: number = 5000
  ): Promise<StakeUpdateEvent[]> {
    const events: StakeUpdateEvent[] = [];
    const totalBlocks = toBlock - fromBlock + 1;
    const totalChunks = Math.ceil(totalBlocks / chunkSize);

    logger.info(`Querying events in ${totalChunks} chunks of ${chunkSize} blocks each`);

    for (let i = 0; i < totalChunks; i++) {
      const startBlock = fromBlock + (i * chunkSize);
      const endBlock = Math.min(startBlock + chunkSize - 1, toBlock);

      logProgress('Querying events', i + 1, totalChunks);

      try {
        const chunkEvents = await this.queryEventChunk(startBlock, endBlock);
        events.push(...chunkEvents);
      } catch (error) {
        logger.error(`Failed to query events for blocks ${startBlock}-${endBlock}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    return events;
  }

  /**
   * Query events for a single chunk of blocks
   */
  private async queryEventChunk(fromBlock: number, toBlock: number): Promise<StakeUpdateEvent[]> {
    const events: StakeUpdateEvent[] = [];

    // Query StakeUpdate events
    const filter = this.contract.filters.StakeUpdate();
    const logs = await this.rpcService.call(() =>
      this.contract.queryFilter(filter, fromBlock, toBlock)
    );

    logger.debug(`Query chunk ${fromBlock}-${toBlock}: found ${logs.length} raw logs`);

    // Process each event
    for (const log of logs) {
      logger.debug(`Processing log: ${log.constructor.name}`);

      if (log instanceof EventLog) {
        logger.debug(`EventLog validated, getting block ${log.blockNumber}`);
        // Get block timestamp
        const block = await this.rpcService.call(() =>
          this.provider.getBlock(log.blockNumber)
        );

        if (!block) {
          logger.warn(`Failed to fetch block ${log.blockNumber}, skipping event`);
          continue;
        }

        logger.debug(`Adding event for validator ${log.args.validatorId}`);
        events.push({
          validatorId: log.args.validatorId,
          newAmount: log.args.newAmount,
          blockNumber: log.blockNumber,
          blockTimestamp: block.timestamp,
          transactionHash: log.transactionHash,
        });
      } else {
        logger.debug(`Log is not EventLog, skipping`);
      }
    }

    logger.debug(`Processed chunk ${fromBlock}-${toBlock}: returning ${events.length} events`);
    return events;
  }

  /**
   * Get current block number
   */
  async getCurrentBlock(): Promise<number> {
    return this.rpcService.call(() => this.provider.getBlockNumber());
  }

  /**
   * Get block by number
   */
  async getBlock(blockNumber: number) {
    return this.rpcService.call(() => this.provider.getBlock(blockNumber));
  }

  /**
   * Get validator stake amount at a specific Ethereum block
   */
  async getValidatorStake(validatorId: number, blockNumber: number): Promise<bigint> {
    logger.debug(`Querying stake for validator ${validatorId} at Ethereum block ${blockNumber}`);

    const stake = await this.rpcService.call(() =>
      this.contract.totalValidatorStake(validatorId, { blockTag: blockNumber })
    );

    return stake;
  }

  /**
   * Get stakes for multiple validators at a specific block
   *
   * IMPORTANT: Fails if any validator stake query fails to ensure data integrity
   */
  async getValidatorStakes(
    validatorIds: number[],
    blockNumber: number
  ): Promise<Map<number, bigint>> {
    logger.info(`Querying stakes for ${validatorIds.length} validators at Ethereum block ${blockNumber}`);

    if (validatorIds.length === 0) {
      throw new Error('No validator IDs provided for stake query');
    }

    const stakes = new Map<number, bigint>();
    const errors: Array<{ validatorId: number; error: string }> = [];

    // Query in parallel with rate limiting handled by RpcService
    const promises = validatorIds.map(async (validatorId) => {
      try {
        const stake = await this.getValidatorStake(validatorId, blockNumber);

        if (stake < 0n) {
          errors.push({
            validatorId,
            error: `Negative stake value: ${stake}. This indicates corrupted contract data.`
          });
          return;
        }

        stakes.set(validatorId, stake);
        logger.debug(`Validator ${validatorId}: ${ethers.formatEther(stake)} POL`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to fetch stake for validator ${validatorId}`, {
          error: errorMsg,
          blockNumber,
        });
        errors.push({
          validatorId,
          error: errorMsg
        });
      }
    });

    await Promise.all(promises);

    // Fail if any queries failed
    if (errors.length > 0) {
      const errorDetails = errors.map(e => `  - Validator ${e.validatorId}: ${e.error}`).join('\n');
      throw new Error(
        `Failed to query stakes for ${errors.length} validator(s) at block ${blockNumber}:\n${errorDetails}\n\n` +
        `Cannot proceed with fee calculation - all validator stakes must be available.`
      );
    }

    // Verify we got all stakes
    if (stakes.size !== validatorIds.length) {
      throw new Error(
        `Stake count mismatch: expected ${validatorIds.length} but got ${stakes.size}. ` +
        `This indicates a data integrity issue.`
      );
    }

    logger.info(`Successfully queried ${stakes.size} validator stakes`);
    return stakes;
  }
}
