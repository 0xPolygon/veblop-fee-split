/**
 * JSON-RPC client that sends calls in batches, for bulk header and balance reads
 */

import axios from 'axios';
import pRetry, { AbortError } from 'p-retry';
import { logger } from '../utils/logger';

export type RpcCall = [method: string, params: unknown[]];

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 12;

export class BatchRpcService {
  constructor(
    private readonly url: string,
    private readonly batchSize: number
  ) {}

  /**
   * Results in call order. A batch is retried as a whole if any call in it fails.
   */
  async callMany<T = unknown>(calls: RpcCall[]): Promise<T[]> {
    const results: T[] = [];
    for (let i = 0; i < calls.length; i += this.batchSize) {
      const chunk = calls.slice(i, i + this.batchSize);
      results.push(...(await pRetry(() => this.post<T>(chunk), {
        retries: MAX_RETRIES,
        minTimeout: 500,
        maxTimeout: 30_000,
        onFailedAttempt: (error) => {
          logger.warn(`RPC batch failed (${error.retriesLeft} retries left): ${error.message}`);
        },
      })));
    }
    return results;
  }

  async call<T = unknown>(method: string, params: unknown[]): Promise<T> {
    return (await this.callMany<T>([[method, params]]))[0];
  }

  private async post<T>(chunk: RpcCall[]): Promise<T[]> {
    const payload = chunk.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }));
    const { data } = await axios.post(this.url, payload, { timeout: REQUEST_TIMEOUT_MS });
    if (!Array.isArray(data)) {
      throw new Error(`batch rejected: ${JSON.stringify(data).slice(0, 200)}`);
    }

    const byId = new Map<number, RpcResponse>((data as RpcResponse[]).map(r => [r.id, r]));
    const failed = (data as RpcResponse[]).find(r => r.error);
    if (failed) {
      const message = `${chunk[failed.id]?.[0]}: ${failed.error!.message}`;
      // method not found: retrying won't help
      if (failed.error!.code === -32601) {
        throw new AbortError(message);
      }
      throw new Error(message);
    }
    if (byId.size !== chunk.length) {
      throw new Error(`short batch response: ${byId.size} of ${chunk.length}`);
    }
    return chunk.map((_, id) => byId.get(id)!.result as T);
  }
}
