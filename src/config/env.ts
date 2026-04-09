/**
 * Environment configuration and validation
 */

import dotenv from 'dotenv';
import { Config } from '../models/types';
import { ETHEREUM_STAKING_CONTRACT, POLYGON_FEE_CONTRACT } from './contracts';

// Load environment variables
dotenv.config();

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
    blockProducerCommission: parseFloat(process.env.BLOCK_PRODUCER_COMMISSION || '0.26'),
    stakersFeeRate: parseFloat(process.env.STAKERS_FEE_RATE || '0.5'),
    equalityFactor: parseFloat(process.env.EQUALITY_FACTOR || '0.75'),
    outputPath: process.env.OUTPUT_PATH || './output/fee-splits.json',
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

  if (config.blockProducerCommission < 0 || config.blockProducerCommission >= 1) {
    errors.push('BLOCK_PRODUCER_COMMISSION must be between 0 and 1');
  }

  if (config.stakersFeeRate < 0 || config.stakersFeeRate > 1) {
    errors.push('STAKERS_FEE_RATE must be between 0 and 1');
  }

  if (config.equalityFactor < 0 || config.equalityFactor > 1) {
    errors.push('EQUALITY_FACTOR must be between 0 and 1');
  }

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

  return {
    valid: errors.length === 0,
    errors,
  };
}
