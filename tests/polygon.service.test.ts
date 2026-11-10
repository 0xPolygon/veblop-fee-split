import test from 'node:test';
import assert from 'node:assert/strict';
import { AppliedDistribution } from '../src/models/types';
import { detectionRange, sumDistributionsThrough, verifyCutoffBlock } from '../src/services/polygon.service';

function manual(polygonBlock: number, amount: bigint): AppliedDistribution {
  return { polygonBlock, amount, source: 'manual' };
}

test('detects from the block after the last manual entry when the run extends past it', () => {
  const entries = [manual(100, 1n), manual(250, 1n), manual(200, 1n)];

  assert.deepEqual(detectionRange(entries, 150, 400), { fromBlock: 251, toBlock: 400 });
});

test('detects from the block after the start block when manual entries end before the run', () => {
  assert.deepEqual(detectionRange([manual(100, 1n)], 300, 400), { fromBlock: 301, toBlock: 400 });
});

test('skips detection when manual entries cover the whole run', () => {
  assert.equal(detectionRange([manual(500, 1n)], 300, 400), null);
  assert.equal(detectionRange([manual(400, 1n)], 300, 400), null);
});

test('detects across the whole run when there are no manual entries', () => {
  assert.deepEqual(detectionRange([], 300, 400), { fromBlock: 301, toBlock: 400 });
});

test('sums distributions at or before the block, since balances are read after the block', () => {
  const entries: AppliedDistribution[] = [
    manual(100, 5n),
    { polygonBlock: 200, amount: 7n, source: 'detected', transactionHash: '0xabc' },
    manual(300, 11n),
  ];

  assert.equal(sumDistributionsThrough(entries, 99), 0n);
  assert.equal(sumDistributionsThrough(entries, 200), 12n);
  assert.equal(sumDistributionsThrough(entries, 1000), 23n);
});

test('accepts a cutoff block whose on-chain outflows match its json entries', () => {
  const entries = [manual(100, 5n), manual(200, 7n)];

  assert.doesNotThrow(() =>
    verifyCutoffBlock(entries, 200, [{ polygonBlock: 200, amount: 7n, transactionHash: '0xa' }])
  );
});

test('rejects a cutoff block with an on-chain outflow missing from the json', () => {
  const entries = [manual(200, 7n)];

  assert.throws(
    () =>
      verifyCutoffBlock(entries, 200, [
        { polygonBlock: 200, amount: 7n, transactionHash: '0xa' },
        { polygonBlock: 200, amount: 3n, transactionHash: '0xb' },
      ]),
    /1 entry at its last block 200, but 2 transaction\(s\).*0xb/
  );
});

test('rejects a cutoff block with no on-chain outflow behind its json entry', () => {
  assert.throws(() => verifyCutoffBlock([manual(200, 7n)], 200, []), /but 0 transaction\(s\).*none/);
});
