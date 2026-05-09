/**
 * Environment configuration and validation
 */

import dotenv from 'dotenv';
import { Config } from '../models/types';
import { ETHEREUM_STAKING_CONTRACT, POLYGON_FEE_CONTRACT } from './contracts';

// Load environment variables
dotenv.config();

function parseNumberEnv(name: string, defaultValue: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === '') {
    return defaultValue;
  }

  const trimmedValue = rawValue.trim();
  if (trimmedValue === '') {
    return NaN;
  }

  return Number(trimmedValue);
}

function validateFraction(
  name: string,
  value: number,
  allowOne: boolean,
  errors: string[]
): void {
  const aboveUpperBound = allowOne ? value > 1 : value >= 1;
  if (!Number.isFinite(value) || value < 0 || aboveUpperBound) {
    const range = allowOne ? 'between 0 and 1 inclusive' : 'greater than or equal to 0 and less than 1';
    errors.push(`${name} must be a finite number ${range}`);
  }
}

/**
 * Get and validate environment configuration
 */
export function getConfig(): Config {
  // Validate required env vars before processing
  const errors: string[] = [];

  const heimdallRpcUrlEnv = process.env.HEIMDALL_RPC_URL || '';
  if (!heimdallRpcUrlEnv) {
    errors.push('HEIMDALL_RPC_URL is required');
  }

  const config: Config = {
    ethereumRpcUrl: process.env.ETHEREUM_RPC_URL || '',
    polygonRpcUrl: process.env.POLYGON_RPC_URL || '',
    heimdallRpcUrl: heimdallRpcUrlEnv,
    ethereumStakingContract: ETHEREUM_STAKING_CONTRACT,
    polygonFeeContract: POLYGON_FEE_CONTRACT,
    blockProducerCommission: parseNumberEnv('BLOCK_PRODUCER_COMMISSION', 0.26),
    stakersFeeRate: parseNumberEnv('STAKERS_FEE_RATE', 0.5),
    equalityFactor: parseNumberEnv('EQUALITY_FACTOR', 0.75),
    outputPath: process.env.OUTPUT_PATH || './output/',
    maxConcurrentRequests: parseInt(process.env.MAX_CONCURRENT_REQUESTS || '3', 10),
    requestDelayMs: parseInt(process.env.REQUEST_DELAY_MS || '200', 10),
    requestTimeoutMs: process.env.REQUEST_TIMEOUT_MS ? parseInt(process.env.REQUEST_TIMEOUT_MS, 10) : undefined,
    maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
  };

  // Validate remaining required fields
  if (!config.ethereumRpcUrl) {
    errors.push('ETHEREUM_RPC_URL is required');
  }

  if (!config.polygonRpcUrl) {
    errors.push('POLYGON_RPC_URL is required');
  }

  validateFraction('BLOCK_PRODUCER_COMMISSION', config.blockProducerCommission, false, errors);
  validateFraction('STAKERS_FEE_RATE', config.stakersFeeRate, true, errors);
  validateFraction('EQUALITY_FACTOR', config.equalityFactor, true, errors);

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }

  return config;
}

/**
 * Validate configuration without throwing
 */
export function validateConfig(config: Config): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.ethereumRpcUrl) {
    errors.push('ETHEREUM_RPC_URL is required');
  }

  if (!config.polygonRpcUrl) {
    errors.push('POLYGON_RPC_URL is required');
  }

  validateFraction('BLOCK_PRODUCER_COMMISSION', config.blockProducerCommission, false, errors);
  validateFraction('STAKERS_FEE_RATE', config.stakersFeeRate, true, errors);
  validateFraction('EQUALITY_FACTOR', config.equalityFactor, true, errors);

  return {
    valid: errors.length === 0,
    errors,
  };
}
