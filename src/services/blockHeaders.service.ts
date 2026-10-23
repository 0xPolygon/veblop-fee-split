/**
 * Block headers (base fee and gas used) for every block in a range, cached on disk
 *
 * Headers come from debug_getRawHeader (RLP, about 600 bytes per block), because
 * eth_getBlockByNumber carries every transaction hash and is ~40x larger. Base fees are not taken
 * from eth_feeHistory: since Lisovo, block producers set the base fee within ±5% of the parent,
 * and bor's multi-block eth_feeHistory can return CalcBaseFee(parent) in place of the header value.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BatchRpcService } from './batchRpc.service';
import { logger } from '../utils/logger';

const SAVE_INTERVAL_MS = 30_000;

/**
 * [payload start, payload end) of the RLP item at offset i
 */
function rlpItem(b: Buffer, i: number): [number, number] {
  const c = b[i];
  if (c < 0x80) {
    return [i, i + 1];
  }
  if (c < 0xb8 || (c >= 0xc0 && c < 0xf8)) {
    const n = c - (c < 0xc0 ? 0x80 : 0xc0);
    return [i + 1, i + 1 + n];
  }
  const lenOfLen = c - (c < 0xc0 ? 0xb7 : 0xf7);
  const n = b.readUIntBE(i + 1, lenOfLen);
  return [i + 1 + lenOfLen, i + 1 + lenOfLen + n];
}

function toBigInt(b: Buffer): bigint {
  return b.length === 0 ? 0n : BigInt('0x' + b.toString('hex'));
}

/**
 * Number, gas used and base fee from an RLP-encoded header (fields 8, 10 and 15)
 */
export function decodeRawHeader(raw: string): { number: number; gasUsed: bigint; baseFee: bigint } {
  const b = Buffer.from(raw.replace(/^0x/, ''), 'hex');
  let [i, end] = rlpItem(b, 0);
  const fields: Buffer[] = [];
  while (i < end && fields.length < 16) {
    const [s, e] = rlpItem(b, i);
    fields.push(b.subarray(s, e));
    i = e;
  }
  if (fields.length < 16) {
    throw new Error(`header without a base fee: ${raw.slice(0, 80)}…`);
  }
  return { number: Number(toBigInt(fields[8])), gasUsed: toBigInt(fields[10]), baseFee: toBigInt(fields[15]) };
}

/**
 * [base fee, gas used] per block, interleaved. A base fee of 0 marks a block not fetched yet
 * (never a real value post-London); gas used can be 0.
 */
export class BlockHeaderStore {
  private readonly values: BigUint64Array;
  private readonly filePath: string;

  constructor(readonly startBlock: number, readonly endBlock: number, cacheDir: string) {
    this.filePath = path.join(cacheDir, `headers-${startBlock}-${endBlock}.bin`);
    const length = 2 * (endBlock - startBlock + 1);
    this.values = new BigUint64Array(length);
    if (fs.existsSync(this.filePath)) {
      const cached = fs.readFileSync(this.filePath);
      if (cached.length === length * 8) {
        Buffer.from(this.values.buffer).set(cached);
      }
    }
  }

  baseFee(block: number): bigint {
    const value = this.values[2 * (block - this.startBlock)];
    if (value === undefined || value === 0n) {
      throw new Error(`header for block ${block} not fetched`);
    }
    return value;
  }

  gasUsed(block: number): bigint {
    this.baseFee(block);
    return this.values[2 * (block - this.startBlock) + 1];
  }

  /**
   * Gas used and base fees (wei) over the whole range
   */
  networkTotals(): { gasUsed: bigint; baseFeeWei: bigint } {
    let gasUsed = 0n;
    let baseFeeWei = 0n;
    for (let i = 0; i < this.values.length; i += 2) {
      if (this.values[i] === 0n) {
        throw new Error(`header for block ${this.startBlock + i / 2} not fetched`);
      }
      gasUsed += this.values[i + 1];
      baseFeeWei += this.values[i] * this.values[i + 1];
    }
    return { gasUsed, baseFeeWei };
  }

  async fetch(rpc: BatchRpcService, blocksPerJob: number, concurrency: number): Promise<void> {
    const missing: number[] = [];
    for (let i = 0; i < this.values.length; i += 2) {
      if (this.values[i] === 0n) {
        missing.push(this.startBlock + i / 2);
      }
    }
    if (missing.length === 0) {
      return;
    }

    logger.info(`Fetching headers for ${missing.length.toLocaleString()} blocks`);
    const progress = { done: 0, next: 0, started: Date.now(), saved: Date.now() };
    const worker = async () => {
      while (progress.next < missing.length) {
        const blocks = missing.slice(progress.next, progress.next + blocksPerJob);
        progress.next += blocksPerJob;
        try {
          await this.fetchBlocks(rpc, blocks);
        } catch (error) {
          progress.next = missing.length; // stop the other workers
          throw error;
        }
        progress.done += blocks.length;
        this.maybeSave(progress, missing.length);
      }
    };

    try {
      await Promise.all(Array.from({ length: concurrency }, worker));
    } finally {
      // keep whatever was fetched so a rerun only asks for the rest
      this.save();
    }
  }

  private async fetchBlocks(rpc: BatchRpcService, blocks: number[]): Promise<void> {
    const raws = await rpc.callMany<string>(blocks.map(b => ['debug_getRawHeader', ['0x' + b.toString(16)]]));
    raws.forEach((raw, k) => {
      const header = decodeRawHeader(raw);
      if (header.number !== blocks[k]) {
        throw new Error(`debug_getRawHeader returned block ${header.number} for ${blocks[k]}`);
      }
      const i = 2 * (blocks[k] - this.startBlock);
      this.values[i] = header.baseFee;
      this.values[i + 1] = header.gasUsed;
    });
  }

  private maybeSave(progress: { done: number; started: number; saved: number }, total: number): void {
    if (Date.now() - progress.saved < SAVE_INTERVAL_MS) {
      return;
    }
    this.save();
    progress.saved = Date.now();
    const rate = progress.done / ((Date.now() - progress.started) / 1000);
    const etaMin = (total - progress.done) / rate / 60;
    logger.info(`Headers ${progress.done.toLocaleString()}/${total.toLocaleString()} (${rate.toFixed(0)}/s, eta ${etaMin.toFixed(0)} min)`);
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(this.values.buffer));
    fs.renameSync(tmp, this.filePath);
  }
}
