/**
 * CSV and JSON reports for the PIP-82 rebate split
 */

import * as fs from 'fs';
import * as path from 'path';
import { KeyFees, Pip82Split } from '../calculators/pip82Split.calculator';
import { PIP82_BURN_COLLECTOR, PIP82_FEE_RECIPIENT, PIP82_PRIOR_SETTLEMENT } from '../config/pip82';
import { CsvWriter } from './csvWriter';

export interface Relayer {
  group: string;
  address: string;
}

export interface Pip82Report {
  startBlock: number;
  endBlock: number;
  relayers: Relayer[];
  fees: Map<string, KeyFees>;
  nonceRanges: Map<string, [number, number]>;
  networkGasUsed: bigint;
  split: Pip82Split;
  recipientBalanceAtEnd: bigint;
}

const CSV_HEADERS = [
  'group', 'address', 'tx_count', 'tx_count_from_nonces', 'failed_tx_count', 'gas_used',
  'base_fee_pol', 'priority_fee_pol', 'total_fee_pol', 'avg_base_fee_gwei', 'avg_priority_fee_gwei',
];

const pol = (wei: bigint) => CsvWriter.formatBigInt(wei);

/**
 * Gas-weighted average in gwei, 4 decimals, rounded half up
 */
function gwei(wei: bigint, gas: bigint): string {
  if (gas === 0n) {
    return '0.0000';
  }
  const scaled = (wei * 2n * 10_000n / (gas * 1_000_000_000n) + 1n) / 2n;
  return CsvWriter.formatBigInt(scaled, 4);
}

function emptyFees(): KeyFees {
  return { txCount: 0, failedCount: 0, gasUsed: 0n, baseFeeWei: 0n, priorityFeeWei: 0n, samples: [] };
}

function addFees(total: KeyFees, fees: KeyFees): void {
  total.txCount += fees.txCount;
  total.failedCount += fees.failedCount;
  total.gasUsed += fees.gasUsed;
  total.baseFeeWei += fees.baseFeeWei;
  total.priorityFeeWei += fees.priorityFeeWei;
}

function feeRow(group: string, address: string, fees: KeyFees, nonceTxs: number): string[] {
  return [
    group, address, String(fees.txCount), String(nonceTxs), String(fees.failedCount), String(fees.gasUsed),
    pol(fees.baseFeeWei), pol(fees.priorityFeeWei), pol(fees.baseFeeWei + fees.priorityFeeWei),
    gwei(fees.baseFeeWei, fees.gasUsed), gwei(fees.priorityFeeWei, fees.gasUsed),
  ];
}

// network-wide lines only have gas and base fee: headers carry no tx count or tips
function baseFeeRow(label: string, address: string, wei: bigint, gas?: bigint): string[] {
  return [label, address, '', '', '', gas === undefined ? '' : String(gas), pol(wei), '', '',
    gas === undefined ? '' : gwei(wei, gas), ''];
}

export function groupTotals(report: Pip82Report): Map<string, { fees: KeyFees; nonceTxs: number }> {
  const totals = new Map<string, { fees: KeyFees; nonceTxs: number }>();
  for (const { group, address } of report.relayers) {
    const total = totals.get(group) ?? { fees: emptyFees(), nonceTxs: 0 };
    const [n0, n1] = report.nonceRanges.get(address.toLowerCase())!;
    addFees(total.fees, report.fees.get(address.toLowerCase())!);
    total.nonceTxs += n1 - n0;
    totals.set(group, total);
  }
  return totals;
}

export function writePip82Csv(report: Pip82Report, filePath: string): void {
  const rows: string[][] = [];
  const grand = { fees: emptyFees(), nonceTxs: 0 };
  for (const [group, total] of groupTotals(report)) {
    for (const r of report.relayers.filter(r => r.group === group)) {
      const [n0, n1] = report.nonceRanges.get(r.address.toLowerCase())!;
      rows.push(feeRow(group, r.address, report.fees.get(r.address.toLowerCase())!, n1 - n0));
    }
    rows.push(feeRow(group, 'TOTAL', total.fees, total.nonceTxs));
    addFees(grand.fees, total.fees);
    grand.nonceTxs += total.nonceTxs;
  }
  rows.push(feeRow('ALL GROUPS (rebated)', 'TOTAL', grand.fees, grand.nonceTxs));

  const { split, networkGasUsed } = report;
  rows.push(baseFeeRow('NETWORK', 'TOTAL', split.networkBaseFeeWei, networkGasUsed));
  rows.push(baseFeeRow('NOT REBATED', 'TOTAL', split.notRebatedWei, networkGasUsed - grand.fees.gasUsed));
  if (split.alreadyPaidWei > 0n) {
    rows.push(baseFeeRow(`ALREADY PAID OUT AT BLOCK ${PIP82_PRIOR_SETTLEMENT.payoutBlock}`, 'TOTAL', split.alreadyPaidWei));
  }
  rows.push(baseFeeRow('BURN', PIP82_BURN_COLLECTOR, split.burnWei));
  CsvWriter.write(filePath, CSV_HEADERS, rows);
}

export function writePip82Json(report: Pip82Report, filePath: string): void {
  const { split } = report;
  const output = {
    metadata: {
      startPolygonBlock: report.startBlock,
      endPolygonBlock: report.endBlock,
      feeRecipient: PIP82_FEE_RECIPIENT,
      burnCollector: PIP82_BURN_COLLECTOR,
      generatedAt: new Date().toISOString(),
    },
    summary: {
      networkBaseFees: pol(split.networkBaseFeeWei),
      rebated: pol(split.rebatedWei),
      notRebated: pol(split.notRebatedWei),
      alreadyPaidOut: pol(split.alreadyPaidWei),
      burn: pol(split.burnWei),
      feeRecipientBalanceAtEndBlock: pol(report.recipientBalanceAtEnd),
    },
    rebates: [...groupTotals(report)].map(([group, total]) => ({ group, amount: pol(total.fees.baseFeeWei) })),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2) + '\n');
}
