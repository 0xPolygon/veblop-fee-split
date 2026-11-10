/**
 * PIP-82 split of a block range's base fees into relayer rebates and burn
 */

import { PIP82_BLOCK, PIP82_PRIOR_SETTLEMENT } from '../config/pip82';
import { SentTx } from '../services/etherscan.service';

export interface KeyFees {
  txCount: number;
  failedCount: number;
  gasUsed: bigint;
  baseFeeWei: bigint;
  priorityFeeWei: bigint;
  // set when the transactions don't cover the key's nonce range exactly once
  nonceProblem?: string;
  samples: SentTx[];
}

export interface Pip82Split {
  networkBaseFeeWei: bigint;
  rebatedWei: bigint;
  // network base fees minus rebates, for exactly this block range
  notRebatedWei: bigint;
  // base fees of this range that an earlier payout already sent out
  alreadyPaidWei: bigint;
  burnWei: bigint;
}

/**
 * Base and priority fees for one key's transactions (failed ones pay gas too):
 *   base = gasUsed × block base fee, priority = gasUsed × (effective gas price − base fee).
 * Also checks the transactions use nonces n0..n1−1 in order, and keeps a random sample of
 * them for spot checks.
 */
export async function summariseKey(
  txs: AsyncIterable<SentTx>,
  baseFee: (block: number) => bigint,
  nonceRange: [number, number],
  sampleSize: number
): Promise<KeyFees> {
  const fees: KeyFees = { txCount: 0, failedCount: 0, gasUsed: 0n, baseFeeWei: 0n, priorityFeeWei: 0n, samples: [] };
  let expectedNonce = nonceRange[0];
  for await (const tx of txs) {
    const blockBaseFee = baseFee(tx.block);
    if (tx.gasPrice < blockBaseFee) {
      throw new Error(`${tx.hash}: gas price ${tx.gasPrice} below block ${tx.block} base fee ${blockBaseFee}`);
    }
    if (tx.nonce !== expectedNonce && !fees.nonceProblem) {
      fees.nonceProblem = `expected nonce ${expectedNonce}, got ${tx.nonce} in ${tx.hash}`;
    }
    expectedNonce = tx.nonce + 1;
    fees.txCount++;
    fees.failedCount += tx.failed ? 1 : 0;
    fees.gasUsed += tx.gasUsed;
    fees.baseFeeWei += tx.gasUsed * blockBaseFee;
    fees.priorityFeeWei += tx.gasUsed * (tx.gasPrice - blockBaseFee);
    // reservoir sampling
    if (fees.samples.length < sampleSize) {
      fees.samples.push(tx);
    } else if (sampleSize > 0) {
      const j = Math.floor(Math.random() * fees.txCount);
      if (j < sampleSize) {
        fees.samples[j] = tx;
      }
    }
  }
  if (!fees.nonceProblem && fees.txCount !== nonceRange[1] - nonceRange[0]) {
    fees.nonceProblem = `${fees.txCount} txs, nonce range ${nonceRange[0]}..${nonceRange[1] - 1}`;
  }
  return fees;
}

/**
 * Throws for ranges that can't be settled on their own: before PIP-82, or overlapping the
 * last settlement's boundary.
 */
export function checkRange(startBlock: number, endBlock: number): void {
  const { lastBlock, payoutBlock } = PIP82_PRIOR_SETTLEMENT;
  if (endBlock < startBlock) {
    throw new Error('end block must be at or after start block');
  }
  if (startBlock < PIP82_BLOCK) {
    throw new Error(`start block must be at or after ${PIP82_BLOCK}: before PIP-82 base fees went straight to the burn collector`);
  }
  if (startBlock <= lastBlock && endBlock > lastBlock) {
    throw new Error(`blocks up to ${lastBlock} are already settled: start at ${lastBlock + 1}`);
  }
  if (startBlock > lastBlock + 1 && startBlock <= payoutBlock) {
    throw new Error(`the range after the last settlement starts at ${lastBlock + 1}, so that it carries the prior settlement adjustment`);
  }
}

export function computeSplit(
  startBlock: number,
  endBlock: number,
  networkBaseFeeWei: bigint,
  rebatedWei: bigint
): Pip82Split {
  checkRange(startBlock, endBlock);
  if (rebatedWei > networkBaseFeeWei) {
    throw new Error(`relayer base fees ${rebatedWei} exceed network base fees ${networkBaseFeeWei}`);
  }
  const notRebatedWei = networkBaseFeeWei - rebatedWei;
  const alreadyPaidWei = startBlock === PIP82_PRIOR_SETTLEMENT.lastBlock + 1 ? PIP82_PRIOR_SETTLEMENT.overpaidWei : 0n;
  if (alreadyPaidWei > notRebatedWei) {
    throw new Error(`range too short to absorb the ${alreadyPaidWei} wei already paid out`);
  }
  return { networkBaseFeeWei, rebatedWei, notRebatedWei, alreadyPaidWei, burnWei: notRebatedWei - alreadyPaidWei };
}
