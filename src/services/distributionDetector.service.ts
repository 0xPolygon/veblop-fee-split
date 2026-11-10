/**
 * Detects POL outflows (distributions) from the fee Safe by tracing every Safe execution in a block range.
 */

import { ethers } from 'ethers';
import { RpcService } from '../utils/rateLimit';
import { logger } from '../utils/logger';

const SAFE_ABI = ['function VERSION() view returns (string)'];

// A failed Safe transaction can still pay a gas refund, so failures are traced too.
const SAFE_EXECUTION_TOPICS = [
  ethers.id('ExecutionSuccess(bytes32,uint256)'),
  ethers.id('ExecutionFailure(bytes32,uint256)'),
  ethers.id('ExecutionFromModuleSuccess(address)'),
  ethers.id('ExecutionFromModuleFailure(address)'),
];

// DELEGATECALL and STATICCALL frames never move value, even when callTracer reports one.
const VALUE_TRANSFER_TYPES = new Set(['CALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT']);

const LOG_CHUNK_SIZE = 10_000;

/**
 * Subset of a geth callTracer frame used for value accounting
 */
export interface CallFrame {
  type: string;
  from: string;
  to?: string;
  value?: string;
  error?: string;
  calls?: CallFrame[];
}

export interface DetectedOutflow {
  polygonBlock: number;
  transactionHash: string;
  amount: bigint;
}

/**
 * Net POL that left `address` within a traced transaction.
 * Reverted frames are skipped with their whole subtree, since their transfers were rolled back.
 */
export function netOutflowFromTrace(frame: CallFrame, address: string): bigint {
  if (frame.error) {
    return 0n;
  }

  const target = address.toLowerCase();
  let net = 0n;

  if (VALUE_TRANSFER_TYPES.has(frame.type.toUpperCase())) {
    const value = BigInt(frame.value ?? '0x0');
    if (frame.from.toLowerCase() === target) {
      net += value;
    }
    if (frame.to?.toLowerCase() === target) {
      net -= value;
    }
  }

  for (const child of frame.calls ?? []) {
    net += netOutflowFromTrace(child, address);
  }

  return net;
}

export class DistributionDetector {
  constructor(
    private readonly provider: ethers.JsonRpcProvider,
    private readonly rpcService: RpcService
  ) {}

  /**
   * Find every transaction in [fromBlock, toBlock] that moved POL out of the Safe at `safeAddress`.
   */
  async detect(safeAddress: string, fromBlock: number, toBlock: number): Promise<DetectedOutflow[]> {
    await this.assertIsSafe(safeAddress);

    logger.info(`Scanning Safe ${safeAddress} executions in Polygon blocks ${fromBlock}-${toBlock}`);
    const executions = await this.findExecutionTransactions(safeAddress, fromBlock, toBlock);
    logger.info(`Found ${executions.size} Safe execution transaction(s); tracing for POL outflows`);

    const outflows: DetectedOutflow[] = [];
    for (const [transactionHash, polygonBlock] of executions) {
      const amount = await this.traceNetOutflow(transactionHash, safeAddress);
      if (amount === 0n) {
        logger.info(`  Block ${polygonBlock} tx ${transactionHash}: no POL outflow`);
        continue;
      }
      logger.info(`  Block ${polygonBlock} tx ${transactionHash}: ${ethers.formatEther(amount)} POL outflow`);
      outflows.push({ polygonBlock, transactionHash, amount });
    }

    return outflows.sort((a, b) => a.polygonBlock - b.polygonBlock);
  }

  // Native POL can only leave a contract through its own code, so if the fee address
  // isn't a Safe, executions can't be enumerated by event and detection would be incomplete.
  private async assertIsSafe(safeAddress: string): Promise<void> {
    const safe = new ethers.Contract(safeAddress, SAFE_ABI, this.provider);
    try {
      const version: string = await this.rpcService.call(() => safe.VERSION());
      logger.info(`Fee address ${safeAddress} is a Safe (version ${version})`);
    } catch (error) {
      throw new Error(
        `Fee address ${safeAddress} does not look like a Safe (VERSION() failed: ` +
        `${error instanceof Error ? error.message : String(error)}). ` +
        `Automatic distribution detection only supports Safe multisigs.`
      );
    }
  }

  private async findExecutionTransactions(
    safeAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<Map<string, number>> {
    const chunks: Array<[number, number]> = [];
    for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_SIZE) {
      chunks.push([start, Math.min(start + LOG_CHUNK_SIZE - 1, toBlock)]);
    }

    const results = await Promise.all(
      chunks.map(([start, end]) =>
        this.rpcService.call(() =>
          this.provider.getLogs({
            address: safeAddress,
            fromBlock: start,
            toBlock: end,
            topics: [SAFE_EXECUTION_TOPICS],
          })
        )
      )
    );

    // One transaction can emit several execution events (e.g. nested module calls)
    const executions = new Map<string, number>();
    for (const log of results.flat()) {
      executions.set(log.transactionHash, log.blockNumber);
    }
    return executions;
  }

  private async traceNetOutflow(transactionHash: string, safeAddress: string): Promise<bigint> {
    let trace: CallFrame;
    try {
      trace = await this.rpcService.call(() =>
        this.provider.send('debug_traceTransaction', [transactionHash, { tracer: 'callTracer' }])
      );
    } catch (error) {
      throw new Error(
        `Failed to trace Safe transaction ${transactionHash}: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `Automatic distribution detection needs a Polygon RPC that supports debug_traceTransaction.`
      );
    }
    return netOutflowFromTrace(trace, safeAddress);
  }
}
