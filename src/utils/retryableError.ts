/**
 * Decides which RPC errors are transient, so RpcService retries them.
 */

import axios from 'axios';

export class TimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  // Heimdall calls use axios, which reports HTTP 429 and 5xx as ERR_BAD_REQUEST / ERR_BAD_RESPONSE
  if (axios.isAxiosError(error) && error.response) {
    const status = error.response.status;
    return status === 429 || status >= 500;
  }

  const message = error.message.toLowerCase();

  // Retry on network errors and timeout errors
  if (
    message.includes('timeout') ||
    message.includes('network') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('enotfound') ||
    message.includes('rate limit') ||
    error instanceof TimeoutError
  ) {
    return true;
  }

  // Check for ethers-specific errors
  if ('code' in error) {
    const code = (error as { code: string }).code;
    return (
      code === 'TIMEOUT' ||
      code === 'NETWORK_ERROR' ||
      code === 'SERVER_ERROR' ||
      code === 'UNKNOWN_ERROR'
    );
  }

  return false;
}
