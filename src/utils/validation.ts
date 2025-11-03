/**
 * Post-run validation utilities
 *
 * Validates output correctness by checking:
 * - Sum of fee deltas matches total fees collected
 * - Balance changes match fee deltas
 * - Sum of validator allocations matches validator pool
 * - Commission calculations are correct
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

export interface ValidationResult {
  passed: boolean;
  checks: {
    feeDeltaSum: boolean;
    balanceChange: boolean;
    allocationSum: boolean;
    commissionCalculation: boolean;
  };
  errors: string[];
}

/**
 * Validate output files for correctness
 * @param outputPath Path to the JSON output file
 * @returns Validation result with pass/fail status and errors
 */
export function validateOutput(outputPath: string): ValidationResult {
  const errors: string[] = [];
  const checks = {
    feeDeltaSum: false,
    balanceChange: false,
    allocationSum: false,
    commissionCalculation: false,
  };

  try {
    // Read output files
    const jsonPath = outputPath;
    const detailedReportPath = outputPath.replace(/\.json$/, '-detailed-report.json');
    const intervalsPath = outputPath.replace(/\.json$/, '-intervals.csv');
    const distributionPath = outputPath.replace(/\.json$/, '-distribution.csv');

    if (!fs.existsSync(jsonPath)) {
      errors.push(`JSON file not found: ${jsonPath}`);
      return { passed: false, checks, errors };
    }

    if (!fs.existsSync(intervalsPath)) {
      errors.push(`Intervals CSV not found: ${intervalsPath}`);
      return { passed: false, checks, errors };
    }

    if (!fs.existsSync(distributionPath)) {
      errors.push(`Distribution CSV not found: ${distributionPath}`);
      return { passed: false, checks, errors };
    }

    // Parse JSON (for backward compatibility, check both old and new format)
    let expectedTotalFees: number;
    let expectedValidatorPool: number;
    let commission: number;

    if (fs.existsSync(detailedReportPath)) {
      // New format: use detailed-report.json
      const detailedReport = JSON.parse(fs.readFileSync(detailedReportPath, 'utf-8'));
      expectedTotalFees = parseFloat(detailedReport.metadata.feeDistribution.totalFeesCollected);
      expectedValidatorPool = parseFloat(detailedReport.metadata.feeDistribution.validatorPoolShare);
      commission = detailedReport.metadata.feeDistribution.blockProducerCommissionRate;
    } else {
      // Old format: use main JSON
      const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      expectedTotalFees = parseFloat(jsonData.metadata.totalFeesCollected);
      expectedValidatorPool = parseFloat(jsonData.metadata.validatorPoolSize);
      commission = jsonData.metadata.blockProducerCommission;
    }

    // Parse intervals CSV
    const intervalsContent = fs.readFileSync(intervalsPath, 'utf-8');
    const intervalsLines = intervalsContent.trim().split('\n');
    const intervalsHeader = intervalsLines[0].split(',');

    const feeBalanceIdx = intervalsHeader.indexOf('Fee Balance (POL)');
    const feeDeltaIdx = intervalsHeader.indexOf('Fee Delta (POL)');

    if (feeBalanceIdx === -1 || feeDeltaIdx === -1) {
      errors.push('Could not find Fee Balance or Fee Delta columns in intervals CSV');
      return { passed: false, checks, errors };
    }

    // Sum fee deltas from intervals (skip header and last 2 rows which are performance scores)
    let totalFeeDelta = 0;
    let initialBalance = 0;
    let finalBalance = 0;

    for (let i = 1; i < intervalsLines.length - 2; i++) {
      const cols = intervalsLines[i].split(',');
      const feeDelta = parseFloat(cols[feeDeltaIdx]);
      const feeBalance = parseFloat(cols[feeBalanceIdx]);

      if (i === 1) {
        // First interval: calculate initial balance
        initialBalance = feeBalance - feeDelta;
      }

      totalFeeDelta += feeDelta;
      finalBalance = feeBalance;
    }

    // Check 1: Fee deltas sum correctly
    const feeDeltaDiff = Math.abs(totalFeeDelta - expectedTotalFees);
    if (feeDeltaDiff < 0.000001) {
      checks.feeDeltaSum = true;
    } else {
      errors.push(
        `Fee delta sum mismatch: expected ${expectedTotalFees.toFixed(6)} POL, ` +
        `got ${totalFeeDelta.toFixed(6)} POL (diff: ${feeDeltaDiff.toFixed(6)} POL)`
      );
    }

    // Check 2: Balance change matches fee deltas
    const balanceChangeDiff = Math.abs((finalBalance - initialBalance) - totalFeeDelta);
    if (balanceChangeDiff < 0.000001) {
      checks.balanceChange = true;
    } else {
      errors.push(
        `Balance change mismatch: expected ${totalFeeDelta.toFixed(6)} POL, ` +
        `got ${(finalBalance - initialBalance).toFixed(6)} POL (diff: ${balanceChangeDiff.toFixed(6)} POL)`
      );
    }

    // Parse distribution CSV
    const distributionContent = fs.readFileSync(distributionPath, 'utf-8');
    const distributionLines = distributionContent.trim().split('\n');
    const distributionHeader = distributionLines[0].split(',');

    const allocationIdx = distributionHeader.indexOf('Amount (POL)');
    if (allocationIdx === -1) {
      errors.push('Could not find Amount (POL) column in distribution CSV');
      return { passed: false, checks, errors };
    }

    // Sum allocations
    let totalAllocation = 0;
    for (let i = 1; i < distributionLines.length; i++) {
      const cols = distributionLines[i].split(',');
      const allocation = parseFloat(cols[allocationIdx]);
      totalAllocation += allocation;
    }

    // Check 3: Allocations sum correctly
    const allocationDiff = Math.abs(totalAllocation - expectedValidatorPool);
    if (allocationDiff < 0.001) {
      checks.allocationSum = true;
    } else {
      errors.push(
        `Allocation sum mismatch: expected ${expectedValidatorPool.toFixed(6)} POL, ` +
        `got ${totalAllocation.toFixed(6)} POL (diff: ${allocationDiff.toFixed(6)} POL)`
      );
    }

    // Check 4: Commission calculation
    const calculatedValidatorPool = expectedTotalFees * (1 - commission);
    const validatorPoolDiff = Math.abs(calculatedValidatorPool - expectedValidatorPool);
    if (validatorPoolDiff < 0.001) {
      checks.commissionCalculation = true;
    } else {
      errors.push(
        `Commission calculation mismatch: expected ${expectedValidatorPool.toFixed(6)} POL, ` +
        `calculated ${calculatedValidatorPool.toFixed(6)} POL (diff: ${validatorPoolDiff.toFixed(6)} POL)`
      );
    }

    const passed = Object.values(checks).every(check => check);
    return { passed, checks, errors };

  } catch (error) {
    errors.push(`Validation error: ${error instanceof Error ? error.message : String(error)}`);
    return { passed: false, checks, errors };
  }
}

/**
 * Run validation and log results
 * @param outputPath Path to the JSON output file
 */
export function runValidation(outputPath: string): void {
  logger.info('\n--- Step 10: Validating output ---');

  const result = validateOutput(outputPath);

  if (result.passed) {
    logger.info('✓ All validation checks passed');
    logger.info('  - Fee deltas sum correctly');
    logger.info('  - Balance changes match fee deltas');
    logger.info('  - Validator allocations sum correctly');
    logger.info('  - Commission calculated correctly');
  } else {
    logger.warn('✗ Some validation checks failed:');
    for (const error of result.errors) {
      logger.warn(`  - ${error}`);
    }

    logger.warn('\nValidation check status:');
    logger.warn(`  Fee Delta Sum: ${result.checks.feeDeltaSum ? '✓' : '✗'}`);
    logger.warn(`  Balance Change: ${result.checks.balanceChange ? '✓' : '✗'}`);
    logger.warn(`  Allocation Sum: ${result.checks.allocationSum ? '✓' : '✗'}`);
    logger.warn(`  Commission Calculation: ${result.checks.commissionCalculation ? '✓' : '✗'}`);
  }
}
