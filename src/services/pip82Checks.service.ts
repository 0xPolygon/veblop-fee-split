/**
 * On-chain cross-checks for the PIP-82 rebate split. Each returns a list of problems.
 */

import { PIP82_FEE_RECIPIENT, PIP82_PRIOR_SETTLEMENT } from '../config/pip82';
import { BatchRpcService, RpcCall } from './batchRpc.service';
import { BlockHeaderStore } from './blockHeaders.service';
import { SentTx } from './etherscan.service';

interface RpcBlock {
  gasUsed: string;
  baseFeePerGas: string;
}

interface RpcReceipt {
  from: string;
  blockNumber: string;
  gasUsed: string;
  effectiveGasPrice: string;
}

const hex = (n: number) => '0x' + n.toString(16);

/**
 * Etherscan's gasUsed and gas price, and our base fee, against receipts and blocks
 */
export async function checkSampledTxs(
  rpc: BatchRpcService,
  samples: Array<{ address: string; tx: SentTx }>,
  headers: BlockHeaderStore
): Promise<string[]> {
  const calls: RpcCall[] = samples.flatMap(({ tx }) => [
    ['eth_getTransactionReceipt', [tx.hash]],
    ['eth_getBlockByNumber', [hex(tx.block), false]],
  ]);
  const results = await rpc.callMany(calls);
  const problems: string[] = [];
  samples.forEach(({ address, tx }, k) => {
    const receipt = results[2 * k] as RpcReceipt;
    const block = results[2 * k + 1] as RpcBlock;
    const checks: Array<[string, unknown, unknown]> = [
      ['from', receipt.from.toLowerCase(), address.toLowerCase()],
      ['block', Number(receipt.blockNumber), tx.block],
      ['gas used', BigInt(receipt.gasUsed), tx.gasUsed],
      ['effective gas price', BigInt(receipt.effectiveGasPrice), tx.gasPrice],
      ['base fee', BigInt(block.baseFeePerGas), headers.baseFee(tx.block)],
    ];
    for (const [name, chain, ours] of checks) {
      if (chain !== ours) {
        problems.push(`${tx.hash} ${name}: chain=${chain} ours=${ours}`);
      }
    }
  });
  return problems;
}

/**
 * Per sampled block: our decoded header matches eth_getBlockByNumber, and the fee recipient's
 * balance rose by exactly gasUsed × baseFee. A payout out of the fee recipient in a sampled
 * block also shows up here.
 */
export async function checkSampledBlocks(
  rpc: BatchRpcService,
  headers: BlockHeaderStore,
  count: number
): Promise<string[]> {
  const blocks = new Set<number>();
  const span = headers.endBlock - headers.startBlock + 1;
  while (blocks.size < Math.min(count, span)) {
    blocks.add(headers.startBlock + Math.floor(Math.random() * span));
  }
  const calls: RpcCall[] = [...blocks].flatMap(b => [
    ['eth_getBlockByNumber', [hex(b), false]],
    ['eth_getBalance', [PIP82_FEE_RECIPIENT, hex(b - 1)]],
    ['eth_getBalance', [PIP82_FEE_RECIPIENT, hex(b)]],
  ]);
  const results = await rpc.callMany(calls);
  const problems: string[] = [];
  [...blocks].forEach((b, k) => {
    const block = results[3 * k] as RpcBlock;
    const received = BigInt(results[3 * k + 2] as string) - BigInt(results[3 * k + 1] as string);
    const gasUsed = headers.gasUsed(b);
    const baseFee = headers.baseFee(b);
    if (BigInt(block.gasUsed) !== gasUsed || BigInt(block.baseFeePerGas) !== baseFee) {
      problems.push(`block ${b}: header gas used/base fee chain=${block.gasUsed}/${block.baseFeePerGas} ours=${gasUsed}/${baseFee}`);
    } else if (received !== gasUsed * baseFee) {
      problems.push(`block ${b}: fee recipient received ${received} wei, gas used × base fee = ${gasUsed * baseFee}`);
    }
  });
  return problems;
}

/**
 * Re-derives PIP82_PRIOR_SETTLEMENT.overpaidWei: what left the fee recipient at the payout
 * block, less its balance at the end of the range that payout settled.
 */
export async function checkPriorSettlement(rpc: BatchRpcService): Promise<string[]> {
  const { lastBlock, payoutBlock, overpaidWei } = PIP82_PRIOR_SETTLEMENT;
  const [settledBalance, before, after, block] = await rpc.callMany([
    ['eth_getBalance', [PIP82_FEE_RECIPIENT, hex(lastBlock)]],
    ['eth_getBalance', [PIP82_FEE_RECIPIENT, hex(payoutBlock - 1)]],
    ['eth_getBalance', [PIP82_FEE_RECIPIENT, hex(payoutBlock)]],
    ['eth_getBlockByNumber', [hex(payoutBlock), false]],
  ]);
  const { gasUsed, baseFeePerGas } = block as RpcBlock;
  const paidOut = BigInt(before as string) + BigInt(gasUsed) * BigInt(baseFeePerGas) - BigInt(after as string);
  const overpaid = paidOut - BigInt(settledBalance as string);
  return overpaid === overpaidWei ? [] : [`prior settlement: chain says ${overpaid} wei overpaid, config says ${overpaidWei}`];
}

export async function getRecipientBalance(rpc: BatchRpcService, block: number): Promise<bigint> {
  return BigInt(await rpc.call<string>('eth_getBalance', [PIP82_FEE_RECIPIENT, hex(block)]));
}

/**
 * Nonces of each address just before startBlock and at endBlock
 */
export async function getNonceRanges(
  rpc: BatchRpcService,
  addresses: string[],
  startBlock: number,
  endBlock: number
): Promise<Map<string, [number, number]>> {
  const results = await rpc.callMany<string>(addresses.flatMap(a => [
    ['eth_getTransactionCount', [a, hex(startBlock - 1)]] as RpcCall,
    ['eth_getTransactionCount', [a, hex(endBlock)]] as RpcCall,
  ]));
  return new Map(addresses.map((a, i) => [a.toLowerCase(), [Number(results[2 * i]), Number(results[2 * i + 1])]]));
}
