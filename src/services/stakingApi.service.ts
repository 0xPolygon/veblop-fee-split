/**
 * Staking API service for fetching validator metadata from the Polygon Staking API
 */

import axios from 'axios';
import pRetry from 'p-retry';
import { logger } from '../utils/logger';

const STAKING_API_BASE = 'https://staking-api.polygon.technology/api/v2';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const MAX_PAGES = 20;

interface ValidatorApiResponse {
  id: number;
  signer: string;
}

interface PaginatedResponse {
  success: boolean;
  summary: {
    limit: number;
    offset: number;
    total: number;
    size: number;
  };
  result: ValidatorApiResponse[];
}

export class StakingApiService {
  /**
   * Fetch all validators from the staking API and return a map of validatorId -> signer address.
   * Handles pagination automatically.
   * Returns an empty map on failure so that the pipeline can still produce output.
   */
  async getValidatorSigners(): Promise<Map<number, string>> {
    try {
      return await this.fetchAllValidators();
    } catch (error) {
      logger.warn(
        'StakingApi: Failed to fetch validator signer addresses after retries. ' +
        'Output files will use "unknown" for signer fields.',
        { error: error instanceof Error ? error.message : String(error) },
      );
      return new Map();
    }
  }

  private async fetchAllValidators(): Promise<Map<number, string>> {
    const signerMap = new Map<number, string>();
    const limit = 100;
    let offset = 0;
    let total = Infinity;
    let pages = 0;

    logger.info('StakingApi: Fetching validator signer addresses');

    while (offset < total && pages < MAX_PAGES) {
      const url = `${STAKING_API_BASE}/validators?limit=${limit}&offset=${offset}`;

      const response = await pRetry(
        () => axios.get<PaginatedResponse>(url, { timeout: REQUEST_TIMEOUT_MS }),
        {
          retries: MAX_RETRIES,
          minTimeout: 1_000,
          factor: 2,
          onFailedAttempt: (err) => {
            logger.warn(
              `StakingApi: Request failed (attempt ${err.attemptNumber}/${MAX_RETRIES + 1}), ` +
              `${err.retriesLeft} retries left`,
              { error: err.message },
            );
          },
        },
      );

      const { summary, result } = response.data;
      total = summary.total;

      for (const validator of result) {
        signerMap.set(validator.id, validator.signer);
      }

      logger.info(`StakingApi: Fetched ${offset + result.length} / ${total} validators`);
      offset += result.length;
      pages++;

      // Safety: if the API returns an empty page before reaching total, stop
      if (result.length === 0) break;
    }

    if (pages >= MAX_PAGES) {
      logger.warn(`StakingApi: Reached max page limit (${MAX_PAGES}), some validators may be missing`);
    }

    logger.info(`StakingApi: Loaded signer addresses for ${signerMap.size} validators`);
    return signerMap;
  }
}
