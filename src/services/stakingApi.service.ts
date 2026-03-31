/**
 * Staking API service for fetching validator metadata from the Polygon Staking API
 */

import axios from 'axios';
import { logger } from '../utils/logger';

const STAKING_API_BASE = 'https://staking-api.polygon.technology/api/v2';

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
   */
  async getValidatorSigners(): Promise<Map<number, string>> {
    const signerMap = new Map<number, string>();
    const limit = 100;
    let offset = 0;
    let total = Infinity;

    logger.info('StakingApi: Fetching validator signer addresses');

    while (offset < total) {
      const url = `${STAKING_API_BASE}/validators?limit=${limit}&offset=${offset}`;
      const response = await axios.get<PaginatedResponse>(url);
      const { summary, result } = response.data;

      total = summary.total;

      for (const validator of result) {
        signerMap.set(validator.id, validator.signer);
      }

      logger.info(`StakingApi: Fetched ${offset + result.length} / ${total} validators`);
      offset += result.length;

      // Safety: if the API returns an empty page before reaching total, stop
      if (result.length === 0) break;
    }

    logger.info(`StakingApi: Loaded signer addresses for ${signerMap.size} validators`);
    return signerMap;
  }
}
