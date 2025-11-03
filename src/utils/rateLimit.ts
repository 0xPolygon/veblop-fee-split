/**
 * Rate limiting utilities
 */

import pLimit from 'p-limit';
import pRetry, { AbortError } from 'p-retry';
import { RateLimiterOptions, RetryOptions } from '../models/types';
import { logger } from './logger';

/**
 * Rate limiter class to control concurrent requests and delay between calls
 */
export class RateLimiter {
  private lastRequestTime = 0;
  private limit: ReturnType<typeof pLimit>;

  constructor(private options: RateLimiterOptions) {
    this.limit = pLimit(options.maxConcurrent);
  }

  /**
   * Execute a function with rate limiting
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return this.limit(async () => {
      // Enforce minimum delay between requests
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;

      if (timeSinceLastRequest < this.options.minDelayMs) {
        const delayNeeded = this.options.minDelayMs - timeSinceLastRequest;
        await new Promise(resolve => setTimeout(resolve, delayNeeded));
      }

      this.lastRequestTime = Date.now();
      return fn();
    });
  }
}

/**
 * Retry handler with exponential backoff
 */
export class RetryHandler {
  constructor(private options: RetryOptions) {}

  /**
   * Execute a function with retry logic
   */
  async execute<T>(
    fn: () => Promise<T>,
    customOptions?: Partial<RetryOptions>
  ): Promise<T> {
    const options = { ...this.options, ...customOptions };

    return pRetry(
      async () => {
        try {
          return await fn();
        } catch (error) {
          // Log retry attempts
          if (error instanceof AbortError) {
            throw error;
          }

          // Determine if we should retry
          if (this.shouldRetry(error)) {
            logger.warn('Retrying operation after error', {
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          } else {
            // Don't retry - throw AbortError
            throw new AbortError(error instanceof Error ? error.message : String(error));
          }
        }
      },
      {
        retries: options.maxRetries,
        minTimeout: options.baseDelayMs,
        maxTimeout: options.maxDelayMs,
        factor: 2, // Exponential backoff factor
        onFailedAttempt: (error) => {
          logger.warn(
            `Attempt ${error.attemptNumber} failed. ${error.retriesLeft} retries left.`,
            { error: error.message }
          );
        },
      }
    );
  }

  /**
   * Determine if an error should trigger a retry
   */
  private shouldRetry(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();

    // Retry on network errors
    if (
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('rate limit')
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
}

/**
 * Combined RPC service wrapper with rate limiting and retries
 */
export class RpcService {
  private limiter: RateLimiter;
  private retry: RetryHandler;

  constructor(
    limiterOptions: RateLimiterOptions,
    retryOptions: RetryOptions
  ) {
    this.limiter = new RateLimiter(limiterOptions);
    this.retry = new RetryHandler(retryOptions);
  }

  /**
   * Execute an RPC call with rate limiting and retry logic
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    return this.retry.execute(() => this.limiter.execute(fn));
  }
}
