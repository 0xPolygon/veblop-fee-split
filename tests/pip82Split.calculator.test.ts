import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRange, computeSplit, summariseKey } from '../src/calculators/pip82Split.calculator';
import { PIP82_PRIOR_SETTLEMENT } from '../src/config/pip82';
import { SentTx } from '../src/services/etherscan.service';

const { lastBlock, payoutBlock, overpaidWei } = PIP82_PRIOR_SETTLEMENT;

async function* fromArray(txs: SentTx[]): AsyncGenerator<SentTx> {
  yield* txs;
}

function tx(block: number, nonce: number, gasUsed: bigint, gasPrice: bigint, failed = false): SentTx {
  return { block, nonce, gasUsed, gasPrice, failed, hash: `0x${block}-${nonce}` };
}

const baseFees = new Map([[100, 30n], [101, 40n]]);
const baseFee = (b: number) => baseFees.get(b)!;

test('summariseKey splits each tx into base and priority fees', async () => {
  const fees = await summariseKey(
    fromArray([tx(100, 7, 21_000n, 35n), tx(101, 8, 50_000n, 41n, true)]),
    baseFee,
    [7, 9],
    5
  );
  assert.equal(fees.txCount, 2);
  assert.equal(fees.failedCount, 1);
  assert.equal(fees.gasUsed, 71_000n);
  assert.equal(fees.baseFeeWei, 21_000n * 30n + 50_000n * 40n);
  assert.equal(fees.priorityFeeWei, 21_000n * 5n + 50_000n * 1n);
  assert.equal(fees.nonceProblem, undefined);
  assert.equal(fees.samples.length, 2);
});

test('summariseKey flags gaps and short nonce ranges', async () => {
  const gap = await summariseKey(fromArray([tx(100, 7, 1n, 30n), tx(101, 9, 1n, 40n)]), baseFee, [7, 10], 0);
  assert.match(gap.nonceProblem!, /expected nonce 8, got 9/);

  const short = await summariseKey(fromArray([tx(100, 7, 1n, 30n)]), baseFee, [7, 9], 0);
  assert.match(short.nonceProblem!, /1 txs, nonce range 7..8/);
});

test('summariseKey rejects a gas price below the base fee', async () => {
  await assert.rejects(summariseKey(fromArray([tx(100, 0, 1n, 29n)]), baseFee, [0, 1], 0), /below block 100 base fee/);
});

test('the range after the prior settlement burns less by the amount already paid out', () => {
  const network = overpaidWei * 10n;
  const split = computeSplit(lastBlock + 1, lastBlock + 1000, network, 5n);
  assert.equal(split.notRebatedWei, network - 5n);
  assert.equal(split.alreadyPaidWei, overpaidWei);
  assert.equal(split.burnWei, network - 5n - overpaidWei);
});

test('later ranges settle exactly their own blocks', () => {
  const split = computeSplit(95_879_701, 96_000_000, 1000n, 10n);
  assert.equal(split.alreadyPaidWei, 0n);
  assert.equal(split.burnWei, 990n);
});

test('checkRange rejects ranges that cannot be settled on their own', () => {
  assert.throws(() => checkRange(83_000_000, 84_000_000), /before PIP-82/);
  assert.throws(() => checkRange(lastBlock, lastBlock + 10), /already settled/);
  assert.throws(() => checkRange(lastBlock + 2, payoutBlock + 10), /starts at 88560001/);
  assert.throws(() => checkRange(lastBlock + 10, lastBlock + 1), /end block/);
  assert.doesNotThrow(() => checkRange(85_530_000, lastBlock));
});

test('computeSplit rejects rebates above the network total and ranges too short to absorb the adjustment', () => {
  assert.throws(() => computeSplit(95_879_701, 95_879_800, 10n, 11n), /exceed network base fees/);
  assert.throws(() => computeSplit(lastBlock + 1, lastBlock + 5, overpaidWei - 1n, 0n), /too short/);
});
