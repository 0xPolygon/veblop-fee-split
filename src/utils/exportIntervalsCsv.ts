#!/usr/bin/env node

/**
 * Export interval data to CSV files
 *
 * Creates one CSV file per interval with:
 * - Columns for each validator ID (consistent across all files)
 * - Row 1: Stake (POL)
 * - Row 2: Performance Score
 * - Row 3: Total fees allocated (POL)
 * - Row 4: Stake-weighted fees allocated (POL)
 * - Row 5: Equal fees allocated (POL)
 */

import * as fs from 'fs';
import * as path from 'path';

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
    startTimestampISO: string;
    endTimestampISO: string;
    ethereumBlockAtStart: number;
    polygonBlockAtEnd: number;
    heimdallBlockAtEnd: number;
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
}

/**
 * Escape CSV values that contain commas, quotes, or newlines
 */
function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Get all unique validator IDs across all intervals (sorted)
 */
function getAllValidatorIds(report: DetailedReport): number[] {
  const validatorIds = new Set<number>();

  for (const interval of report.intervals) {
    for (const validatorId of Object.keys(interval.validators)) {
      validatorIds.add(parseInt(validatorId));
    }
  }

  return Array.from(validatorIds).sort((a, b) => a - b);
}

/**
 * Generate CSV content for a single interval
 */
function generateIntervalCSV(
  interval: DetailedReport['intervals'][0],
  allValidatorIds: number[]
): string {
  const lines: string[] = [];

  // Info rows
  const intervalInfoRow = ['Interval Times', interval.startTimestampISO, interval.endTimestampISO];
  lines.push(intervalInfoRow.map(escapeCSV).join(','));

  const totalFeesCollectedRow = ['Total Interval Fees Collected', interval.feesCollected];
  lines.push(totalFeesCollectedRow.map(escapeCSV).join(','));

  const validatorPoolFeesRow = ['Validator Pool Fees', interval.validatorPoolFees];
  lines.push(validatorPoolFeesRow.map(escapeCSV).join(','));

  const stakersPoolFeesRow = ['Stakers Pool Fees', interval.stakersPoolFees];
  lines.push(stakersPoolFeesRow.map(escapeCSV).join(','));

  const stakeWeightedPoolFeesRow = ['Stake-Weighted Pool Fees', interval.stakeWeightedValidatorPoolFees];
  lines.push(stakeWeightedPoolFeesRow.map(escapeCSV).join(','));

  const equalPoolFeesRow = ['Equal Pool Fees', interval.equalValidatorPoolFees];
  lines.push(equalPoolFeesRow.map(escapeCSV).join(','));

  const equalBurnFeesRow = ['Equal Pool Burn Fees', interval.equalPoolBurnFees];
  lines.push(equalBurnFeesRow.map(escapeCSV).join(','));

  const perfectPerformanceRow = ['Perfect Performance', interval.perfectPerformance];
  lines.push(perfectPerformanceRow.map(escapeCSV).join(','));

  const rewardedValidatorCountRow = ['Rewarded Validator Count', interval.rewardedValidatorCount.toString()];
  lines.push(rewardedValidatorCountRow.map(escapeCSV).join(','));

  // Header row: Validator IDs
  const headerRow = ['Validator ID', ...allValidatorIds.map(id => id.toString())];
  lines.push(headerRow.map(escapeCSV).join(','));

  // Row 1: Stake at interval start
  const stakeRow = ['Stake (POL)'];
  for (const validatorId of allValidatorIds) {
    const validator = interval.validators[validatorId.toString()];
    stakeRow.push(validator ? validator.stakeAtStart : '0');
  }
  lines.push(stakeRow.map(escapeCSV).join(','));

  // Row 2: Performance delta
  const performanceRow = ['Performance Score'];
  for (const validatorId of allValidatorIds) {
    const validator = interval.validators[validatorId.toString()];
    performanceRow.push(validator ? validator.performanceDelta : '0');
  }
  lines.push(performanceRow.map(escapeCSV).join(','));

  // Row 3: Fees allocated
  const feesRow = ['Fees Allocated (POL)'];
  for (const validatorId of allValidatorIds) {
    const validator = interval.validators[validatorId.toString()];
    feesRow.push(validator ? validator.feesAllocated : '0');
  }
  lines.push(feesRow.map(escapeCSV).join(','));

  const stakeWeightedFeesRow = ['Stake-Weighted Fees (POL)'];
  for (const validatorId of allValidatorIds) {
    const validator = interval.validators[validatorId.toString()];
    stakeWeightedFeesRow.push(validator ? validator.stakeWeightedFeesAllocated : '0');
  }
  lines.push(stakeWeightedFeesRow.map(escapeCSV).join(','));

  const equalFeesRow = ['Equal Fees (POL)'];
  for (const validatorId of allValidatorIds) {
    const validator = interval.validators[validatorId.toString()];
    equalFeesRow.push(validator ? validator.equalFeesAllocated : '0');
  }
  lines.push(equalFeesRow.map(escapeCSV).join(','));

  return lines.join('\n');
}

/**
 * Export all intervals to CSV files
 */
function exportIntervalsToCsv(
  detailedReportPath: string,
  outputDir?: string
): void {
  console.log('=== Exporting Intervals to CSV ===\n');

  // Load detailed report
  console.log(`Loading detailed report: ${detailedReportPath}`);
  if (!fs.existsSync(detailedReportPath)) {
    console.error(`ERROR: File not found: ${detailedReportPath}`);
    process.exit(1);
  }

  const report: DetailedReport = JSON.parse(fs.readFileSync(detailedReportPath, 'utf-8'));
  console.log(`Loaded report with ${report.intervals.length} intervals\n`);

  // Determine output directory
  const baseOutputDir = outputDir || path.dirname(detailedReportPath);
  const csvOutputDir = path.join(
    baseOutputDir,
    `intervals-${report.metadata.startPolygonBlock}-${report.metadata.endPolygonBlock}`
  );

  // Create output directory
  if (!fs.existsSync(csvOutputDir)) {
    fs.mkdirSync(csvOutputDir, { recursive: true });
  }

  console.log(`Output directory: ${csvOutputDir}\n`);

  // Get all validator IDs (consistent across all files)
  const allValidatorIds = getAllValidatorIds(report);
  console.log(`Found ${allValidatorIds.length} unique validators across all intervals`);
  console.log(`Validator IDs: ${allValidatorIds.slice(0, 10).join(', ')}${allValidatorIds.length > 10 ? '...' : ''}\n`);

  // Generate CSV for each interval
  console.log('--- Generating CSV Files ---');
  const generatedFiles: string[] = [];

  for (const interval of report.intervals) {
    const csvContent = generateIntervalCSV(interval, allValidatorIds);

    // Create filename with interval number and timestamps
    const filename = `interval-${String(interval.intervalNumber).padStart(3, '0')}-${interval.startTimestamp}-${interval.endTimestamp}.csv`;
    const filePath = path.join(csvOutputDir, filename);

    fs.writeFileSync(filePath, csvContent, 'utf-8');
    generatedFiles.push(filePath);

    console.log(`✓ Generated: ${filename}`);
    console.log(`  Time range: ${interval.startTimestampISO} → ${interval.endTimestampISO}`);
    console.log(`  Fees allocated: ${interval.validatorPoolFees} POL`);
    console.log(`  Active validators: ${Object.keys(interval.validators).length}`);
  }

  // Generate summary CSV with totals across all intervals
  console.log('\n--- Generating Summary CSV ---');
  const summaryLines: string[] = [];

  // Header row
  const summaryHeader = ['Validator ID', 'Total Fees Allocated (POL)'];
  summaryLines.push(summaryHeader.join(','));

  // Calculate totals per validator
  const validatorTotals = new Map<number, number>();

  for (const interval of report.intervals) {
    for (const [validatorIdStr, data] of Object.entries(interval.validators)) {
      const validatorId = parseInt(validatorIdStr);
      const currentTotal = validatorTotals.get(validatorId) || 0;
      validatorTotals.set(validatorId, currentTotal + parseFloat(data.feesAllocated));
    }
  }

  // Sort by validator ID and add rows
  const sortedValidators = Array.from(validatorTotals.entries()).sort((a, b) => a[0] - b[0]);
  for (const [validatorId, total] of sortedValidators) {
    summaryLines.push(`${validatorId},${total.toFixed(18)}`);
  }

  const summaryFilename = `summary-totals.csv`;
  const summaryFilePath = path.join(csvOutputDir, summaryFilename);
  fs.writeFileSync(summaryFilePath, summaryLines.join('\n'), 'utf-8');
  generatedFiles.push(summaryFilePath);

  console.log(`✓ Generated: ${summaryFilename}`);
  console.log(`  Total validators: ${validatorTotals.size}`);
  console.log(`  Total allocated: ${report.summary.totalValidatorPool} POL`);

  // Print summary
  console.log('\n=== Export Complete ===');
  console.log(`Generated ${generatedFiles.length} files in: ${csvOutputDir}`);
  console.log(`\nFiles:`);
  console.log(`  - ${report.intervals.length} interval CSV files`);
  console.log(`  - 1 summary totals CSV file`);
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: npm run export-csv <detailed-report.json> [output-directory]');
    console.log('\nExample:');
    console.log('  npm run export-csv ./output/fee-splits-detailed-77414656-77415299-2025-01-15.json');
    console.log('  npm run export-csv ./output/fee-splits-detailed-77414656-77415299-2025-01-15.json ./csv-exports');
    console.log('\nOutput:');
    console.log('  Creates a directory: intervals-{startBlock}-{endBlock}/');
    console.log('  Contains:');
    console.log('    - One CSV per interval: interval-000-{startTs}-{endTs}.csv');
    console.log('    - Summary file: summary-totals.csv');
    console.log('\nEach interval CSV has:');
    console.log('  - Header row: Validator IDs (consistent across all files)');
    console.log('  - Row 1: Stake (POL)');
    console.log('  - Row 2: Performance Score');
    console.log('  - Row 3: Fees Allocated (POL)');
    console.log('  - Row 4: Stake-Weighted Fees (POL)');
    console.log('  - Row 5: Equal Fees (POL)');
    process.exit(1);
  }

  const detailedReportPath = args[0];
  const outputDir = args[1];

  exportIntervalsToCsv(detailedReportPath, outputDir);
}

export { exportIntervalsToCsv };
