#!/usr/bin/env node

/**
 * Main entry point for Polygon PoS Validator Fee Split Calculator
 */

import { Command } from 'commander';
import { ethers } from 'ethers';
import { getConfig } from './config/env';
import { EthereumService } from './services/ethereum.service';
import { PolygonService } from './services/polygon.service';
import { HeimdallService } from './services/heimdall.service';
import { BlockMapperService } from './services/blockMapper.service';
import { HeimdallBlockMapperService } from './services/heimdallBlockMapper.service';
import { FeeSplitCalculator } from './calculators/feeSplit.calculator';
import { RpcService } from './utils/rateLimit';
import { logger } from './utils/logger';
import { writeDetailedReport, writeTransferFile } from './utils/outputWriter';
import { StakingApiService } from './services/stakingApi.service';

/**
 * Main application class
 */
class FeeSplitApp {
  async run(startBlock: number, endBlock: number, outputPath: string): Promise<void> {
    logger.info('=== Polygon PoS Validator Fee Split Calculator ===');
    logger.info(`Analyzing Polygon blocks ${startBlock} to ${endBlock}`);

    try {
      // Load configuration
      const config = getConfig();
      logger.info('Configuration loaded successfully');

      // Initialize services
      const ethereumRpc = new RpcService(
        { maxConcurrent: config.maxConcurrentRequests, minDelayMs: config.requestDelayMs, timeoutMs: config.requestTimeoutMs },
        { maxRetries: config.maxRetries, baseDelayMs: 1000, maxDelayMs: 10000 }
      );

      const ethereumService = new EthereumService(
        config.ethereumRpcUrl,
        config.ethereumStakingContract,
        ethereumRpc
      );

      const polygonRpc = new RpcService(
        { maxConcurrent: config.maxConcurrentRequests, minDelayMs: config.requestDelayMs, timeoutMs: config.requestTimeoutMs },
        { maxRetries: config.maxRetries, baseDelayMs: 1000, maxDelayMs: 10000 }
      );

      const blockMapper = new BlockMapperService(
        config.polygonRpcUrl,
        polygonRpc,
        startBlock,
        endBlock
      );

      const polygonService = new PolygonService(
        config.polygonRpcUrl,
        polygonRpc,
        blockMapper
      );

      const heimdallRpc = new RpcService(
        { maxConcurrent: config.maxConcurrentRequests, minDelayMs: config.requestDelayMs, timeoutMs: config.requestTimeoutMs },
        { maxRetries: config.maxRetries, baseDelayMs: 1000, maxDelayMs: 10000 }
      );

      const heimdallBlockMapper = new HeimdallBlockMapperService(config.heimdallRpcUrl, heimdallRpc);
      const heimdallService = new HeimdallService(config.heimdallRpcUrl, heimdallRpc, heimdallBlockMapper);

      const calculator = new FeeSplitCalculator(
        config.blockProducerCommission,
        config.stakersFeeRate,
        config.equalityFactor,
      );

      // Step 0: Get Polygon block timestamps to determine Ethereum query range
      logger.info('\n--- Step 0: Getting Polygon block timestamps ---');
      const startBlockData = await polygonService.getBlock(startBlock);
      const endBlockData = await polygonService.getBlock(endBlock);

      if (!startBlockData || !endBlockData) {
        throw new Error('Failed to fetch Polygon block data');
      }

      logger.info(`Polygon block ${startBlock}: ${new Date(startBlockData.timestamp * 1000).toISOString()}`);
      logger.info(`Polygon block ${endBlock}: ${new Date(endBlockData.timestamp * 1000).toISOString()}`);

      const startTimestamp = startBlockData.timestamp;
      const endTimestamp = endBlockData.timestamp;

      // Step 1: Find Ethereum blocks corresponding to start and end timestamps
      // Use <= search to get the latest Ethereum block at or before the Polygon block timestamps
      // This ensures we query stakes that were definitely active during our analysis period
      logger.info('\n--- Step 1: Finding matching Ethereum block for start and end timestamps ---');
      const [startEthereumBlock, startEthereumTimestamp] = await ethereumService.findBlockBeforeTimestamp(startTimestamp);
      logger.info(`Start Ethereum block: ${startEthereumBlock} with timestamp ${startEthereumTimestamp}`);
      const [endEthereumBlock, endEthereumTimestamp] = await ethereumService.findBlockBeforeTimestamp(endTimestamp);
      logger.info(`End Ethereum block: ${endEthereumBlock} with timestamp ${endEthereumTimestamp}`);

      // Step 2: Query initial stakes for all validators
      logger.info('\n--- Step 2: Querying initial stakes for all validators ---');
      // Query stakes for validator IDs 1-200 (typical range)
      // Validators with 0 stake will be filtered out
      const validatorIdRange = Array.from({ length: 200 }, (_, i) => i + 1);
      const allStakes = await ethereumService.getValidatorStakes(
        validatorIdRange,
        startEthereumBlock
      );

      // Filter to only validators with non-zero stakes (active validators)
      const initialStakes = new Map<number, bigint>();
      const initialValidatorIds: number[] = [];
      for (const [validatorId, stake] of allStakes.entries()) {
        if (stake > 0n) {
          initialStakes.set(validatorId, stake);
          initialValidatorIds.push(validatorId);
        }
      }
      logger.info(`Found ${initialValidatorIds.length} initial active validators with non-zero stakes`);
      logger.info(`Initial validator IDs: ${initialValidatorIds.join(', ')}`);

      // Step 3: Query initial fee balance
      logger.info('\n--- Step 3: Querying initial and final fee balances ---');
      // const VEBLOP_FORK_BLOCK = 77414656;
      const initialFeeBalance = await polygonService.getBalanceAtBlock(
        config.polygonFeeContract,
        startBlock
      );
      logger.info(`Initial fee balance at block ${startBlock}: ${ethers.formatEther(initialFeeBalance)} POL`);

      const finalFeeBalance = await polygonService.getBalanceAtBlock(
        config.polygonFeeContract,
        endBlock
      );
      logger.info(`Final fee balance at block ${endBlock}: ${ethers.formatEther(finalFeeBalance)} POL`);

      // Step 4: Query StakeUpdate events from Ethereum within the block range
      logger.info('\n--- Step 4: Querying StakeUpdate events from Ethereum ---');
      const stakeUpdates = await ethereumService.getStakeUpdateEventsByBlocks(
        startEthereumBlock+1, //initial validator stakes are queried as of startEthereumBlock
        endEthereumBlock-1 //we don't need stake updates for the end block as they'd apply for the next period, which is out of scope
      );
      logger.info(`Found total of ${stakeUpdates.length} StakeUpdate events`);
      logger.debug(`Stake updates: ${stakeUpdates.map(u => `Block ${u.blockNumber} at timestamp ${u.blockTimestamp}`).join(', ')}`);

      // Get unique timestamps from stake updates and add end Ethereum timestamp
      const uniqueTimestamps = Array.from(
        new Set([...stakeUpdates.map(u => u.blockTimestamp), endEthereumTimestamp])
      ).sort((a, b) => a - b);
      logger.info(`Found ${uniqueTimestamps.length} unique timestamps`);

      const validatorIds = Array.from(initialValidatorIds);
      validatorIds.push(...stakeUpdates.map(u => Number(u.validatorId)));
      const uniqueValidatorIds = Array.from(new Set(validatorIds));
      logger.info(`Found ${uniqueValidatorIds.length} unique validator IDs across all intervals`);
      logger.info(`Unique validator IDs: ${uniqueValidatorIds.join(', ')}`);

      // Step 5: Get Polygon fee balances for each StakeUpdate event on Ethereum
      logger.info('\n--- Step 5: Querying fee balances from Polygon ---');
      const feeSnapshots = await polygonService.getFeeSnapshots(
        config.polygonFeeContract,
        uniqueTimestamps,
      );

      // Override feeSnapshot at endEthereumTimestamp with endBlock and finalFeeBalance
      // This is necessary because the getFeeSnapshots method may map the endEthereumTimestamp to an earlier Polygon block,
      // which is not the block we actually want to use for the final fee balance.
      const endSnapshot = feeSnapshots.find(
        s => s.ethereumTimestamp === endEthereumTimestamp
      );
      endSnapshot!.polygonBlock = endBlock;
      endSnapshot!.feeBalance = finalFeeBalance;
      logger.info(`Set final fee balance snapshot: polygonBlock=${endBlock}, feeBalance=${ethers.formatEther(finalFeeBalance)} POL`);

      // Step 6: Query historical Heimdall performance scores at each timestamp
      logger.info('\n--- Step 6: Querying historical Heimdall performance scores ---');
      const { performanceScores } = await heimdallService.queryPerformanceScores(
        uniqueTimestamps,
        uniqueValidatorIds
      );

      const initialPerformanceScore = await heimdallService.queryPerformanceScoreByTimestamp(
        startTimestamp,
        uniqueValidatorIds
      );

      // Step 7: Calculate fee splits
      logger.info('\n--- Step 7: Calculating fee splits ---');
      const result = calculator.calculate(
        uniqueTimestamps,
        initialStakes,
        stakeUpdates,
        initialFeeBalance,
        feeSnapshots,
        initialPerformanceScore,
        performanceScores,
        startBlock,
        endBlock,
        startTimestamp,
        endTimestamp,
        startEthereumBlock,
      );

      // Convert Map to object for logging (bigints converted to strings)
      const scoresObj = Object.fromEntries(
        Array.from(result.finalAllocations.entries()).map(([id, score]) => [id, score.toString()])
      );
      logger.info(`Fee Splits: ${JSON.stringify(scoresObj, null, 2)}`);

      // Step 8: Fetch validator signer addresses from Polygon Staking API
      logger.info('\n--- Step 8: Fetching validator signer addresses ---');
      const stakingApiService = new StakingApiService();
      const signerMap = await stakingApiService.getValidatorSigners();

      // Step 9: Write output files
      logger.info('\n--- Step 9: Writing output files ---');
      const detailedReportPath = writeDetailedReport(result, config.outputPath, signerMap);
      const transferFilePath = writeTransferFile(result, config.outputPath, signerMap);

      logger.info('\n=== Processing completed successfully ===');
      logger.info(`Detailed report: ${detailedReportPath}`);
      logger.info(`Transfer file: ${transferFilePath}`);

    } catch (error) {
      logger.error('Application error');
      if (error instanceof Error) {
        console.error('Error message:', error.message);
        console.error('Stack trace:', error.stack);
      } else {
        console.error('Error:', error);
      }
      logger.error('Application error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      process.exit(1);
    }
  }

}

/**
 * CLI setup
 */
const program = new Command();

program
  .name('veblop-fee-split')
  .description('Calculate fee splits across Polygon PoS validators based on Polygon block range')
  .version('1.0.0')
  .requiredOption('-s, --start-block <number>', 'Polygon starting block number')
  .requiredOption('-e, --end-block <number>', 'Polygon ending block number')
  .option('-o, --output <path>', 'Output file path', './output/fee-splits.json')
  .action(async (options) => {
    const startBlock = parseInt(options.startBlock, 10);
    const endBlock = parseInt(options.endBlock, 10);
    const outputPath = options.output;

    if (isNaN(startBlock) || startBlock <= 0) {
      console.error('Error: --start-block must be a positive number');
      process.exit(1);
    }

    if (isNaN(endBlock) || endBlock <= 0) {
      console.error('Error: --end-block must be a positive number');
      process.exit(1);
    }

    if (endBlock <= startBlock) {
      console.error('Error: --end-block must be greater than --start-block');
      process.exit(1);
    }

    const app = new FeeSplitApp();
    await app.run(startBlock, endBlock, outputPath);
  });

// Parse arguments and run
program.parse();
