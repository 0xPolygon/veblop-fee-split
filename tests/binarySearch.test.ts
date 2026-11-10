import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BlockFetcher,
  binarySearchBlockByTimestampGte,
  binarySearchBlockByTimestampLte,
} from '../src/utils/binarySearch';

// Block n has timestamp 10n
const chain: BlockFetcher = async (n) => ({ number: n, timestamp: n * 10 });

function failingAt(badBlock: number): BlockFetcher {
  return async (n) => {
    if (n === badBlock) {
      throw new Error('rpc unavailable');
    }
    return chain(n);
  };
}

test('finds the smallest block at or after the target timestamp', async () => {
  assert.equal(await binarySearchBlockByTimestampGte(455, 0, 100, chain), 46);
  assert.equal(await binarySearchBlockByTimestampGte(460, 0, 100, chain), 46);
});

test('finds the largest block at or before the target timestamp', async () => {
  assert.equal(await binarySearchBlockByTimestampLte(455, 0, 100, chain), 45);
  assert.equal(await binarySearchBlockByTimestampLte(460, 0, 100, chain), 46);
});

test('fails instead of skipping a block it cannot fetch', async () => {
  // 50 is the first midpoint of [0, 100]
  await assert.rejects(binarySearchBlockByTimestampGte(455, 0, 100, failingAt(50)), /failed to fetch block 50: rpc unavailable/);
  await assert.rejects(binarySearchBlockByTimestampLte(455, 0, 100, failingAt(50)), /failed to fetch block 50: rpc unavailable/);
});
