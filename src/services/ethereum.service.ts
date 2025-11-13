/**
 * Ethereum service for querying StakeUpdate events
 */

import { ethers, Contract, EventLog } from 'ethers';
import { StakeUpdateEvent } from '../models/types';
import { STAKING_CONTRACT_ABI } from '../config/contracts';
import { RpcService } from '../utils/rateLimit';
import { logger, logProgress } from '../utils/logger';
import { binarySearchBlockByTimestampGte, binarySearchBlockByTimestampLte, TimestampedBlock } from '../utils/binarySearch';

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
   * Get StakeUpdate events for the specified timestamp range
   */
  async getStakeUpdateEventsByBlocks(
    startBlock: number,
    endBlock: number
  ): Promise<StakeUpdateEvent[]> {
    logger.info(
      `Fetching StakeUpdate events between blocks ${startBlock} and ${endBlock}`
    );

    // Query events in chunks
    const events = await this.queryEventsInChunks(startBlock, endBlock);

    logger.info(`Found ${events.length} StakeUpdate events`);
    return events;
  }

  /**
   * Find Ethereum block before a specific timestamp
   * Returns the largest block with timestamp <= target
   * Use this when you need to e.g. query contract state that was valid at a specific time
   * (e.g., validator stakes at the start of a period)
   */
  async findBlockBeforeTimestamp(targetTimestamp: number): Promise<[number, number]> {
    logger.info(`Ethereum: Searching for latest block with timestamp <= ${targetTimestamp}`);

    const currentHeight = await this.rpcService.call(() => this.provider.getBlockNumber());

    // Create block fetcher that uses our RPC service
    const fetchBlock = async (blockNumber: number): Promise<TimestampedBlock | null> => {
      const block = await this.rpcService.call(() => this.provider.getBlock(blockNumber));
      if (!block) return null;
      return {
        number: block.number,
        timestamp: block.timestamp
      };
    };

    // Use shared binary search utility (<= variant)
    const result = await binarySearchBlockByTimestampLte(
      targetTimestamp,
      23513590, //a block from a few days before VEBloP started
      currentHeight,
      fetchBlock
    );

    // Validate result
    const resultBlock = await fetchBlock(result);
    if (!resultBlock) {
      throw new Error(`Ethereum: Failed to fetch result block ${result}`);
    }

    if (resultBlock.timestamp > targetTimestamp) {
      throw new Error(
        `Ethereum: Binary search failed. Block ${result} has timestamp ${resultBlock.timestamp} > target ${targetTimestamp}`
      );
    }

    logger.info(
      `Ethereum: Found block ${result} with timestamp ${resultBlock.timestamp} ` +
      `(target was ${targetTimestamp}, diff: ${targetTimestamp - resultBlock.timestamp}s)`
    );

    return [result, resultBlock.timestamp];
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
    const stakeUpdateFilter = this.contract.filters.StakeUpdate();
    const stakeUpdateLogs = await this.rpcService.call(() =>
      this.contract.queryFilter(stakeUpdateFilter, fromBlock, toBlock)
    );

    logger.debug(`Query chunk ${fromBlock}-${toBlock}: found ${stakeUpdateLogs.length} StakeUpdate logs`);

    // Query Staked events (initial validator onboarding)
    const stakedFilter = this.contract.filters.Staked();
    const stakedLogs = await this.rpcService.call(() =>
      this.contract.queryFilter(stakedFilter, fromBlock, toBlock)
    );

    logger.debug(`Query chunk ${fromBlock}-${toBlock}: found ${stakedLogs.length} Staked logs`);

    // Process StakeUpdate events
    for (const log of stakeUpdateLogs) {
      logger.debug(`Processing StakeUpdate log: ${log.constructor.name}`);

      if (log instanceof EventLog) {
        logger.debug(`EventLog validated, getting block ${log.blockNumber}`);
        // Get block timestamp
        const block = await this.rpcService.call(() =>
          this.provider.getBlock(log.blockNumber)
        );

        if (!block) {
          logger.error(`Failed to fetch block ${log.blockNumber}, aborting`);
          throw new Error(`Failed to fetch block ${log.blockNumber}; cannot process events due to missing timestamp`);
        }

        logger.debug(`Adding StakeUpdate event for validator ${log.args.validatorId}`);
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

    // Process Staked events (initial validator onboarding)
    for (const log of stakedLogs) {
      logger.debug(`Processing Staked log: ${log.constructor.name}`);

      if (log instanceof EventLog) {
        logger.debug(`EventLog validated, getting block ${log.blockNumber}`);
        // Get block timestamp
        const block = await this.rpcService.call(() =>
          this.provider.getBlock(log.blockNumber)
        );

        if (!block) {
          logger.error(`Failed to fetch block ${log.blockNumber}, aborting`);
          throw new Error(`Failed to fetch block ${log.blockNumber}; cannot process events due to missing timestamp`);
        }

        // Log Staked events (should be rare - initial validator onboarding only)
        logger.info(
          `Found Staked event for validator ${log.args.validatorId} ` +
          `with initial amount ${ethers.formatEther(log.args.amount)} POL ` +
          `at block ${log.blockNumber} (tx: ${log.transactionHash})`
        );

        logger.debug(`Adding Staked event for validator ${log.args.validatorId}`);
        events.push({
          validatorId: log.args.validatorId,
          newAmount: log.args.amount, // Map 'amount' from Staked to 'newAmount' for StakeUpdateEvent
          blockNumber: log.blockNumber,
          blockTimestamp: block.timestamp,
          transactionHash: log.transactionHash,
        });
      } else {
        logger.debug(`Log is not EventLog, skipping`);
      }
    }

    // Sort events by block number to maintain chronological order
    events.sort((a, b) => a.blockNumber - b.blockNumber);

    logger.debug(`Processed chunk ${fromBlock}-${toBlock}: returning ${events.length} total events`);
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
