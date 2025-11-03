#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Get the latest timestamped files
const outputDir = './output';
const files = fs.readdirSync(outputDir);

// Find the most recent intervals and summary files
const intervalFiles = files.filter(f => f.includes('intervals.csv')).sort().reverse();
const summaryFiles = files.filter(f => f.includes('summary.csv')).sort().reverse();
const jsonFiles = files.filter(f => f.endsWith('.json') && !f.includes('intervals') && !f.includes('summary')).sort().reverse();

if (intervalFiles.length === 0 || summaryFiles.length === 0 || jsonFiles.length === 0) {
  console.error('Could not find output files');
  process.exit(1);
}

const intervalsFile = path.join(outputDir, intervalFiles[0]);
const summaryFile = path.join(outputDir, summaryFiles[0]);
const jsonFile = path.join(outputDir, jsonFiles[0]);

console.log('Verifying outputs from:');
console.log(`  - ${intervalsFile}`);
console.log(`  - ${summaryFile}`);
console.log(`  - ${jsonFile}`);
console.log();

// Read JSON file for expected totals
const jsonData = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
const expectedTotalFees = parseFloat(jsonData.metadata.totalFeesCollected);
const expectedValidatorPool = parseFloat(jsonData.metadata.validatorPoolSize);
const commission = jsonData.metadata.blockProducerCommission;

console.log('=== Expected Values from JSON ===');
console.log(`Total Fees Collected: ${expectedTotalFees.toFixed(18)} POL`);
console.log(`Validator Pool (after ${(commission * 100).toFixed(1)}% commission): ${expectedValidatorPool.toFixed(18)} POL`);
console.log();

// Parse intervals CSV
const intervalsContent = fs.readFileSync(intervalsFile, 'utf-8');
const intervalsLines = intervalsContent.trim().split('\n');
const intervalsHeader = intervalsLines[0].split(',');

// Find the Fee Balance and Fee Delta columns
const feeBalanceIdx = intervalsHeader.indexOf('Fee Balance (POL)');
const feeDeltaIdx = intervalsHeader.indexOf('Fee Delta (POL)');

if (feeBalanceIdx === -1 || feeDeltaIdx === -1) {
  console.error('Could not find Fee Balance or Fee Delta columns in intervals CSV');
  process.exit(1);
}

// Sum up fee deltas from intervals (skip header and last 2 rows which are performance scores)
let totalFeeDelta = 0;
let initialBalance = 0;
let finalBalance = 0;
let intervalCount = 0;

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
  intervalCount++;
}

console.log('=== Intervals CSV Analysis ===');
console.log(`Number of intervals: ${intervalCount}`);
console.log(`Initial fee balance: ${initialBalance.toFixed(18)} POL`);
console.log(`Final fee balance: ${finalBalance.toFixed(18)} POL`);
console.log(`Sum of fee deltas: ${totalFeeDelta.toFixed(18)} POL`);
console.log(`Balance change: ${(finalBalance - initialBalance).toFixed(18)} POL`);
console.log();

// Check if fee deltas match total fees collected
const feeDeltaDiff = Math.abs(totalFeeDelta - expectedTotalFees);
console.log('=== Fee Delta Verification ===');
if (feeDeltaDiff < 0.000001) {
  console.log(`✓ Sum of fee deltas matches total fees collected`);
  console.log(`  Difference: ${feeDeltaDiff.toFixed(18)} POL`);
} else {
  console.log(`✗ Sum of fee deltas DOES NOT match total fees collected`);
  console.log(`  Expected: ${expectedTotalFees.toFixed(18)} POL`);
  console.log(`  Actual: ${totalFeeDelta.toFixed(18)} POL`);
  console.log(`  Difference: ${feeDeltaDiff.toFixed(18)} POL`);
}
console.log();

// Check if balance change matches fee deltas
const balanceChangeDiff = Math.abs((finalBalance - initialBalance) - totalFeeDelta);
console.log('=== Balance Change Verification ===');
if (balanceChangeDiff < 0.000001) {
  console.log(`✓ Balance change matches sum of fee deltas`);
  console.log(`  Difference: ${balanceChangeDiff.toFixed(18)} POL`);
} else {
  console.log(`✗ Balance change DOES NOT match sum of fee deltas`);
  console.log(`  Difference: ${balanceChangeDiff.toFixed(18)} POL`);
}
console.log();

// Parse summary CSV
const summaryContent = fs.readFileSync(summaryFile, 'utf-8');
const summaryLines = summaryContent.trim().split('\n');
const summaryHeader = summaryLines[0].split(',');

// Find the Total POL Allocation column
const allocationIdx = summaryHeader.indexOf('Total POL Allocation');

if (allocationIdx === -1) {
  console.error('Could not find Total POL Allocation column in summary CSV');
  process.exit(1);
}

// Sum up allocations
let totalAllocation = 0;
let validatorCount = 0;

for (let i = 1; i < summaryLines.length; i++) {
  const cols = summaryLines[i].split(',');
  const allocation = parseFloat(cols[allocationIdx]);
  totalAllocation += allocation;
  validatorCount++;
}

console.log('=== Summary CSV Analysis ===');
console.log(`Number of validators: ${validatorCount}`);
console.log(`Sum of allocations: ${totalAllocation.toFixed(18)} POL`);
console.log();

// Check if allocations match validator pool
const allocationDiff = Math.abs(totalAllocation - expectedValidatorPool);
console.log('=== Allocation Verification ===');
if (allocationDiff < 0.001) {
  console.log(`✓ Sum of allocations matches validator pool`);
  console.log(`  Difference: ${allocationDiff.toFixed(18)} POL`);
} else {
  console.log(`✗ Sum of allocations DOES NOT match validator pool`);
  console.log(`  Expected: ${expectedValidatorPool.toFixed(18)} POL`);
  console.log(`  Actual: ${totalAllocation.toFixed(18)} POL`);
  console.log(`  Difference: ${allocationDiff.toFixed(18)} POL`);
}
console.log();

// Check commission calculation
const calculatedValidatorPool = expectedTotalFees * (1 - commission);
const validatorPoolDiff = Math.abs(calculatedValidatorPool - expectedValidatorPool);
console.log('=== Commission Verification ===');
if (validatorPoolDiff < 0.001) {
  console.log(`✓ Validator pool correctly calculated from total fees`);
  console.log(`  Total fees × (1 - ${(commission * 100).toFixed(1)}%) = ${calculatedValidatorPool.toFixed(18)} POL`);
  console.log(`  Difference: ${validatorPoolDiff.toFixed(18)} POL`);
} else {
  console.log(`✗ Validator pool calculation appears incorrect`);
  console.log(`  Expected: ${expectedValidatorPool.toFixed(18)} POL`);
  console.log(`  Calculated: ${calculatedValidatorPool.toFixed(18)} POL`);
  console.log(`  Difference: ${validatorPoolDiff.toFixed(18)} POL`);
}
console.log();

// Final summary
console.log('=== FINAL VERIFICATION SUMMARY ===');
const allChecksPass =
  feeDeltaDiff < 0.000001 &&
  balanceChangeDiff < 0.000001 &&
  allocationDiff < 0.001 &&
  validatorPoolDiff < 0.001;

if (allChecksPass) {
  console.log('✓ ALL CHECKS PASSED');
  console.log('  - Fee deltas sum correctly');
  console.log('  - Balance changes match fee deltas');
  console.log('  - Validator allocations sum correctly');
  console.log('  - Commission calculated correctly');
} else {
  console.log('✗ SOME CHECKS FAILED - Please review output above');
}
