#!/usr/bin/env node

/**
 * Validation script for fee split output files
 *
 * Validates:
 * 1. Sum of fees allocated to validators in each interval matches interval total
 * 2. Sum of fees allocated across all intervals matches total expected amount
 * 3. Final allocations in transfer file match the sum across intervals
 *
 * Uses precise decimal arithmetic to avoid floating point errors
 */

import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';

interface DetailedReport {
  metadata: {
    startPolygonBlock: number;
    endPolygonBlock: number;
    blockProducerCommission: number;
    totalIntervals: number;
    generatedAt: string;
  };
  summary: {
    totalFeesCollected: string;
    totalValidatorPool: string;
    validatorCount: number;
  };
  intervals: Array<{
    intervalNumber: number;
    startTimestamp: number;
    endTimestamp: number;
    feesCollected: string;
    validatorPoolFees: string;
    validators: Record<string, {
      stakeAtStart: string;
      performanceDelta: string;
      feesAllocated: string;
    }>;
  }>;
}

interface TransferFile {
  metadata: {
    startPolygonBlock: number;
    endPolygonBlock: number;
    totalAmount: string;
    validatorCount: number;
    blockProducerCommission: number;
    generatedAt: string;
  };
  allocations: Array<{
    validatorId: number;
    amount: string;
  }>;
}

/**
 * Parse POL string to BigInt (wei)
 * Handles decimal strings like "123.456789" -> BigInt in wei
 */
function parsePOL(polString: string): bigint {
  return ethers.parseEther(polString);
}

/**
 * Format BigInt (wei) to POL string for display
 */
function formatPOL(wei: bigint): string {
  return ethers.formatEther(wei);
}

/**
 * Compare two BigInt values with a tolerance for rounding errors
 * Returns true if difference is within 1 wei per validator
 */
function almostEqual(a: bigint, b: bigint, validatorCount: number = 1): boolean {
  const diff = a > b ? a - b : b - a;
  // Allow 1 wei per validator due to division rounding
  const tolerance = BigInt(validatorCount);
  return diff <= tolerance;
}

/**
 * Validate a single interval's fee allocations
 */
function validateInterval(
  intervalNumber: number,
  validatorPoolFees: string,
  validators: Record<string, { feesAllocated: string }>
): { valid: boolean; error?: string; details: string } {
  const expectedTotal = parsePOL(validatorPoolFees);

  // Sum all validator allocations
  let actualTotal = 0n;
  const validatorCount = Object.keys(validators).length;

  for (const [validatorId, data] of Object.entries(validators)) {
    const allocated = parsePOL(data.feesAllocated);
    actualTotal += allocated;
  }

  const diff = expectedTotal > actualTotal ? expectedTotal - actualTotal : actualTotal - expectedTotal;
  const diffPOL = formatPOL(diff);

  const details = `Interval ${intervalNumber}: Expected ${validatorPoolFees} POL, Got ${formatPOL(actualTotal)} POL, Diff: ${diffPOL} POL (${validatorCount} validators)`;

  if (almostEqual(expectedTotal, actualTotal, validatorCount)) {
    return { valid: true, details };
  } else {
    return {
      valid: false,
      error: `Interval ${intervalNumber} allocation mismatch: expected ${validatorPoolFees} POL but sum of allocations is ${formatPOL(actualTotal)} POL (difference: ${diffPOL} POL)`,
      details
    };
  }
}

/**
 * Validate total fees across all intervals
 */
function validateTotalFees(
  intervals: DetailedReport['intervals'],
  expectedTotalValidatorPool: string,
  expectedTotalFeesCollected: string,
  blockProducerCommission: number
): { valid: boolean; errors: string[]; details: string[] } {
  const errors: string[] = [];
  const details: string[] = [];

  // Sum validator pool fees across all intervals
  let actualValidatorPoolTotal = 0n;
  for (const interval of intervals) {
    actualValidatorPoolTotal += parsePOL(interval.validatorPoolFees);
  }

  const expectedValidatorPool = parsePOL(expectedTotalValidatorPool);
  const diffValidatorPool = expectedValidatorPool > actualValidatorPoolTotal
    ? expectedValidatorPool - actualValidatorPoolTotal
    : actualValidatorPoolTotal - expectedValidatorPool;

  details.push(`Total Validator Pool: Expected ${expectedTotalValidatorPool} POL, Got ${formatPOL(actualValidatorPoolTotal)} POL, Diff: ${formatPOL(diffValidatorPool)} POL`);

  if (!almostEqual(expectedValidatorPool, actualValidatorPoolTotal, intervals.length)) {
    errors.push(`Total validator pool mismatch: expected ${expectedTotalValidatorPool} POL but got ${formatPOL(actualValidatorPoolTotal)} POL (difference: ${formatPOL(diffValidatorPool)} POL)`);
  }

  // Validate that validator pool = total fees × (1 - commission)
  const totalFeesCollected = parsePOL(expectedTotalFeesCollected);
  const commission = BigInt(Math.floor(blockProducerCommission * 1e18));
  const validatorShare = BigInt(1e18) - commission;
  const calculatedValidatorPool = (totalFeesCollected * validatorShare) / BigInt(1e18);

  const diffCommission = expectedValidatorPool > calculatedValidatorPool
    ? expectedValidatorPool - calculatedValidatorPool
    : calculatedValidatorPool - expectedValidatorPool;

  details.push(`Commission Validation: ${expectedTotalFeesCollected} POL × ${(1 - blockProducerCommission) * 100}% = ${formatPOL(calculatedValidatorPool)} POL, Expected: ${expectedTotalValidatorPool} POL, Diff: ${formatPOL(diffCommission)} POL`);

  if (!almostEqual(expectedValidatorPool, calculatedValidatorPool, 1)) {
    errors.push(`Commission calculation error: ${expectedTotalFeesCollected} POL × ${(1 - blockProducerCommission) * 100}% should equal ${expectedTotalValidatorPool} POL but got ${formatPOL(calculatedValidatorPool)} POL`);
  }

  return { valid: errors.length === 0, errors, details };
}

/**
 * Validate transfer file against detailed report
 */
function validateTransferFile(
  detailedReport: DetailedReport,
  transferFile: TransferFile
): { valid: boolean; errors: string[]; details: string[] } {
  const errors: string[] = [];
  const details: string[] = [];

  // Sum allocations from detailed report
  const validatorTotalsFromReport = new Map<number, bigint>();

  for (const interval of detailedReport.intervals) {
    for (const [validatorIdStr, data] of Object.entries(interval.validators)) {
      const validatorId = parseInt(validatorIdStr);
      const allocated = parsePOL(data.feesAllocated);
      const current = validatorTotalsFromReport.get(validatorId) || 0n;
      validatorTotalsFromReport.set(validatorId, current + allocated);
    }
  }

  // Compare with transfer file
  const validatorTotalsFromTransfer = new Map<number, bigint>();
  for (const allocation of transferFile.allocations) {
    validatorTotalsFromTransfer.set(allocation.validatorId, parsePOL(allocation.amount));
  }

  // Check that all validators in report are in transfer file
  for (const [validatorId, expectedAmount] of validatorTotalsFromReport.entries()) {
    const actualAmount = validatorTotalsFromTransfer.get(validatorId);

    if (actualAmount === undefined) {
      errors.push(`Validator ${validatorId} in detailed report but missing from transfer file`);
      continue;
    }

    const diff = expectedAmount > actualAmount ? expectedAmount - actualAmount : actualAmount - expectedAmount;
    details.push(`Validator ${validatorId}: Report ${formatPOL(expectedAmount)} POL, Transfer ${formatPOL(actualAmount)} POL, Diff: ${formatPOL(diff)} POL`);

    if (!almostEqual(expectedAmount, actualAmount, 1)) {
      errors.push(`Validator ${validatorId} allocation mismatch: report shows ${formatPOL(expectedAmount)} POL but transfer file shows ${formatPOL(actualAmount)} POL (difference: ${formatPOL(diff)} POL)`);
    }
  }

  // Check that all validators in transfer file are in report
  for (const [validatorId] of validatorTotalsFromTransfer.entries()) {
    if (!validatorTotalsFromReport.has(validatorId)) {
      errors.push(`Validator ${validatorId} in transfer file but missing from detailed report`);
    }
  }

  // Validate total amount in transfer file
  const reportTotal = parsePOL(detailedReport.summary.totalValidatorPool);
  const transferTotal = parsePOL(transferFile.metadata.totalAmount);
  const diffTotal = reportTotal > transferTotal ? reportTotal - transferTotal : transferTotal - reportTotal;

  details.push(`Total Amount: Report ${detailedReport.summary.totalValidatorPool} POL, Transfer ${transferFile.metadata.totalAmount} POL, Diff: ${formatPOL(diffTotal)} POL`);

  if (!almostEqual(reportTotal, transferTotal, validatorTotalsFromReport.size)) {
    errors.push(`Total amount mismatch: report shows ${detailedReport.summary.totalValidatorPool} POL but transfer file shows ${transferFile.metadata.totalAmount} POL (difference: ${formatPOL(diffTotal)} POL)`);
  }

  return { valid: errors.length === 0, errors, details };
}

/**
 * Main validation function
 */
function validateOutputFiles(detailedReportPath: string, transferFilePath?: string): void {
  console.log('=== Fee Split Output Validation ===\n');

  // Load detailed report
  console.log(`Loading detailed report: ${detailedReportPath}`);
  if (!fs.existsSync(detailedReportPath)) {
    console.error(`ERROR: File not found: ${detailedReportPath}`);
    process.exit(1);
  }

  const detailedReport: DetailedReport = JSON.parse(fs.readFileSync(detailedReportPath, 'utf-8'));
  console.log(`Loaded report with ${detailedReport.intervals.length} intervals\n`);

  let allValid = true;
  const allErrors: string[] = [];

  // Validate each interval
  console.log('--- Validating Individual Intervals ---');
  for (const interval of detailedReport.intervals) {
    const result = validateInterval(
      interval.intervalNumber,
      interval.validatorPoolFees,
      interval.validators
    );

    console.log(`${result.valid ? '✓' : '✗'} ${result.details}`);

    if (!result.valid) {
      allValid = false;
      allErrors.push(result.error!);
    }
  }

  // Validate total fees
  console.log('\n--- Validating Total Fees ---');
  const totalResult = validateTotalFees(
    detailedReport.intervals,
    detailedReport.summary.totalValidatorPool,
    detailedReport.summary.totalFeesCollected,
    detailedReport.metadata.blockProducerCommission
  );

  for (const detail of totalResult.details) {
    console.log(`${totalResult.valid ? '✓' : '✗'} ${detail}`);
  }

  if (!totalResult.valid) {
    allValid = false;
    allErrors.push(...totalResult.errors);
  }

  // Validate transfer file if provided
  if (transferFilePath) {
    console.log('\n--- Validating Transfer File ---');
    console.log(`Loading transfer file: ${transferFilePath}`);

    if (!fs.existsSync(transferFilePath)) {
      console.error(`ERROR: File not found: ${transferFilePath}`);
      process.exit(1);
    }

    const transferFile: TransferFile = JSON.parse(fs.readFileSync(transferFilePath, 'utf-8'));

    const transferResult = validateTransferFile(detailedReport, transferFile);

    for (const detail of transferResult.details) {
      console.log(`${transferResult.valid ? '✓' : '✗'} ${detail}`);
    }

    if (!transferResult.valid) {
      allValid = false;
      allErrors.push(...transferResult.errors);
    }
  }

  // Summary
  console.log('\n=== Validation Summary ===');
  if (allValid) {
    console.log('✓ All validations passed!');
    console.log(`✓ ${detailedReport.intervals.length} intervals validated`);
    console.log(`✓ ${detailedReport.summary.validatorCount} validators validated`);
    console.log(`✓ Total amount: ${detailedReport.summary.totalValidatorPool} POL`);
  } else {
    console.log('✗ Validation failed with errors:\n');
    for (const error of allErrors) {
      console.log(`  ✗ ${error}`);
    }
    process.exit(1);
  }
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: npm run validate <detailed-report.json> [transfer-file.json]');
    console.log('\nExample:');
    console.log('  npm run validate ./output/fee-splits-detailed-77414656-77415299-2025-01-15.json');
    console.log('  npm run validate ./output/fee-splits-detailed-77414656-77415299-2025-01-15.json ./output/fee-splits-77414656-77415299-2025-01-15.json');
    process.exit(1);
  }

  const detailedReportPath = args[0];
  const transferFilePath = args[1];

  validateOutputFiles(detailedReportPath, transferFilePath);
}

export { validateOutputFiles };
