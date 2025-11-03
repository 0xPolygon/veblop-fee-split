/**
 * Heimdall service for fetching validator performance scores
 */

import axios, { AxiosInstance } from 'axios';
import { ValidatorPerformance, HeimdallPerformanceResponse } from '../models/types';
import { logger } from '../utils/logger';

export class HeimdallService {
  private client: AxiosInstance;
  private apiUrl: string;

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl;
    this.client = axios.create({
      timeout: 30000, // 30 second timeout
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Fetch validator performance scores from Heimdall API
   */
  async getValidatorPerformance(): Promise<Map<number, ValidatorPerformance>> {
    logger.info('Fetching validator performance scores from Heimdall API');

    try {
      const response = await this.client.get<HeimdallPerformanceResponse>(this.apiUrl);

      if (!response.data || !response.data.validator_performance_score) {
        throw new Error('Invalid response format from Heimdall API');
      }

      const performanceMap = this.parsePerformanceData(
        response.data.validator_performance_score
      );

      logger.info(`Retrieved performance scores for ${performanceMap.size} validators`);

      return performanceMap;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.error('Failed to fetch validator performance from Heimdall API', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          message: error.message,
        });

        if (error.response?.status === 404) {
          throw new Error('Heimdall API endpoint not found. Please check the API URL.');
        }

        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
          throw new Error(
            'Unable to connect to Heimdall API. Please check your internet connection and try again.'
          );
        }
      }

      throw error;
    }
  }

  /**
   * Parse performance data from API response
   * Converts string scores to numbers and normalizes to 0-1 range
   * The best performing validator gets 1.0, all others are relative to that
   *
   * IMPORTANT: Fails if any validator data is invalid to ensure data integrity
   */
  private parsePerformanceData(
    data: Record<string, string>
  ): Map<number, ValidatorPerformance> {
    if (!data || Object.keys(data).length === 0) {
      throw new Error('No validator performance data received from Heimdall API');
    }

    // First pass: parse all raw scores and find the maximum
    const rawScores: Array<{ validatorId: number; rawScore: number }> = [];
    let maxScore = 0;

    for (const [validatorIdStr, rawScoreStr] of Object.entries(data)) {
      const validatorId = parseInt(validatorIdStr, 10);
      const rawScore = parseInt(rawScoreStr, 10);

      if (isNaN(validatorId)) {
        throw new Error(
          `Invalid validator ID from Heimdall API: "${validatorIdStr}". ` +
          `Expected numeric value. This indicates corrupted API data.`
        );
      }

      if (isNaN(rawScore)) {
        throw new Error(
          `Invalid performance score from Heimdall API for validator ${validatorId}: "${rawScoreStr}". ` +
          `Expected numeric value. This indicates corrupted API data.`
        );
      }

      if (rawScore < 0) {
        throw new Error(
          `Negative performance score for validator ${validatorId}: ${rawScore}. ` +
          `This indicates invalid data from Heimdall API.`
        );
      }

      rawScores.push({ validatorId, rawScore });
      if (rawScore > maxScore) {
        maxScore = rawScore;
      }
    }

    if (maxScore === 0) {
      throw new Error(
        'All validator performance scores are 0. This indicates a problem with ' +
        'the Heimdall API or network state. Cannot proceed with fee calculation.'
      );
    }

    logger.info(`Maximum validator performance score: ${maxScore}`);
    logger.info(`Parsed ${rawScores.length} validator performance scores`);

    // Second pass: normalize all scores relative to the maximum
    const map = new Map<number, ValidatorPerformance>();

    for (const { validatorId, rawScore } of rawScores) {
      const normalizedScore = rawScore / maxScore;

      map.set(validatorId, {
        validatorId,
        rawScore,
        normalizedScore,
      });

      logger.debug(
        `Validator ${validatorId}: raw=${rawScore}, normalized=${normalizedScore.toFixed(6)}`
      );
    }

    return map;
  }

  /**
   * Get performance score for a specific validator
   */
  async getValidatorScore(validatorId: number): Promise<ValidatorPerformance | null> {
    const allScores = await this.getValidatorPerformance();
    return allScores.get(validatorId) || null;
  }

  /**
   * Get performance statistics
   */
  async getPerformanceStats(): Promise<{
    totalValidators: number;
    averageScore: number;
    medianScore: number;
    minScore: number;
    maxScore: number;
  }> {
    const performanceMap = await this.getValidatorPerformance();
    const scores = Array.from(performanceMap.values()).map((v) => v.normalizedScore);

    if (scores.length === 0) {
      return {
        totalValidators: 0,
        averageScore: 0,
        medianScore: 0,
        minScore: 0,
        maxScore: 0,
      };
    }

    // Sort for median calculation
    const sortedScores = [...scores].sort((a, b) => a - b);
    const medianIndex = Math.floor(sortedScores.length / 2);

    return {
      totalValidators: scores.length,
      averageScore: scores.reduce((sum, s) => sum + s, 0) / scores.length,
      medianScore: sortedScores[medianIndex],
      minScore: Math.min(...scores),
      maxScore: Math.max(...scores),
    };
  }
}
