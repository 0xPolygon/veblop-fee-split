#!/usr/bin/env node

/**
 * PIP-82 base-fee rebate split for a Polygon block range
 *
 * Since PIP-82 every block's base fees accrue to the fee recipient. For a block range this
 * computes the base fees paid by each relayer key (rebated), the network's base fees (from every
 * block header), and the rest, which goes to the burn collector.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ethers } from 'ethers';
import { getPip82Config } from './config/env';
import { PIP82_FEE_RECIPIENT, PIP82_PRIOR_SETTLEMENT } from './config/pip82';
import { checkRange, computeSplit, KeyFees, summariseKey } from './calculators/pip82Split.calculator';
import { BatchRpcService } from './services/batchRpc.service';
import { BlockHeaderStore } from './services/blockHeaders.service';
import { EtherscanService, readSentTxs } from './services/etherscan.service';
import {
  checkPriorSettlement, checkSampledBlocks, checkSampledTxs, getNonceRanges, getRecipientBalance,
} from './services/pip82Checks.service';
import { logger } from './utils/logger';
import { Pip82Report, Relayer, writePip82Csv, writePip82Json } from './utils/pip82OutputWriter';

interface Pip82Options {
  startBlock: number;
  endBlock: number;
  relayers: string;
  output?: string;
  cache: string;
  rpc?: string;
  rpcBatch: number;
  rpcConcurrency: number;
  etherscanRps: number;
  verifyTxs: number;
  verifyBlocks: number;
  headersOnly: boolean;
}

function loadRelayers(filePath: string): Relayer[] {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').map(l => l.trim()).filter(l => l !== '');
  if (lines[0] !== 'group,address') {
    throw new Error(`${filePath}: expected a "group,address" header`);
  }
  const relayers = lines.slice(1).map(l => {
    const i = l.lastIndexOf(',');
    return { group: l.slice(0, i).trim(), address: l.slice(i + 1).trim() };
  });
  const seen = new Set<string>();
  for (const { address } of relayers) {
    if (!ethers.isAddress(address) || seen.has(address.toLowerCase())) {
      throw new Error(`${filePath}: invalid or duplicate address ${address}`);
    }
    seen.add(address.toLowerCase());
  }
  return relayers;
}

async function fetchAllTxLists(etherscan: EtherscanService, relayers: Relayer[], opts: Pip82Options): Promise<Map<string, string>> {
  logger.info('Fetching transaction lists from Etherscan');
  const paths = new Map<string, string>();
  let next = 0;
  const worker = async () => {
    while (next < relayers.length) {
      const { address } = relayers[next++];
      paths.set(address.toLowerCase(), await etherscan.fetchSentTxs(address, opts.startBlock, opts.endBlock));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return paths;
}

async function summariseAll(
  relayers: Relayer[],
  txPaths: Map<string, string>,
  headers: BlockHeaderStore,
  nonceRanges: Map<string, [number, number]>,
  verifyTxs: number
): Promise<{ fees: Map<string, KeyFees>; problems: string[] }> {
  const fees = new Map<string, KeyFees>();
  const problems: string[] = [];
  for (const { address } of relayers) {
    const key = address.toLowerCase();
    const keyFees = await summariseKey(readSentTxs(txPaths.get(key)!), b => headers.baseFee(b), nonceRanges.get(key)!, verifyTxs);
    if (keyFees.nonceProblem) {
      problems.push(`${address}: ${keyFees.nonceProblem}`);
    }
    fees.set(key, keyFees);
  }
  return { fees, problems };
}

async function runChecks(rpc: BatchRpcService, report: Pip82Report, headers: BlockHeaderStore, opts: Pip82Options): Promise<string[]> {
  const samples = report.relayers.flatMap(({ address }) =>
    report.fees.get(address.toLowerCase())!.samples.map(tx => ({ address, tx })));
  logger.info(`Spot-checking ${samples.length} txs against receipts and blocks`);
  const problems = await checkSampledTxs(rpc, samples, headers);

  logger.info(`Spot-checking ${opts.verifyBlocks} blocks against headers and ${PIP82_FEE_RECIPIENT}'s balance`);
  problems.push(...await checkSampledBlocks(rpc, headers, opts.verifyBlocks));

  if (report.split.alreadyPaidWei > 0n) {
    logger.info(`Re-deriving the amount already paid out at block ${PIP82_PRIOR_SETTLEMENT.payoutBlock}`);
    problems.push(...await checkPriorSettlement(rpc));
  }
  return problems;
}

function logSplit(report: Pip82Report): void {
  const { split, recipientBalanceAtEnd } = report;
  const pol = (wei: bigint) => ethers.formatEther(wei);
  logger.info(`Network base fees ${pol(split.networkBaseFeeWei)} POL, rebated ${pol(split.rebatedWei)}, not rebated ${pol(split.notRebatedWei)}`);
  if (split.alreadyPaidWei > 0n) {
    logger.info(`Already paid out at block ${PIP82_PRIOR_SETTLEMENT.payoutBlock}: ${pol(split.alreadyPaidWei)} POL`);
  }
  logger.info(`Burn: ${pol(split.burnWei)} POL`);
  // The recipient should hold exactly this range's fees at its end block, less earlier payouts'
  // Safe gas refunds. A large positive difference means an earlier range is still unpaid.
  const left = recipientBalanceAtEnd - split.rebatedWei - split.burnWei;
  logger.info(`Fee recipient balance at block ${report.endBlock}: ${pol(recipientBalanceAtEnd)} POL; after paying this range from it: ${pol(left)} POL`);
}

async function run(opts: Pip82Options): Promise<void> {
  checkRange(opts.startBlock, opts.endBlock);
  const config = getPip82Config();
  const rpc = new BatchRpcService(opts.rpc ?? config.polygonRpcUrl, opts.rpcBatch);
  const headers = new BlockHeaderStore(opts.startBlock, opts.endBlock, opts.cache);
  if (opts.headersOnly) {
    await headers.fetch(rpc, opts.rpcBatch * 4, opts.rpcConcurrency);
    logger.info('Headers cached');
    return;
  }

  const relayers = loadRelayers(opts.relayers);
  logger.info(`${relayers.length} keys, blocks ${opts.startBlock}..${opts.endBlock}`);
  const nonceRanges = await getNonceRanges(rpc, relayers.map(r => r.address), opts.startBlock, opts.endBlock);
  const etherscan = new EtherscanService(config.etherscanApiKey, opts.etherscanRps, opts.cache);
  const txPaths = await fetchAllTxLists(etherscan, relayers, opts);
  await headers.fetch(rpc, opts.rpcBatch * 4, opts.rpcConcurrency);

  logger.info('Aggregating');
  const network = headers.networkTotals();
  const { fees, problems } = await summariseAll(relayers, txPaths, headers, nonceRanges, opts.verifyTxs);
  const rebatedWei = [...fees.values()].reduce((sum, f) => sum + f.baseFeeWei, 0n);
  const report: Pip82Report = {
    startBlock: opts.startBlock, endBlock: opts.endBlock, relayers, fees, nonceRanges,
    networkGasUsed: network.gasUsed,
    split: computeSplit(opts.startBlock, opts.endBlock, network.baseFeeWei, rebatedWei),
    recipientBalanceAtEnd: await getRecipientBalance(rpc, opts.endBlock),
  };
  problems.push(...await runChecks(rpc, report, headers, opts));
  logSplit(report);

  const outputDir = opts.output ?? config.outputPath;
  const base = path.join(outputDir, `pip82-rebates-${opts.startBlock}-${opts.endBlock}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  writePip82Csv(report, `${base}.csv`);
  writePip82Json(report, `${base}.json`);
  logger.info(`Wrote ${base}.csv and ${base}.json`);

  if (problems.length > 0) {
    throw new Error(`Checks failed:\n  ${problems.join('\n  ')}`);
  }
  logger.info('Checks passed: tx counts match nonce ranges, sampled txs match receipts, sampled blocks match the fee recipient\'s balance');
}

const positive = (name: string) => (value: string) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return n;
};

const program = new Command();

program
  .name('pip82')
  .description('Split a Polygon block range\'s base fees into PIP-82 relayer rebates and burn')
  .requiredOption('-s, --start-block <number>', 'first Polygon block (inclusive)', positive('--start-block'))
  .requiredOption('-e, --end-block <number>', 'last Polygon block (inclusive)', positive('--end-block'))
  .option('-r, --relayers <file>', 'CSV of rebated keys with columns group,address', 'pip82-relayers.csv')
  .option('-o, --output <dir>', 'output directory (overrides OUTPUT_PATH)')
  .option('--cache <dir>', 'cache directory; reruns resume from it', './cache/pip82')
  .option('--rpc <url>', 'Polygon archive RPC supporting debug_getRawHeader (overrides POLYGON_RPC_URL)')
  .option('--rpc-batch <n>', 'JSON-RPC batch size', positive('--rpc-batch'), 100)
  .option('--rpc-concurrency <n>', 'concurrent header batches', positive('--rpc-concurrency'), 8)
  .option('--etherscan-rps <n>', 'Etherscan calls per second', Number, 4)
  .option('--verify-txs <n>', 'txs per key spot-checked against receipts', positive('--verify-txs'), 3)
  .option('--verify-blocks <n>', 'blocks spot-checked against the fee recipient\'s balance', positive('--verify-blocks'), 200)
  .option('--headers-only', 'only fetch and cache block headers', false)
  .action(async (opts: Pip82Options) => {
    try {
      await run(opts);
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.parse();
