/**
 * Polygon service for querying fee balances
 */

import { ethers } from 'ethers';
import { FeeSnapshot, StakeUpdateEvent, DistributionConfig, Distribution } from '../models/types';
import { RpcService } from '../utils/rateLimit';
import { BlockMapperService } from './blockMapper.service';
import { logger, logProgress } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

export class PolygonService {
  private provider: ethers.JsonRpcProvider;
  private rpcService: RpcService;
  private blockMapper: BlockMapperService;
  private distributions: Distribution[] = [];

  constructor(
    rpcUrl: string,
    rpcService: RpcService,
    blockMapper: BlockMapperService
  ) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.rpcService = rpcService;
    this.blockMapper = blockMapper;
    this.loadDistributions();
  }

  /**
   * Load distributions from config file
   */
  private loadDistributions(): void {
    try {
      const configPath = path.join(process.cwd(), 'distributions.json');
      if (fs.existsSync(configPath)) {
        const configData = fs.readFileSync(configPath, 'utf-8');
        const config: DistributionConfig = JSON.parse(configData);
        this.distributions = config.distributions;
        logger.info(`Loaded ${this.distributions.length} distribution(s) from config`);
        for (const dist of this.distributions) {
          logger.info(`  Block ${dist.polygonBlock}: ${dist.amount} POL${dist.description ? ` (${dist.description})` : ''}`);
        }
      } else {
        logger.info('No distributions.json found, starting fresh');
      }
    } catch (error) {
      logger.error('Failed to load distributions config', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get fee balances at each timestamp
   */
  async getFeeSnapshots(
    feeContractAddress: string,
    uniqueTimestamps: number[],
  ): Promise<FeeSnapshot[]> {
    logger.info(`Getting fee balances for ${uniqueTimestamps.length} timestamps`);

    const snapshots: FeeSnapshot[] = [];

    for (let i = 0; i < uniqueTimestamps.length; i++) {
      logProgress('Processing timestamps', i + 1, uniqueTimestamps.length);

      try {
        // Map Ethereum timestamp to Polygon block
        const polygonBlock = await this.blockMapper.findBlockByTimestamp(
          uniqueTimestamps[i]
        );
        logger.info(`Found polygon block ${polygonBlock} for Ethereum timestamp ${uniqueTimestamps[i]}`);
        // Get fee balance at that block
        const balance = await this.getBalanceAtBlock(feeContractAddress, polygonBlock);
        snapshots.push({
          ethereumTimestamp: uniqueTimestamps[i],
          polygonBlock,
          feeBalance: balance,
        });
        logger.info(`Fee balance at block ${polygonBlock}: ${ethers.formatEther(balance)} POL`);
        
      } catch (error) {
        logger.error(
          `Failed to get fee balance at Ethereum timestamp ${uniqueTimestamps[i]}`,
          {
            error: error instanceof Error ? error.message : String(error),
            ethereumTimestamp: uniqueTimestamps[i],
          }
        );
        throw error;
      }
    }

    logger.info(`Total number of fee balance snapshots: ${snapshots.length}`);

    return snapshots;
  }

  /**
   * Get contract balance at a specific block
   * Note: Requires archive node access for historical state
   * Adjusts for distributions made from the fee address
   */
  async getBalanceAtBlock(
    address: string,
    blockNumber: number
  ): Promise<bigint> {
    try {
      const rawBalance = await this.rpcService.call(() =>
        this.provider.getBalance(address, blockNumber)
      );

      // Calculate total distributions that occurred at or before this block
      let distributionsToAddBack = 0n;
      for (const dist of this.distributions) {
        if (dist.polygonBlock <= blockNumber) {
          const amount = ethers.parseEther(dist.amount);
          distributionsToAddBack += amount;
          logger.debug(
            `Adding back distribution from block ${dist.polygonBlock}: ${dist.amount} POL`
          );
        }
      }

      // Adjusted balance accounts for distributions
      const adjustedBalance = rawBalance + distributionsToAddBack;

      logger.debug(
        `Balance at block ${blockNumber}: ${ethers.formatEther(rawBalance)} POL (raw), ` +
        `${ethers.formatEther(adjustedBalance)} POL (adjusted with ${ethers.formatEther(distributionsToAddBack)} POL added back)`
      );

      return adjustedBalance;
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
