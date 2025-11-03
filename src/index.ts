#!/usr/bin/env node

/**
 * Main entry point for Polygon PoS Validator Fee Split Calculator
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';
import { getConfig } from './config/env';
import { EthereumService } from './services/ethereum.service';
import { PolygonService } from './services/polygon.service';
import { HeimdallService } from './services/heimdall.service';
import { BlockMapperService } from './services/blockMapper.service';
import { FeeSplitCalculator } from './calculators/feeSplit.calculator';
import { RpcService } from './utils/rateLimit';
import { logger } from './utils/logger';
import { OutputData, StakingInterval, FeeSplitResult, ValidatorPerformance } from './models/types';
import { CsvWriter } from './utils/csvWriter';
import { runValidation } from './utils/validation';

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
        { maxConcurrent: config.maxConcurrentRequests, minDelayMs: config.requestDelayMs },
        { maxRetries: config.maxRetries, baseDelayMs: 1000, maxDelayMs: 10000 }
      );

      const polygonRpc = new RpcService(
        { maxConcurrent: config.maxConcurrentRequests, minDelayMs: config.requestDelayMs },
        { maxRetries: config.maxRetries, baseDelayMs: 1000, maxDelayMs: 10000 }
      );

      const ethereumService = new EthereumService(
        config.ethereumRpcUrl,
        config.ethereumStakingContract,
        ethereumRpc
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

      const heimdallService = new HeimdallService(config.heimdallRpcUrl);

      const calculator = new FeeSplitCalculator(config.blockProducerCommission);

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

      // Step 1: Fetch validator performance scores (to know all active validators)
      logger.info('\n--- Step 1: Fetching validator performance scores ---');
      const performanceScores = await heimdallService.getValidatorPerformance();
      const validatorIds = Array.from(performanceScores.keys());
      logger.info(`Found ${validatorIds.length} active validators`);

      // Step 2: Find Ethereum block corresponding to start timestamp
      logger.info('\n--- Step 2: Finding initial Ethereum block for start timestamp ---');
      const startEthereumBlock = await ethereumService.findBlockByTimestamp(startTimestamp);
      logger.info(`Start Ethereum block: ${startEthereumBlock}`);

      // Step 3: Query initial stakes for all validators
      logger.info('\n--- Step 3: Querying initial stakes for all validators ---');
      const initialStakes = await ethereumService.getValidatorStakes(
        validatorIds,
        startEthereumBlock
      );

      // Step 4: Query initial fee balance
      logger.info('\n--- Step 4: Querying initial fee balance ---');
      const VEBLOP_FORK_BLOCK = 77414656;
      let initialFeeBalance = 0n;
      if (startBlock >= VEBLOP_FORK_BLOCK) {
        initialFeeBalance = await polygonService.getBalanceAtBlock(
          config.polygonFeeContract,
          startBlock
        );
        logger.info(`Initial fee balance at block ${startBlock}: ${ethers.formatEther(initialFeeBalance)} POL`);
      } else {
        logger.info(`Start block ${startBlock} is before VEBloP fork (${VEBLOP_FORK_BLOCK}), initial fee balance is 0`);
      }

      // Step 5: Query StakeUpdate events from Ethereum within the timestamp range
      logger.info('\n--- Step 5: Querying StakeUpdate events from Ethereum ---');
      const stakeUpdates = await ethereumService.getStakeUpdateEventsByTimestamp(
        startTimestamp,
        endTimestamp
      );
      logger.info(`Found ${stakeUpdates.length} StakeUpdate events`);

      // Step 6: Get fee balances at each checkpoint on Polygon
      logger.info('\n--- Step 6: Querying fee balances from Polygon ---');
      const feeSnapshots = await polygonService.getFeeSnapshots(
        config.polygonFeeContract,
        stakeUpdates,
        initialFeeBalance
      );

      // Calculate total fees
      const totalFees = feeSnapshots.reduce((sum, s) => sum + s.feeDelta, 0n);

      // Step 7: Calculate fee splits
      logger.info('\n--- Step 7: Calculating fee splits ---');
      const { feeSplits, intervals } = calculator.calculate(initialStakes, stakeUpdates, feeSnapshots, performanceScores, totalFees);

      // Step 8: Generate output
      logger.info('\n--- Step 8: Generating output ---');
      const output = this.generateOutput(
        startBlock,
        endBlock,
        stakeUpdates,
        feeSnapshots,
        performanceScores,
        feeSplits,
        totalFees,
        config.blockProducerCommission
      );

      // Generate timestamped output path
      const timestampedOutputPath = this.addTimestampToFilename(outputPath);

      // Write to file
      this.writeOutput(output, timestampedOutputPath);

      // Generate output files
      logger.info('\n--- Step 9: Generating output files ---');

      // 1. Distribution CSV (simple, for executing fee split)
      this.writeDistributionCsv(feeSplits, timestampedOutputPath);

      // 2. Detailed report JSON (comprehensive, for transparency/visualization)
      this.writeDetailedReportJson(
        startBlock,
        endBlock,
        startBlockData.timestamp,
        endBlockData.timestamp,
        intervals,
        performanceScores,
        feeSplits,
        totalFees,
        config.blockProducerCommission,
        timestampedOutputPath
      );

      // 3. CSV files for spreadsheet analysis
      this.writeIntervalsCsv(intervals, performanceScores, timestampedOutputPath);
      this.writeValidatorAllocationsCsv(feeSplits, performanceScores, timestampedOutputPath);
      this.writePerformanceScoresCsv(performanceScores, timestampedOutputPath);

      // Validate output
      runValidation(timestampedOutputPath);

      // Display summary
      this.displaySummary(output);

      logger.info('\n=== Processing completed successfully ===');
    } catch (error) {
      logger.error('Application error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      process.exit(1);
    }
  }

  /**
   * Generate output data structure
   */
  private generateOutput(
    startBlock: number,
    endBlock: number,
    stakeUpdates: any[],
    feeSnapshots: any[],
    performanceScores: Map<number, any>,
    feeSplits: any[],
    totalFees: bigint,
    blockProducerCommission: number
  ): OutputData {
    const validatorPool = (totalFees * BigInt(Math.floor((1 - blockProducerCommission) * 1e18))) / BigInt(1e18);

    return {
      metadata: {
        generatedAt: new Date().toISOString(),
        polygonBlockRange: {
          from: startBlock,
          to: endBlock,
        },
        ethereumBlockRange: {
          from: Math.min(...stakeUpdates.map((u) => u.blockNumber)),
          to: Math.max(...stakeUpdates.map((u) => u.blockNumber)),
        },
        totalFeesCollected: ethers.formatEther(totalFees),
        validatorPoolSize: ethers.formatEther(validatorPool),
        blockProducerCommission,
      },
      stakeUpdates: stakeUpdates.map((update) => {
        const snapshot = feeSnapshots.find(
          (s) => s.ethereumBlock === update.blockNumber
        );
        return {
          validatorId: Number(update.validatorId),
          totalStaked: ethers.formatEther(update.newAmount),
          txHash: update.transactionHash,
          ethereumBlock: update.blockNumber,
          ethereumTimestamp: update.blockTimestamp,
          ethereumTimestampISO: new Date(update.blockTimestamp * 1000).toISOString(),
          polygonBlock: snapshot?.polygonBlock || 0,
          feeBalance: snapshot ? ethers.formatEther(snapshot.feeBalance) : '0',
          feeDelta: snapshot ? ethers.formatEther(snapshot.feeDelta) : '0',
        };
      }),
      validatorPerformance: Array.from(performanceScores.values()).map((perf) => ({
        validatorId: perf.validatorId,
        rawScore: perf.rawScore,
        normalizedScore: perf.normalizedScore,
      })),
      feeSplits: feeSplits.map((split) => ({
        validatorId: split.validatorId,
        stakedAmount: split.stakedAmountFormatted,
        stakeRatio: split.stakeRatio,
        performanceScore: split.performanceScore,
        performanceWeightedStake: split.performanceWeightedStake,
        feeAllocation: split.feeAllocationFormatted,
      })),
    };
  }

  /**
   * Add timestamp to filename
   * Example: fee-splits.json -> fee-splits_2025-10-31_22-54-42.json
   */
  private addTimestampToFilename(filePath: string): string {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);

    // Generate timestamp in format: YYYY-MM-DD_HH-MM-SS
    const now = new Date();
    const timestamp = now.toISOString()
      .replace(/T/, '_')
      .replace(/:/g, '-')
      .replace(/\..+/, ''); // Remove milliseconds

    const timestampedFilename = `${base}_${timestamp}${ext}`;
    return path.join(dir, timestampedFilename);
  }

  /**
   * Write output to JSON file
   */
  private writeOutput(data: OutputData, outputPath: string): void {
    // Ensure output directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write JSON file
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8');
    logger.info(`Output written to: ${outputPath}`);
  }

  /**
   * Display summary to console
   */
  private displaySummary(data: OutputData): void {
    console.log('\n=== SUMMARY ===\n');
    console.log(`Polygon Block Range: ${data.metadata.polygonBlockRange.from} to ${data.metadata.polygonBlockRange.to}`);
    console.log(`Ethereum Block Range: ${data.metadata.ethereumBlockRange.from} to ${data.metadata.ethereumBlockRange.to}`);
    console.log(`Total Fees Collected: ${data.metadata.totalFeesCollected} POL`);
    console.log(`Validator Pool (after ${(data.metadata.blockProducerCommission * 100).toFixed(1)}% commission): ${data.metadata.validatorPoolSize} POL`);
    console.log(`\nStake Updates: ${data.stakeUpdates.length}`);
    console.log(`Validators with Performance Scores: ${data.validatorPerformance.length}`);
    console.log(`\nTop 10 Validators by Fee Allocation:\n`);

    const top10 = data.feeSplits.slice(0, 10);
    console.log('Rank | Validator ID | Stake (POL) | Performance | Fee Allocation (POL)');
    console.log('-----|--------------|-------------|-------------|---------------------');

    top10.forEach((split, index) => {
      console.log(
        `${String(index + 1).padStart(4)} | ` +
        `${String(split.validatorId).padStart(12)} | ` +
        `${parseFloat(split.stakedAmount).toFixed(2).padStart(11)} | ` +
        `${(split.performanceScore * 100).toFixed(2).padStart(10)}% | ` +
        `${parseFloat(split.feeAllocation).toFixed(6).padStart(19)}`
      );
    });

    console.log('\n');
  }

  /**
   * Write intervals CSV file
   */
  private writeIntervalsCsv(
    intervals: StakingInterval[],
    performanceScores: Map<number, ValidatorPerformance>,
    outputPath: string
  ): void {
    const csvPath = outputPath.replace(/\.json$/, '-intervals.csv');

    // Get all validator IDs (sorted for consistent column ordering)
    const validatorIds = Array.from(performanceScores.keys()).sort((a, b) => a - b);

    // Build headers
    const headers = [
      'Interval',
      'Start Timestamp',
      'Start Timestamp ISO',
      'Start Ethereum Block',
      'Start Polygon Block',
      'End Timestamp',
      'End Timestamp ISO',
      'End Ethereum Block',
      'End Polygon Block',
      'Fee Balance (POL)',
      'Fee Delta (POL)',
    ];

    // Add validator stake columns
    for (const valId of validatorIds) {
      headers.push(`Validator ${valId} Stake (POL)`);
    }

    // Build rows
    const rows: string[][] = [];

    for (const interval of intervals) {
      const row = [
        interval.intervalNumber.toString(),
        interval.startTimestamp.toString(),
        interval.startTimestampISO,
        interval.startEthereumBlock.toString(),
        interval.startPolygonBlock.toString(),
        interval.endTimestamp?.toString() || '',
        interval.endTimestampISO || '',
        interval.endEthereumBlock?.toString() || '',
        interval.endPolygonBlock?.toString() || '',
        CsvWriter.formatBigInt(interval.feeBalance),
        CsvWriter.formatBigInt(interval.feeDelta),
      ];

      // Add stake values for each validator
      for (const valId of validatorIds) {
        const stake = interval.validatorStakes.get(valId) || 0n;
        row.push(CsvWriter.formatBigInt(stake));
      }

      rows.push(row);
    }

    // Add performance scores row at the end
    const perfHeaderRow = ['Performance Score (Raw)', '', '', '', '', '', '', '', '', '', ''];
    const perfNormRow = ['Performance Score (Normalized)', '', '', '', '', '', '', '', '', '', ''];

    for (const valId of validatorIds) {
      const perf = performanceScores.get(valId);
      perfHeaderRow.push(perf?.rawScore.toString() || '0');
      perfNormRow.push(perf?.normalizedScore.toFixed(6) || '0');
    }

    rows.push(perfHeaderRow);
    rows.push(perfNormRow);

    CsvWriter.write(csvPath, headers, rows);
    logger.info(`Intervals CSV written to: ${csvPath}`);
  }

  /**
   * Write summary CSV file
   */
  private writeSummaryCsv(feeSplits: FeeSplitResult[], outputPath: string): void {
    const csvPath = outputPath.replace(/\.json$/, '-summary.csv');

    const headers = [
      'Validator ID',
      'Total POL Allocation',
      'Staked Amount (POL)',
      'Stake Ratio',
      'Performance Score (Normalized)',
      'Performance Weighted Stake'
    ];

    const rows: string[][] = feeSplits.map(split => [
      split.validatorId.toString(),
      CsvWriter.formatBigInt(split.feeAllocation),
      CsvWriter.formatBigInt(split.stakedAmount),
      split.stakeRatio.toFixed(6),
      split.performanceScore.toFixed(6),
      split.performanceWeightedStake.toFixed(2)
    ]);

    CsvWriter.write(csvPath, headers, rows);
    logger.info(`Summary CSV written to: ${csvPath}`);
  }

  /**
   * Write distribution CSV (simple file for fee distribution execution)
   */
  private writeDistributionCsv(feeSplits: FeeSplitResult[], outputPath: string): void {
    const csvPath = outputPath.replace(/\.json$/, '-distribution.csv');

    const headers = ['Validator ID', 'Amount (POL)'];

    const rows: string[][] = feeSplits.map(split => [
      split.validatorId.toString(),
      CsvWriter.formatBigInt(split.feeAllocation)
    ]);

    CsvWriter.write(csvPath, headers, rows);
    logger.info(`Distribution CSV written to: ${csvPath}`);
  }

  /**
   * Write detailed report JSON (comprehensive data for transparency/visualization)
   */
  private writeDetailedReportJson(
    startBlock: number,
    endBlock: number,
    startTimestamp: number,
    endTimestamp: number,
    intervals: StakingInterval[],
    performanceScores: Map<number, ValidatorPerformance>,
    feeSplits: FeeSplitResult[],
    totalFees: bigint,
    blockProducerCommission: number,
    outputPath: string
  ): void {
    const jsonPath = outputPath.replace(/\.json$/, '-detailed-report.json');

    const validatorPool = (totalFees * BigInt(Math.floor((1 - blockProducerCommission) * 1e18))) / BigInt(1e18);
    const blockProducerShare = totalFees - validatorPool;

    // Build intervals array
    const stakingIntervals = intervals.map(interval => {
      const validatorStakes: Record<number, string> = {};
      for (const [valId, stake] of interval.validatorStakes.entries()) {
        validatorStakes[valId] = ethers.formatEther(stake);
      }

      return {
        intervalNumber: interval.intervalNumber,
        period: {
          startTimestamp: interval.startTimestamp,
          startDate: interval.startTimestampISO,
          endTimestamp: interval.endTimestamp,
          endDate: interval.endTimestampISO,
          durationSeconds: interval.endTimestamp ? interval.endTimestamp - interval.startTimestamp : 0
        },
        blocks: {
          ethereumStart: interval.startEthereumBlock,
          ethereumEnd: interval.endEthereumBlock,
          polygonStart: interval.startPolygonBlock,
          polygonEnd: interval.endPolygonBlock
        },
        fees: {
          totalFees: ethers.formatEther(interval.feeDelta),
          validatorPoolShare: ethers.formatEther(
            (interval.feeDelta * BigInt(Math.floor((1 - blockProducerCommission) * 1e18))) / BigInt(1e18)
          )
        },
        validatorStakes
      };
    });

    // Build performance scores object
    const validatorPerformance: Record<number, any> = {};
    const maxRawScore = Math.max(...Array.from(performanceScores.values()).map(p => p.rawScore));
    for (const [valId, perf] of performanceScores.entries()) {
      validatorPerformance[valId] = {
        validatorId: perf.validatorId,
        rawScore: perf.rawScore,
        normalizedScore: perf.normalizedScore,
        maxRawScore
      };
    }

    // Build allocations object
    const validatorAllocations: Record<number, any> = {};
    const totalAllocated = feeSplits.reduce((sum, split) => sum + split.feeAllocation, 0n);

    for (const split of feeSplits) {
      validatorAllocations[split.validatorId] = {
        validatorId: split.validatorId,
        blendedStake: split.stakedAmountFormatted,
        stakeRatio: split.stakeRatio,
        performanceScore: split.performanceScore,
        performanceWeightedStake: split.performanceWeightedStake,
        allocation: split.feeAllocationFormatted,
        allocationRatio: Number(split.feeAllocation) / Number(totalAllocated)
      };
    }

    const report = {
      metadata: {
        generatedAt: new Date().toISOString(),
        calculationPeriod: {
          startDate: new Date(startTimestamp * 1000).toISOString(),
          endDate: new Date(endTimestamp * 1000).toISOString(),
          durationDays: ((endTimestamp - startTimestamp) / 86400).toFixed(2),
          polygonBlocks: {
            from: startBlock,
            to: endBlock,
            count: endBlock - startBlock
          },
          ethereumBlocks: {
            from: Math.min(...intervals.map(i => i.startEthereumBlock)),
            to: Math.max(...intervals.filter(i => i.endEthereumBlock).map(i => i.endEthereumBlock!)),
            count: intervals.length
          }
        },
        feeDistribution: {
          totalFeesCollected: ethers.formatEther(totalFees),
          blockProducerCommissionRate: blockProducerCommission,
          blockProducerShare: ethers.formatEther(blockProducerShare),
          validatorPoolShare: ethers.formatEther(validatorPool)
        }
      },
      stakingIntervals,
      validatorPerformance,
      validatorAllocations
    };

    const dir = path.dirname(jsonPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
    logger.info(`Detailed report JSON written to: ${jsonPath}`);
  }

  /**
   * Write validator allocations CSV (detailed breakdown for spreadsheets)
   */
  private writeValidatorAllocationsCsv(
    feeSplits: FeeSplitResult[],
    performanceScores: Map<number, ValidatorPerformance>,
    outputPath: string
  ): void {
    const csvPath = outputPath.replace(/\.json$/, '-validator-allocations.csv');

    const headers = [
      'Validator ID',
      'Allocation (POL)',
      'Allocation Ratio (%)',
      'Blended Stake (POL)',
      'Stake Ratio (%)',
      'Performance Score (Normalized)',
      'Performance Score (Raw)',
      'Performance Weighted Stake'
    ];

    const totalAllocated = feeSplits.reduce((sum, split) => sum + split.feeAllocation, 0n);

    const rows: string[][] = feeSplits.map(split => {
      const perf = performanceScores.get(split.validatorId);
      const allocationRatio = (Number(split.feeAllocation) / Number(totalAllocated)) * 100;

      return [
        split.validatorId.toString(),
        CsvWriter.formatBigInt(split.feeAllocation),
        allocationRatio.toFixed(6),
        CsvWriter.formatBigInt(split.stakedAmount),
        (split.stakeRatio * 100).toFixed(6),
        split.performanceScore.toFixed(6),
        perf?.rawScore.toString() || '0',
        split.performanceWeightedStake.toFixed(6)
      ];
    });

    CsvWriter.write(csvPath, headers, rows);
    logger.info(`Validator allocations CSV written to: ${csvPath}`);
  }

  /**
   * Write performance scores CSV
   */
  private writePerformanceScoresCsv(
    performanceScores: Map<number, ValidatorPerformance>,
    outputPath: string
  ): void {
    const csvPath = outputPath.replace(/\.json$/, '-performance-scores.csv');

    const headers = [
      'Validator ID',
      'Raw Score',
      'Normalized Score',
      'Performance (%)'
    ];

    const scoresArray = Array.from(performanceScores.values()).sort((a, b) => b.rawScore - a.rawScore);

    const rows: string[][] = scoresArray.map(perf => [
      perf.validatorId.toString(),
      perf.rawScore.toString(),
      perf.normalizedScore.toFixed(6),
      (perf.normalizedScore * 100).toFixed(2)
    ]);

    CsvWriter.write(csvPath, headers, rows);
    logger.info(`Performance scores CSV written to: ${csvPath}`);
  }
}

/**
 * CLI setup
 */
const program = new Command();

program
  .name('polygon-fee-split')
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
