/**
 * Output writer utility for generating JSON reports
 */

import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';
import { CalculationResult, TransferData } from '../models/types';
import { logger } from './logger';

/**
 * Write detailed interval-by-interval report to JSON file
 *
 * @param result - Complete calculation result with interval details
 * @param outputDir - Directory to write the file to
 * @param signerMap - Map of validatorId -> signer address from Polygon Staking API
 * @returns Path to the generated file
 */
export function writeDetailedReport(
  result: CalculationResult,
  outputDir: string,
  signerMap: Map<number, string>
): string {
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Generate filename with block range and timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `fee-splits-detailed-${result.metadata.startPolygonBlock}-${result.metadata.endPolygonBlock}-${timestamp}.json`;
  const filePath = path.join(outputDir, filename);

  // Enrich each interval's validator entries with signer addresses
  const enrichedIntervals = result.intervals.map(interval => ({
    ...interval,
    validators: Object.fromEntries(
      Object.entries(interval.validators).map(([validatorId, data]) => [
        validatorId,
        {
          signer: signerMap.get(Number(validatorId)) ?? 'unknown',
          ...data,
        },
      ])
    ),
  }));

  // Build the output structure
  const output = {
    metadata: result.metadata,
    summary: result.summary,
    intervals: enrichedIntervals,
  };

  // Write to file with pretty formatting
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2), 'utf-8');

  logger.info(`Detailed report written to: ${filePath}`);
  return filePath;
}

/**
 * Write simple transfer file with validator allocations
 *
 * @param result - Complete calculation result
 * @param outputDir - Directory to write the file to
 * @param signerMap - Map of validatorId -> signer address from Polygon Staking API
 * @returns Path to the generated file
 */
export function writeTransferFile(
  result: CalculationResult,
  outputDir: string,
  signerMap: Map<number, string>
): string {
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Generate filename with block range and timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `fee-splits-${result.metadata.startPolygonBlock}-${result.metadata.endPolygonBlock}-${timestamp}.json`;
  const filePath = path.join(outputDir, filename);

  // Convert final allocations map to sorted array, enriched with signer address
  const allocations = Array.from(result.finalAllocations.entries())
    .map(([validatorId, amount]) => ({
      validatorId,
      signer: signerMap.get(validatorId) ?? 'unknown',
      amount: ethers.formatEther(amount),
    }))
    .sort((a, b) => a.validatorId - b.validatorId);

  // Calculate total amount
  const totalAmount = Array.from(result.finalAllocations.values())
    .reduce((sum, amount) => sum + amount, 0n);

  // Build transfer file structure
  const transferData: TransferData = {
    metadata: {
      startPolygonBlock: result.metadata.startPolygonBlock,
      endPolygonBlock: result.metadata.endPolygonBlock,
      totalAmount: ethers.formatEther(totalAmount),
      validatorCount: allocations.length,
      blockProducerCommission: result.metadata.blockProducerCommission,
      generatedAt: result.metadata.generatedAt,
    },
    allocations,
  };

  // Write to file with pretty formatting
  fs.writeFileSync(filePath, JSON.stringify(transferData, null, 2), 'utf-8');

  logger.info(`Transfer file written to: ${filePath}`);
  return filePath;
}
