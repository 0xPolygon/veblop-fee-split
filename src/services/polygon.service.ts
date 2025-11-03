/**
 * Polygon service for querying fee balances
 */

import { ethers } from 'ethers';
import { FeeSnapshot, StakeUpdateEvent } from '../models/types';
import { RpcService } from '../utils/rateLimit';
import { BlockMapperService } from './blockMapper.service';
import { logger, logProgress } from '../utils/logger';

export class PolygonService {
  private provider: ethers.JsonRpcProvider;
  private rpcService: RpcService;
  private blockMapper: BlockMapperService;

  constructor(
    rpcUrl: string,
    rpcService: RpcService,
    blockMapper: BlockMapperService
  ) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.rpcService = rpcService;
    this.blockMapper = blockMapper;
  }

  /**
   * Get fee balances at each stake update checkpoint
   */
  async getFeeSnapshots(
    feeContractAddress: string,
    stakeUpdates: StakeUpdateEvent[],
    initialBalance: bigint = 0n
  ): Promise<FeeSnapshot[]> {
    logger.info(`Getting fee balances for ${stakeUpdates.length} checkpoints`);
    logger.info(`Initial fee balance: ${ethers.formatEther(initialBalance)} POL`);

    const snapshots: FeeSnapshot[] = [];
    let previousBalance = initialBalance;

    for (let i = 0; i < stakeUpdates.length; i++) {
      const update = stakeUpdates[i];
      logProgress('Processing checkpoints', i + 1, stakeUpdates.length);

      try {
        // Map Ethereum timestamp to Polygon block
        const polygonBlock = await this.blockMapper.findBlockByTimestamp(
          update.blockTimestamp
        );

        // Get fee balance at that block
        const balance = await this.getBalanceAtBlock(feeContractAddress, polygonBlock);

        // Calculate delta from previous balance
        const delta = balance - previousBalance;

        snapshots.push({
          ethereumBlock: update.blockNumber,
          ethereumTimestamp: update.blockTimestamp,
          polygonBlock,
          feeBalance: balance,
          feeDelta: delta > 0n ? delta : 0n, // Only count positive deltas (fee increases)
        });

        previousBalance = balance;
      } catch (error) {
        logger.error(
          `Failed to get fee balance for checkpoint at Ethereum block ${update.blockNumber}`,
          {
            error: error instanceof Error ? error.message : String(error),
            ethereumBlock: update.blockNumber,
            timestamp: update.blockTimestamp,
          }
        );
        throw error;
      }
    }

    const totalFees = snapshots.reduce((sum, s) => sum + s.feeDelta, 0n);
    logger.info(`Total fees collected: ${ethers.formatEther(totalFees)} POL`);

    return snapshots;
  }

  /**
   * Get contract balance at a specific block
   * Note: Requires archive node access for historical state
   */
  async getBalanceAtBlock(
    address: string,
    blockNumber: number
  ): Promise<bigint> {
    try {
      const balance = await this.rpcService.call(() =>
        this.provider.getBalance(address, blockNumber)
      );

      logger.debug(
        `Balance at block ${blockNumber}: ${ethers.formatEther(balance)} POL`
      );

      return balance;
    } catch (error) {
      // Check if this is an archive node access error
      if (
        error instanceof Error &&
        (error.message.includes('missing trie node') ||
          error.message.includes('block not found') ||
          error.message.includes('header not found'))
      ) {
        logger.error(
          'Archive node access required. Your RPC provider may not support historical state queries.',
          { blockNumber }
        );
        throw new Error(
          `Archive node required: Cannot access historical state at block ${blockNumber}. ` +
          'Please use an RPC provider that supports archive node queries (e.g., Alchemy, QuickNode with archive access).'
        );
      }
      throw error;
    }
  }

  /**
   * Get current block number on Polygon
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
   * Get current balance of fee contract
   */
  async getCurrentBalance(address: string): Promise<bigint> {
    return this.rpcService.call(() => this.provider.getBalance(address));
  }
}
