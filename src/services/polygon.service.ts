/**
 * Polygon service for querying fee balances
 */

import { ethers } from 'ethers';
import { FeeSnapshot, DistributionConfig, AppliedDistribution } from '../models/types';
import { RpcService } from '../utils/rateLimit';
import { BlockMapperService } from './blockMapper.service';
import { DetectedOutflow, DistributionDetector } from './distributionDetector.service';
import { logger, logProgress } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Block range that still needs on-chain detection, or null if distributions.json already covers it.
 *
 * Fee deltas only depend on distributions after the run's start block, and distributions.json is
 * authoritative up to its last entry, so detection covers (max(startBlock, lastManualBlock), endBlock].
 */
export function detectionRange(
  manual: AppliedDistribution[],
  startBlock: number,
  endBlock: number
): { fromBlock: number; toBlock: number } | null {
  const fromBlock = Math.max(startBlock, lastManualBlock(manual)) + 1;
  return fromBlock <= endBlock ? { fromBlock, toBlock: endBlock } : null;
}

export function lastManualBlock(manual: AppliedDistribution[]): number {
  return manual.reduce((max, d) => Math.max(max, d.polygonBlock), 0);
}

/**
 * Detection starts after the last json entry's block, so a second payout in that same block would be missed.
 * When that block falls inside a run, its on-chain outflows must match its json entries one-for-one.
 */
export function verifyCutoffBlock(
  manual: AppliedDistribution[],
  cutoffBlock: number,
  outflowsAtCutoff: DetectedOutflow[]
): void {
  const manualCount = manual.filter(d => d.polygonBlock === cutoffBlock).length;
  if (outflowsAtCutoff.length !== manualCount) {
    const found = outflowsAtCutoff
      .map(o => `${o.transactionHash} (${ethers.formatEther(o.amount)} POL)`)
      .join(', ');
    throw new Error(
      `distributions.json has ${manualCount} entr${manualCount === 1 ? 'y' : 'ies'} at its last block ${cutoffBlock}, ` +
      `but ${outflowsAtCutoff.length} transaction(s) moved POL out of the fee Safe in that block: ${found || 'none'}. ` +
      `Fix the entries at block ${cutoffBlock} in distributions.json so they match the chain.`
    );
  }
}

/**
 * Total of distributions made at or before `blockNumber`; balances are read after the block, so they already reflect them
 */
export function sumDistributionsThrough(distributions: AppliedDistribution[], blockNumber: number): bigint {
  return distributions
    .filter(d => d.polygonBlock <= blockNumber)
    .reduce((sum, d) => sum + d.amount, 0n);
}

export class PolygonService {
  private provider: ethers.JsonRpcProvider;
  private rpcService: RpcService;
  private blockMapper: BlockMapperService;
  private detector: DistributionDetector;
  private manualDistributions: AppliedDistribution[] = [];
  private distributions: AppliedDistribution[] = [];
  private preparedWindow?: { address: string; startBlock: number; endBlock: number };

  constructor(
    rpcUrl: string,
    rpcService: RpcService,
    blockMapper: BlockMapperService
  ) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.rpcService = rpcService;
    this.blockMapper = blockMapper;
    this.detector = new DistributionDetector(this.provider, rpcService);
    this.loadDistributions();
  }

  /**
   * Load historical distributions from config file
   */
  private loadDistributions(): void {
    try {
      const configPath = path.join(process.cwd(), 'distributions.json');
      if (fs.existsSync(configPath)) {
        const configData = fs.readFileSync(configPath, 'utf-8');
        const config: DistributionConfig = JSON.parse(configData);
        this.manualDistributions = config.distributions.map(dist => {
          if (!Number.isInteger(dist.polygonBlock) || dist.polygonBlock <= 0) {
            throw new Error(`Invalid polygonBlock in distributions.json: ${JSON.stringify(dist)}`);
          }
          return {
            polygonBlock: dist.polygonBlock,
            amount: ethers.parseEther(dist.amount),
            source: 'manual' as const,
            description: dist.description,
          };
        });
        logger.info(`Loaded ${this.manualDistributions.length} distribution(s) from config`);
        for (const dist of config.distributions) {
          logger.info(`  Block ${dist.polygonBlock}: ${dist.amount} POL${dist.description ? ` (${dist.description})` : ''}`);
        }
      } else {
        logger.info('No distributions.json found; all distributions will be detected on-chain');
      }
    } catch (error) {
      logger.error('Failed to load distributions config', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Resolve every distribution affecting fee deltas in [startBlock, endBlock]: distributions.json entries,
   * plus outflows from the fee Safe detected on-chain after the last json entry.
   * Must be called before getBalanceAtBlock.
   *
   * @returns Distributions inside (startBlock, endBlock], i.e. those that changed fees for this run
   */
  async prepareDistributions(
    feeContractAddress: string,
    startBlock: number,
    endBlock: number
  ): Promise<AppliedDistribution[]> {
    const range = detectionRange(this.manualDistributions, startBlock, endBlock);
    const cutoffBlock = lastManualBlock(this.manualDistributions);
    const checkCutoff = cutoffBlock > startBlock && cutoffBlock <= endBlock;
    const scanFrom = checkCutoff ? cutoffBlock : range?.fromBlock;
    const detected: AppliedDistribution[] = [];

    if (scanFrom !== undefined) {
      const outflows = await this.detector.detect(feeContractAddress, scanFrom, endBlock);
      if (checkCutoff) {
        verifyCutoffBlock(
          this.manualDistributions,
          cutoffBlock,
          outflows.filter(o => o.polygonBlock === cutoffBlock)
        );
        logger.info(`On-chain outflows at the last distributions.json block ${cutoffBlock} match its entries`);
      }
      for (const outflow of outflows.filter(o => o.polygonBlock > cutoffBlock)) {
        detected.push({
          polygonBlock: outflow.polygonBlock,
          amount: outflow.amount,
          source: 'detected',
          transactionHash: outflow.transactionHash,
        });
      }
    } else {
      logger.info('distributions.json covers the whole block range; skipping on-chain detection');
    }

    this.distributions = [...this.manualDistributions, ...detected].sort((a, b) => a.polygonBlock - b.polygonBlock);
    this.preparedWindow = { address: feeContractAddress.toLowerCase(), startBlock, endBlock };

    const inRange = this.distributions.filter(d => d.polygonBlock > startBlock && d.polygonBlock <= endBlock);
    logger.info(`${inRange.length} distribution(s) fall inside blocks ${startBlock}-${endBlock}:`);
    for (const dist of inRange) {
      logger.info(
        `  Block ${dist.polygonBlock}: ${ethers.formatEther(dist.amount)} POL (${dist.source}` +
        `${dist.transactionHash ? `, tx ${dist.transactionHash}` : ''}${dist.description ? `, ${dist.description}` : ''})`
      );
    }
    return inRange;
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
    const window = this.preparedWindow;
    if (!window || window.address !== address.toLowerCase()) {
      throw new Error(`Distributions not prepared for ${address}; call prepareDistributions first`);
    }
    // Detection only covers the prepared window, so balances outside it would miss distributions
    if (blockNumber < window.startBlock || blockNumber > window.endBlock) {
      throw new Error(
        `Block ${blockNumber} is outside the prepared distribution window ${window.startBlock}-${window.endBlock}`
      );
    }

    try {
      const rawBalance = await this.rpcService.call(() =>
        this.provider.getBalance(address, blockNumber)
      );

      const distributionsToAddBack = sumDistributionsThrough(this.distributions, blockNumber);

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
