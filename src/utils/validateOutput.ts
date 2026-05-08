#!/usr/bin/env node

/**
 * Validation script for fee split output files
 *
 * Validates:
 * 1. Stake-weighted and equal allocations reconcile within each interval
 * 2. Equal-pool burn reconciles with per-interval and total equal pools
 * 3. Final allocations in transfer file match the detailed report
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
    stakersFeeRate: number;
    equalityFactor: number;
    totalIntervals: number;
    generatedAt: string;
  };
  summary: {
    totalFeesCollected: string;
    totalPostCommissionPool: string;
    totalStakersPool: string;
    totalValidatorPool: string;
    totalStakeWeightedValidatorPool: string;
    totalEqualValidatorPool: string;
    totalEqualPoolBurn: string;
    validatorCount: number;
  };
  intervals: Array<{
    intervalNumber: number;
    startTimestamp: number;
    endTimestamp: number;
    feesCollected: string;
    postCommissionPoolFees: string;
    stakersPoolFees: string;
    validatorPoolFees: string;
    stakeWeightedValidatorPoolFees: string;
    equalValidatorPoolFees: string;
    equalPoolBurnFees: string;
    perfectPerformance: string;
    rewardedValidatorCount: number;
    validators: Record<string, {
      stakeAtStart: string;
      performanceDelta: string;
      stakeWeightedFeesAllocated: string;
      equalFeesAllocated: string;
      feesAllocated: string;
    }>;
  }>;
  finalAllocations?: Record<string, {
    stakeWeightedFeesAllocated: string;
    equalFeesAllocated: string;
    feesAllocated: string;
  }>;
}

interface TransferFile {
  metadata: {
    startPolygonBlock: number;
    endPolygonBlock: number;
    totalAmount: string;
    validatorCount: number;
    blockProducerCommission: number;
    stakersFeeRate: number;
    equalityFactor: number;
    totalStakersPool: string;
    totalEqualPoolBurn: string;
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
  interval: DetailedReport['intervals'][0]
): { valid: boolean; error?: string; details: string } {
  const expectedValidatorPool = parsePOL(interval.validatorPoolFees);
  const expectedStakeWeightedPool = parsePOL(interval.stakeWeightedValidatorPoolFees);
  const expectedEqualPool = parsePOL(interval.equalValidatorPoolFees);
  const expectedEqualBurn = parsePOL(interval.equalPoolBurnFees);
  const expectedPostCommissionPool = parsePOL(interval.postCommissionPoolFees);
  const expectedStakersPool = parsePOL(interval.stakersPoolFees);

  let actualStakeWeightedTotal = 0n;
  let actualEqualTotal = 0n;
  let actualTotal = 0n;
  const errors: string[] = [];

  for (const [validatorId, data] of Object.entries(interval.validators)) {
    const stakeWeightedFees = parsePOL(data.stakeWeightedFeesAllocated);
    const equalFees = parsePOL(data.equalFeesAllocated);
    const totalFees = parsePOL(data.feesAllocated);

    actualStakeWeightedTotal += stakeWeightedFees;
    actualEqualTotal += equalFees;
    actualTotal += totalFees;

    if (!almostEqual(totalFees, stakeWeightedFees + equalFees, 1)) {
      errors.push(
        `validator ${validatorId} allocation mismatch: ${data.feesAllocated} POL != ` +
        `${data.stakeWeightedFeesAllocated} POL stake-weighted + ${data.equalFeesAllocated} POL equal`
      );
    }
  }

  const validatorCount = Object.keys(interval.validators).length;

  if (!almostEqual(expectedStakeWeightedPool, actualStakeWeightedTotal, validatorCount || 1)) {
    errors.push(
      `stake-weighted allocation mismatch: expected ${interval.stakeWeightedValidatorPoolFees} POL but got ${formatPOL(actualStakeWeightedTotal)} POL`
    );
  }

  if (!almostEqual(expectedEqualPool, actualEqualTotal + expectedEqualBurn, validatorCount || 1)) {
    errors.push(
      `equal-pool allocation mismatch: expected ${interval.equalValidatorPoolFees} POL but allocations plus burn equal ${formatPOL(actualEqualTotal + expectedEqualBurn)} POL`
    );
  }

  if (!almostEqual(actualTotal, actualStakeWeightedTotal + actualEqualTotal, validatorCount || 1)) {
    errors.push(
      `interval validator allocation mismatch: total allocations ${formatPOL(actualTotal)} POL != ` +
      `${formatPOL(actualStakeWeightedTotal)} POL stake-weighted + ${formatPOL(actualEqualTotal)} POL equal`
    );
  }

  if (!almostEqual(expectedValidatorPool, actualTotal + expectedEqualBurn, validatorCount || 1)) {
    errors.push(
      `interval validator pool mismatch: expected ${interval.validatorPoolFees} POL but allocations plus burn equal ${formatPOL(actualTotal + expectedEqualBurn)} POL`
    );
  }

  if (!almostEqual(expectedValidatorPool, expectedStakeWeightedPool + expectedEqualPool, 1)) {
    errors.push(
      `validator pool split mismatch: ${interval.validatorPoolFees} POL != ${interval.stakeWeightedValidatorPoolFees} POL stake-weighted + ${interval.equalValidatorPoolFees} POL equal`
    );
  }

  if (!almostEqual(expectedPostCommissionPool, expectedStakersPool + expectedValidatorPool, 1)) {
    errors.push(
      `post-commission pool split mismatch: ${interval.postCommissionPoolFees} POL != ${interval.stakersPoolFees} POL + ${interval.validatorPoolFees} POL`
    );
  }

  const details =
    `Interval ${interval.intervalNumber}: stake-weighted=${formatPOL(actualStakeWeightedTotal)} POL, ` +
    `equal=${formatPOL(actualEqualTotal)} POL, burn=${interval.equalPoolBurnFees} POL, ` +
    `interval-total=${formatPOL(actualTotal)} POL`;

  if (errors.length === 0) {
    return { valid: true, details };
  }

  return {
    valid: false,
    error: `Interval ${interval.intervalNumber} validation failed: ${errors.join('; ')}`,
    details,
  };
}

/**
 * Validate total fees across all intervals
 */
function validateTotalFees(
  intervals: DetailedReport['intervals'],
  expectedTotalPostCommissionPool: string,
  expectedTotalStakersPool: string,
  expectedTotalValidatorPool: string,
  expectedTotalStakeWeightedValidatorPool: string,
  expectedTotalEqualValidatorPool: string,
  expectedTotalEqualPoolBurn: string,
  expectedTotalFeesCollected: string,
  blockProducerCommission: number,
  stakersFeeRate: number
): { valid: boolean; errors: string[]; details: string[] } {
  const errors: string[] = [];
  const details: string[] = [];

  let actualPostCommissionTotal = 0n;
  let actualStakersPoolTotal = 0n;
  let actualValidatorPoolTotal = 0n;
  let actualStakeWeightedPoolTotal = 0n;
  let actualEqualPoolTotal = 0n;
  let actualBurnTotal = 0n;
  for (const interval of intervals) {
    actualPostCommissionTotal += parsePOL(interval.postCommissionPoolFees);
    actualStakersPoolTotal += parsePOL(interval.stakersPoolFees);
    actualValidatorPoolTotal += parsePOL(interval.validatorPoolFees);
    actualStakeWeightedPoolTotal += parsePOL(interval.stakeWeightedValidatorPoolFees);
    actualEqualPoolTotal += parsePOL(interval.equalValidatorPoolFees);
    actualBurnTotal += parsePOL(interval.equalPoolBurnFees);
  }

  const expectedPostCommission = parsePOL(expectedTotalPostCommissionPool);
  const expectedStakersPool = parsePOL(expectedTotalStakersPool);
  const expectedValidatorPool = parsePOL(expectedTotalValidatorPool);
  const expectedStakeWeightedPool = parsePOL(expectedTotalStakeWeightedValidatorPool);
  const expectedEqualPool = parsePOL(expectedTotalEqualValidatorPool);
  const expectedBurn = parsePOL(expectedTotalEqualPoolBurn);
  const diffValidatorPool = expectedValidatorPool > actualValidatorPoolTotal
    ? expectedValidatorPool - actualValidatorPoolTotal
    : actualValidatorPoolTotal - expectedValidatorPool;

  details.push(`Total Post-Commission Pool: Expected ${expectedTotalPostCommissionPool} POL, Got ${formatPOL(actualPostCommissionTotal)} POL`);
  details.push(`Total Stakers Pool: Expected ${expectedTotalStakersPool} POL, Got ${formatPOL(actualStakersPoolTotal)} POL`);
  details.push(`Total Validator Pool: Expected ${expectedTotalValidatorPool} POL, Got ${formatPOL(actualValidatorPoolTotal)} POL, Diff: ${formatPOL(diffValidatorPool)} POL`);
  details.push(`Total Stake-Weighted Pool: Expected ${expectedTotalStakeWeightedValidatorPool} POL, Got ${formatPOL(actualStakeWeightedPoolTotal)} POL`);
  details.push(`Total Equal Pool: Expected ${expectedTotalEqualValidatorPool} POL, Got ${formatPOL(actualEqualPoolTotal)} POL`);
  details.push(`Total Equal Burn: Expected ${expectedTotalEqualPoolBurn} POL, Got ${formatPOL(actualBurnTotal)} POL`);

  if (!almostEqual(expectedPostCommission, actualPostCommissionTotal, intervals.length || 1)) {
    errors.push(`Total post-commission pool mismatch: expected ${expectedTotalPostCommissionPool} POL but got ${formatPOL(actualPostCommissionTotal)} POL`);
  }

  if (!almostEqual(expectedStakersPool, actualStakersPoolTotal, intervals.length || 1)) {
    errors.push(`Total stakers pool mismatch: expected ${expectedTotalStakersPool} POL but got ${formatPOL(actualStakersPoolTotal)} POL`);
  }

  if (!almostEqual(expectedValidatorPool, actualValidatorPoolTotal, intervals.length)) {
    errors.push(`Total validator pool mismatch: expected ${expectedTotalValidatorPool} POL but got ${formatPOL(actualValidatorPoolTotal)} POL (difference: ${formatPOL(diffValidatorPool)} POL)`);
  }

  if (!almostEqual(expectedStakeWeightedPool, actualStakeWeightedPoolTotal, intervals.length || 1)) {
    errors.push(`Total stake-weighted pool mismatch: expected ${expectedTotalStakeWeightedValidatorPool} POL but got ${formatPOL(actualStakeWeightedPoolTotal)} POL`);
  }

  if (!almostEqual(expectedEqualPool, actualEqualPoolTotal, intervals.length || 1)) {
    errors.push(`Total equal pool mismatch: expected ${expectedTotalEqualValidatorPool} POL but got ${formatPOL(actualEqualPoolTotal)} POL`);
  }

  if (!almostEqual(expectedBurn, actualBurnTotal, intervals.length || 1)) {
    errors.push(`Total equal burn mismatch: expected ${expectedTotalEqualPoolBurn} POL but got ${formatPOL(actualBurnTotal)} POL`);
  }

  if (!almostEqual(expectedValidatorPool, actualStakeWeightedPoolTotal + actualEqualPoolTotal, intervals.length || 1)) {
    errors.push(`Total validator pool split mismatch: expected ${expectedTotalValidatorPool} POL but stake-weighted plus equal pools equal ${formatPOL(actualStakeWeightedPoolTotal + actualEqualPoolTotal)} POL`);
  }

  // Validate that validator pool = total fees × (1 - commission)
  const totalFeesCollected = parsePOL(expectedTotalFeesCollected);
  const commission = BigInt(Math.floor(blockProducerCommission * 1e18));
  const postCommissionShare = BigInt(1e18) - commission;
  const calculatedPostCommissionPool = (totalFeesCollected * postCommissionShare) / BigInt(1e18);
  const stakersShare = BigInt(Math.floor(stakersFeeRate * 1e18));
  const calculatedStakersPool = (calculatedPostCommissionPool * stakersShare) / BigInt(1e18);
  const calculatedValidatorPool = calculatedPostCommissionPool - calculatedStakersPool;

  const diffCommission = expectedPostCommission > calculatedPostCommissionPool
    ? expectedPostCommission - calculatedPostCommissionPool
    : calculatedPostCommissionPool - expectedPostCommission;

  details.push(
    `Post-Commission Validation: ${expectedTotalFeesCollected} POL × ${(1 - blockProducerCommission) * 100}% = ` +
    `${formatPOL(calculatedPostCommissionPool)} POL, Expected: ${expectedTotalPostCommissionPool} POL, Diff: ${formatPOL(diffCommission)} POL`
  );

  if (!almostEqual(expectedPostCommission, calculatedPostCommissionPool, intervals.length || 1)) {
    errors.push(`Commission calculation error: ${expectedTotalFeesCollected} POL × ${(1 - blockProducerCommission) * 100}% should equal ${expectedTotalPostCommissionPool} POL but got ${formatPOL(calculatedPostCommissionPool)} POL`);
  }

  if (!almostEqual(expectedStakersPool, calculatedStakersPool, intervals.length || 1)) {
    errors.push(`Stakers pool calculation error: expected ${expectedTotalStakersPool} POL but got ${formatPOL(calculatedStakersPool)} POL`);
  }

  if (!almostEqual(expectedValidatorPool, calculatedValidatorPool, intervals.length || 1)) {
    errors.push(`Validator pool calculation error: expected ${expectedTotalValidatorPool} POL but got ${formatPOL(calculatedValidatorPool)} POL`);
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

  // Sum allocations from detailed report final allocations
  const validatorTotalsFromReport = new Map<number, bigint>();
  const finalAllocations = detailedReport.finalAllocations ?? {};
  for (const [validatorIdStr, data] of Object.entries(finalAllocations)) {
    const validatorId = parseInt(validatorIdStr);
    validatorTotalsFromReport.set(validatorId, parsePOL(data.feesAllocated));
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
  const reportTotal = Array.from(validatorTotalsFromReport.values()).reduce((sum, amount) => sum + amount, 0n);
  const transferTotal = parsePOL(transferFile.metadata.totalAmount);
  const diffTotal = reportTotal > transferTotal ? reportTotal - transferTotal : transferTotal - reportTotal;

  details.push(`Total Amount: Report ${formatPOL(reportTotal)} POL, Transfer ${transferFile.metadata.totalAmount} POL, Diff: ${formatPOL(diffTotal)} POL`);

  if (!almostEqual(reportTotal, transferTotal, validatorTotalsFromReport.size)) {
    errors.push(`Total amount mismatch: report shows ${formatPOL(reportTotal)} POL but transfer file shows ${transferFile.metadata.totalAmount} POL (difference: ${formatPOL(diffTotal)} POL)`);
  }

  const reportStakersTotal = parsePOL(detailedReport.summary.totalStakersPool);
  const reportBurnTotal = parsePOL(detailedReport.summary.totalEqualPoolBurn);
  const reportNonValidatorTotal = reportStakersTotal + reportBurnTotal;

  let transferStakersTotal: bigint | undefined;
  let transferBurnTotal: bigint | undefined;

  if (typeof transferFile.metadata.totalStakersPool !== 'string') {
    errors.push('Transfer file metadata is missing totalStakersPool');
  } else {
    transferStakersTotal = parsePOL(transferFile.metadata.totalStakersPool);
    const diffStakers = reportStakersTotal > transferStakersTotal
      ? reportStakersTotal - transferStakersTotal
      : transferStakersTotal - reportStakersTotal;

    details.push(
      `Stakers Pool: Report ${detailedReport.summary.totalStakersPool} POL, ` +
      `Transfer ${transferFile.metadata.totalStakersPool} POL, Diff: ${formatPOL(diffStakers)} POL`
    );

    if (!almostEqual(reportStakersTotal, transferStakersTotal, 1)) {
      errors.push(
        `Stakers pool mismatch: report shows ${detailedReport.summary.totalStakersPool} POL but ` +
        `transfer file shows ${transferFile.metadata.totalStakersPool} POL (difference: ${formatPOL(diffStakers)} POL)`
      );
    }
  }

  if (typeof transferFile.metadata.totalEqualPoolBurn !== 'string') {
    errors.push('Transfer file metadata is missing totalEqualPoolBurn');
  } else {
    transferBurnTotal = parsePOL(transferFile.metadata.totalEqualPoolBurn);
    const diffBurn = reportBurnTotal > transferBurnTotal
      ? reportBurnTotal - transferBurnTotal
      : transferBurnTotal - reportBurnTotal;

    details.push(
      `Equal Pool Burn: Report ${detailedReport.summary.totalEqualPoolBurn} POL, ` +
      `Transfer ${transferFile.metadata.totalEqualPoolBurn} POL, Diff: ${formatPOL(diffBurn)} POL`
    );

    if (!almostEqual(reportBurnTotal, transferBurnTotal, 1)) {
      errors.push(
        `Equal pool burn mismatch: report shows ${detailedReport.summary.totalEqualPoolBurn} POL but ` +
        `transfer file shows ${transferFile.metadata.totalEqualPoolBurn} POL (difference: ${formatPOL(diffBurn)} POL)`
      );
    }
  }

  if (transferStakersTotal !== undefined && transferBurnTotal !== undefined) {
    const transferNonValidatorTotal = transferStakersTotal + transferBurnTotal;
    const diffNonValidator = reportNonValidatorTotal > transferNonValidatorTotal
      ? reportNonValidatorTotal - transferNonValidatorTotal
      : transferNonValidatorTotal - reportNonValidatorTotal;

    details.push(
      `Non-Validator Total: Report ${formatPOL(reportNonValidatorTotal)} POL, ` +
      `Transfer ${formatPOL(transferNonValidatorTotal)} POL, Diff: ${formatPOL(diffNonValidator)} POL`
    );

    if (!almostEqual(reportNonValidatorTotal, transferNonValidatorTotal, 2)) {
      errors.push(
        `Non-validator POL mismatch: report stakers + burn equals ${formatPOL(reportNonValidatorTotal)} POL but ` +
        `transfer file stakers + burn equals ${formatPOL(transferNonValidatorTotal)} POL ` +
        `(difference: ${formatPOL(diffNonValidator)} POL)`
      );
    }
  }

  return { valid: errors.length === 0, errors, details };
}

function validateFinalAllocations(
  detailedReport: DetailedReport
): { valid: boolean; errors: string[]; details: string[] } {
  const errors: string[] = [];
  const details: string[] = [];

  const finalAllocations = detailedReport.finalAllocations ?? {};
  let totalStakeWeightedAllocated = 0n;
  let totalEqualAllocated = 0n;
  let totalAllocated = 0n;

  for (const [, data] of Object.entries(finalAllocations)) {
    totalStakeWeightedAllocated += parsePOL(data.stakeWeightedFeesAllocated);
    totalEqualAllocated += parsePOL(data.equalFeesAllocated);
    totalAllocated += parsePOL(data.feesAllocated);
  }

  const expectedStakeWeighted = parsePOL(detailedReport.summary.totalStakeWeightedValidatorPool);
  const expectedEqual = parsePOL(detailedReport.summary.totalEqualValidatorPool);
  const expectedBurn = parsePOL(detailedReport.summary.totalEqualPoolBurn);
  const expectedValidatorTotal = parsePOL(detailedReport.summary.totalValidatorPool);
  const validatorCount = Math.max(Object.keys(finalAllocations).length, 1);

  details.push(`Final stake-weighted allocations: ${formatPOL(totalStakeWeightedAllocated)} POL`);
  details.push(`Final equal allocations: ${formatPOL(totalEqualAllocated)} POL`);
  details.push(`Final total allocations: ${formatPOL(totalAllocated)} POL`);

  if (!almostEqual(expectedStakeWeighted, totalStakeWeightedAllocated, validatorCount)) {
    errors.push(`Stake-weighted total mismatch: expected ${detailedReport.summary.totalStakeWeightedValidatorPool} POL but got ${formatPOL(totalStakeWeightedAllocated)} POL`);
  }

  if (!almostEqual(expectedEqual, totalEqualAllocated + expectedBurn, validatorCount)) {
    errors.push(`Equal-pool reconciliation mismatch: expected ${detailedReport.summary.totalEqualValidatorPool} POL but allocations plus burn equal ${formatPOL(totalEqualAllocated + expectedBurn)} POL`);
  }

  if (!almostEqual(expectedValidatorTotal, totalAllocated + expectedBurn, validatorCount)) {
    errors.push(`Validator-pool reconciliation mismatch: expected ${detailedReport.summary.totalValidatorPool} POL but allocations plus burn equal ${formatPOL(totalAllocated + expectedBurn)} POL`);
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
      interval
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
    detailedReport.summary.totalPostCommissionPool,
    detailedReport.summary.totalStakersPool,
    detailedReport.summary.totalValidatorPool,
    detailedReport.summary.totalStakeWeightedValidatorPool,
    detailedReport.summary.totalEqualValidatorPool,
    detailedReport.summary.totalEqualPoolBurn,
    detailedReport.summary.totalFeesCollected,
    detailedReport.metadata.blockProducerCommission,
    detailedReport.metadata.stakersFeeRate
  );

  for (const detail of totalResult.details) {
    console.log(`${totalResult.valid ? '✓' : '✗'} ${detail}`);
  }

  if (!totalResult.valid) {
    allValid = false;
    allErrors.push(...totalResult.errors);
  }

  console.log('\n--- Validating Final Allocations ---');
  const equalResult = validateFinalAllocations(detailedReport);
  for (const detail of equalResult.details) {
    console.log(`${equalResult.valid ? '✓' : '✗'} ${detail}`);
  }
  if (!equalResult.valid) {
    allValid = false;
    allErrors.push(...equalResult.errors);
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
