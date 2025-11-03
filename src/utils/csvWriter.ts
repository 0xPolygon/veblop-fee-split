/**
 * CSV writer utility for generating CSV files
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

export class CsvWriter {
  /**
   * Write data to a CSV file
   *
   * @param filePath - Absolute path to the CSV file
   * @param headers - Column headers
   * @param rows - Data rows (each row is an array of values)
   */
  static write(filePath: string, headers: string[], rows: string[][]): void {
    // Validate inputs
    if (!filePath) {
      throw new Error('CSV file path is required');
    }

    if (!headers || headers.length === 0) {
      throw new Error('CSV headers are required');
    }

    if (!rows) {
      throw new Error('CSV rows are required');
    }

    // Ensure output directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Escape and quote CSV values
    const escapeCsvValue = (value: string): string => {
      // Convert to string and handle null/undefined
      const str = value === null || value === undefined ? '' : String(value);

      // If value contains comma, quote, or newline, wrap in quotes and escape quotes
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }

      return str;
    };

    // Build CSV content
    const csvLines: string[] = [];

    // Add headers
    csvLines.push(headers.map(escapeCsvValue).join(','));

    // Add data rows
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // Validate row length
      if (row.length !== headers.length) {
        throw new Error(
          `Row ${i + 1} has ${row.length} columns but expected ${headers.length} to match headers`
        );
      }

      csvLines.push(row.map(escapeCsvValue).join(','));
    }

    // Write to file
    const csvContent = csvLines.join('\n') + '\n';
    fs.writeFileSync(filePath, csvContent, 'utf-8');

    logger.info(`CSV file written: ${filePath} (${rows.length} rows)`);
  }

  /**
   * Format a BigInt as a decimal string with specified precision
   */
  static formatBigInt(value: bigint, decimals: number = 18): string {
    const str = value.toString();

    if (str.length <= decimals) {
      // Pad with leading zeros
      return '0.' + str.padStart(decimals, '0');
    }

    // Split into integer and decimal parts
    const integerPart = str.slice(0, -decimals);
    const decimalPart = str.slice(-decimals);

    return `${integerPart}.${decimalPart}`;
  }
}
