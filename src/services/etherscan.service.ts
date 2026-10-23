/**
 * Etherscan V2 (chainid 137) transaction lists, cached per address on disk
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import axios from 'axios';
import pRetry, { AbortError } from 'p-retry';
import { logger } from '../utils/logger';

const ETHERSCAN_URL = 'https://api.etherscan.io/v2/api';
// txlist returns at most this many records per query window
const PAGE_SIZE = 10_000;
const TX_FIELDS = ['block', 'nonce', 'gas_used', 'gas_price', 'is_error', 'hash'];

interface EtherscanTx {
  blockNumber: string;
  nonce: string;
  from: string;
  gasUsed: string;
  gasPrice: string;
  isError: string;
  hash: string;
}

export interface SentTx {
  block: number;
  nonce: number;
  gasUsed: bigint;
  // Etherscan's gasPrice is the effective gas price paid
  gasPrice: bigint;
  failed: boolean;
  hash: string;
}

export class EtherscanService {
  private nextSlot = 0;

  constructor(
    private readonly apiKey: string,
    private readonly callsPerSecond: number,
    private readonly cacheDir: string
  ) {}

  /**
   * Writes every transaction sent by address in [startBlock, endBlock] to a cached CSV and
   * returns its path. Resumes from the last completed window after an interruption.
   */
  async fetchSentTxs(address: string, startBlock: number, endBlock: number): Promise<string> {
    const base = path.join(this.cacheDir, 'txs', `${address.toLowerCase()}-${startBlock}-${endBlock}`);
    const dataPath = `${base}.csv`;
    const progressPath = `${base}.progress`;
    if (fs.existsSync(`${base}.done`)) {
      return dataPath;
    }
    fs.mkdirSync(path.dirname(base), { recursive: true });

    let from = fs.existsSync(progressPath) ? parseInt(fs.readFileSync(progressPath, 'utf-8'), 10) : startBlock;
    this.truncateFrom(dataPath, from, from === startBlock);

    for (;;) {
      let txs = await this.txlist(address, from, endBlock);
      const full = txs.length >= PAGE_SIZE;
      let last = 0;
      if (full) {
        last = parseInt(txs[txs.length - 1].blockNumber, 10);
        if (last === from) {
          throw new Error(`${address}: more than ${PAGE_SIZE} transactions in block ${from}`);
        }
        // the last block may be cut off mid-way; refetch it in the next window
        txs = txs.filter(t => parseInt(t.blockNumber, 10) < last);
      }
      const rows = txs
        .filter(t => t.from.toLowerCase() === address.toLowerCase())
        .map(t => [t.blockNumber, t.nonce, t.gasUsed, t.gasPrice, t.isError, t.hash].join(','));
      if (rows.length > 0) {
        fs.appendFileSync(dataPath, rows.join('\n') + '\n');
      }
      if (!full) {
        break;
      }
      from = last;
      fs.writeFileSync(progressPath, String(from));
      logger.info(`  ${address.slice(0, 10)}… +${rows.length} txs, now at block ${from.toLocaleString()}`);
    }

    fs.writeFileSync(`${base}.done`, '');
    fs.rmSync(progressPath, { force: true });
    logger.info(`  ${address.slice(0, 10)}… done`);
    return dataPath;
  }

  /**
   * Starts the cache file afresh, or drops rows past the last checkpoint that a crash
   * mid-append may have left behind.
   */
  private truncateFrom(dataPath: string, from: number, fresh: boolean): void {
    if (fresh) {
      fs.writeFileSync(dataPath, TX_FIELDS.join(',') + '\n');
      return;
    }
    const lines = fs.readFileSync(dataPath, 'utf-8').split('\n').filter(l => l !== '');
    const keep = [lines[0], ...lines.slice(1).filter(l => parseInt(l.split(',')[0], 10) < from)];
    fs.writeFileSync(dataPath, keep.join('\n') + '\n');
  }

  private async txlist(address: string, from: number, to: number): Promise<EtherscanTx[]> {
    const params = {
      chainid: 137, module: 'account', action: 'txlist', address,
      startblock: from, endblock: to, page: 1, offset: PAGE_SIZE, sort: 'asc', apikey: this.apiKey,
    };
    return pRetry(async () => {
      await this.waitForSlot();
      const { data } = await axios.get(ETHERSCAN_URL, { params, timeout: 300_000 });
      if (data.status === '1') {
        return data.result as EtherscanTx[];
      }
      const message = `${data.message} ${typeof data.result === 'string' ? data.result : ''}`;
      if (message.includes('No transactions found')) {
        return [];
      }
      if (/rate limit|timeout|busy/i.test(message)) {
        throw new Error(message);
      }
      throw new AbortError(`Etherscan error for ${address}: ${message}`);
    }, {
      retries: 10,
      minTimeout: 1000,
      maxTimeout: 60_000,
      onFailedAttempt: (error) => {
        logger.warn(`Etherscan ${address.slice(0, 10)}… at block ${from}: ${error.message}; retrying`);
      },
    });
  }

  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + 1000 / this.callsPerSecond;
    await new Promise(resolve => setTimeout(resolve, slot - now));
  }
}

/**
 * Reads back a cache file written by fetchSentTxs
 */
export async function* readSentTxs(dataPath: string): AsyncGenerator<SentTx> {
  const lines = readline.createInterface({ input: fs.createReadStream(dataPath), crlfDelay: Infinity });
  let header = true;
  for await (const line of lines) {
    if (header) {
      header = false;
      continue;
    }
    if (line === '') {
      continue;
    }
    const [block, nonce, gasUsed, gasPrice, isError, hash] = line.split(',');
    yield {
      block: parseInt(block, 10),
      nonce: parseInt(nonce, 10),
      gasUsed: BigInt(gasUsed),
      gasPrice: BigInt(gasPrice),
      failed: isError === '1',
      hash,
    };
  }
}
