# Polygon PoS Validator Fee Split Calculator

A Node.js application that calculates the distribution of transaction fees across Polygon PoS validators based on their stake and performance, following the [PIP-65 economic model](https://forum.polygon.technology/t/pip-65-economic-model-for-veblop-architecture/20933).

## Overview

This tool calculates fee distributions using an **interval-based allocation approach** that accurately tracks how stakes and performance change over time:

1. Given a start and end Polygon block, queries the corresponding (largest block with an equal or earlier timestamp) from Ethereum.
2. Queries `StakeUpdate` events from Ethereum's staking contract within this range (excluding the start and end blocks themselves - the start block is excluded because initial stakes are queried directly at that block; the end block is excluded because any stake updates there would only take effect in the next period, which is out of scope).
3. Creates time intervals between these consecutive stake updates (including the start and end Ethereum timestamps found in 1.)
4. Maps the Ethereum timestamps at the end of each interval to a Polygon block (smallest block with an equal or later timestamp) and queries Polygon fee balances at each of these.
5. Maps the Ethereum timestamps at the end of each interval to a Heimdall block (smallest block with an equal or later timestamp) and queries validator performance scores at each of these.
6. For each interval allocates fees collected during that interval proportionally to validators based on:
   - their stake at the start of the interval
   - their performance during the interval
7. Sums allocations across all intervals to calculate total fees per validator

The calculation uses the PIP-65 formula: `Rv = (Sv × Pv / Σ(Sv × Pv)) × Pool_interval`

Where:
- `Rv` = Validator reward for an interval
- `Sv` = Validator's staked amount at the start of the interval
- `Pv` = Performance score (number of signed milestones) during the interval
- `Pool_interval` = Fees collected during interval × (1 - 0.26) [74% after block producer commission]

## Prerequisites

- Node.js 18+
- npm or yarn
- RPC provider accounts with **archive node access** for Polygon (required for historical balance queries)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd veblop_fee_split
```

2. Install dependencies:
```bash
npm install
```

3. Create your `.env` file:
```bash
cp .env.example .env
```

**Important:** Make sure your RPC providers support archive node queries. Without archive access, you won't be able to query historical balances.

## Usage

### Basic Usage

Analyze a specific block range:

```bash
npm start -- --start-block 77414656 --end-block 77500000
```

### Small Test Run

Quick test on a small range (643 blocks, ~21 minutes, 106 validators, ~903 POL):

```bash
npm start -- --start-block 77414656 --end-block 77415299
```

This is the recommended test case for verifying the tool works correctly.

### Custom Output Path

Specify a custom output file:

```bash
npm start -- --start-block 77414656 --end-block 77500000 --output ./results/my-analysis.json
```

## CLI Options

- `-s, --start-block <number>` - Starting Polygon block number (required)
- `-e, --end-block <number>` - Ending Polygon block number (required)
- `-o, --output <path>` - Output JSON file path (default: ./output/fee-splits.json)
- `-h, --help` - Display help information
- `-V, --version` - Display version number

**Note:** Both `--start-block` and `--end-block` are required. Block 77414656 is the VEBloP fork activation block.

## Output Files

The tool generates two JSON files in the output directory (default: `./output/`):

### 1. Detailed Report (`fee-splits-detailed-{startBlock}-{endBlock}-{timestamp}.json`)

A comprehensive interval-by-interval breakdown containing:
- **Metadata**: Block range, timestamps, commission rate, generation time
- **Summary**: Total fees collected, validator pool, validator count
- **Intervals**: For each staking interval:
  - Interval number and timestamps (start/end)
  - Ethereum block at interval start (used for stake queries)
  - Polygon and Heimdall blocks at interval end (used for fee and performance queries)
  - Fees collected and validator pool for the interval
  - Per-validator data:
    - Stake amount at interval start (POL)
    - Performance delta (milestone count)
    - Fees allocated for this interval (POL)

**Example structure:**
```json
{
  "metadata": {
    "startPolygonBlock": 77414656,
    "endPolygonBlock": 77415299,
    "startTimestamp": 1234567890,
    "endTimestamp": 1234568000,
    "blockProducerCommission": 0.26,
    "totalIntervals": 5,
    "generatedAt": "2025-01-15T10:30:00.000Z"
  },
  "summary": {
    "totalFeesCollected": "903.456",
    "totalValidatorPool": "668.557",
    "validatorCount": 106
  },
  "intervals": [
    {
      "intervalNumber": 0,
      "startTimestamp": 1234567890,
      "endTimestamp": 1234567920,
      "ethereumBlockAtStart": 12345678,
      "polygonBlockAtEnd": 77414700,
      "heimdallBlockAtEnd": 56789,
      "feesCollected": "180.691",
      "validatorPoolFees": "133.711",
      "validators": {
        "1": {
          "stakeAtStart": "10000.0",
          "performanceDelta": "5",
          "feesAllocated": "1.234",
        }
      }
    }
  ]
}
```

### 2. Transfer File (`fee-splits-{startBlock}-{endBlock}-{timestamp}.json`)

A simple file for executing transfers containing:
- **Metadata**: Block range, total amount, validator count, commission rate
- **Allocations**: Array of validator ID and amount pairs (sorted by validator ID)

**Example structure:**
```json
{
  "metadata": {
    "startPolygonBlock": 77414656,
    "endPolygonBlock": 77415299,
    "totalAmount": "668.557",
    "validatorCount": 106,
    "blockProducerCommission": 0.26,
    "generatedAt": "2025-01-15T10:30:00.000Z"
  },
  "allocations": [
    {"validatorId": 1, "amount": "6.234"},
    {"validatorId": 2, "amount": "8.567"}
  ]
}
```

**Note:** All POL amounts are formatted as decimal strings for readability (e.g., "123.456" POL).

## Validating Output Files

A validation script is provided to verify the arithmetic accuracy of the output files:

```bash
npm run validate <detailed-report.json> [transfer-file.json]
```

**Examples:**

```bash
# Validate detailed report only
npm run validate ./output/fee-splits-detailed-77414656-77415299-2025-01-15.json

# Validate both detailed report and transfer file
npm run validate ./output/fee-splits-detailed-77414656-77415299-2025-01-15.json ./output/fee-splits-77414656-77415299-2025-01-15.json
```

The validation script checks:
- Sum of fees allocated to validators in each interval matches the interval total
- Sum of fees across all intervals matches the expected total validator pool
- Commission calculation is correct (validator pool = total fees × (1 - commission))
- Final allocations in transfer file match the sum across intervals in detailed report

The script uses precise BigInt arithmetic to avoid floating-point rounding errors and allows for minimal rounding differences (≤1 wei per validator) due to division.

## Exporting Intervals to CSV

For spreadsheet analysis, you can export interval data to CSV files:

```bash
npm run export-csv <detailed-report.json> [output-directory]
```

**Examples:**

```bash
# Export to default location (same directory as report)
npm run export-csv ./output/fee-splits-detailed-77414656-77415299-2025-01-15.json

# Export to custom directory
npm run export-csv ./output/fee-splits-detailed-77414656-77415299-2025-01-15.json ./csv-exports
```

This creates a directory `intervals-{startBlock}-{endBlock}/` containing:

### Interval CSV Files

One file per interval: `interval-000-{startTs}-{endTs}.csv`

Each file has:
- **Header row**: Validator IDs (consistent across all files)
- **Row 1**: Stake at Start (POL)
- **Row 2**: Performance Delta (Milestones)
- **Row 3**: Fees Allocated (POL)

Example:
```csv
Metric,8,9,10,12,16,18,19...
Stake at Start (POL),471158.620,2784166.223,748583.980...
Performance Delta (Milestones),136,136,136,43,133,136...
Fees Allocated (POL),0.019,0.114,0.030,0.052,0.062...
```

### Summary CSV File

`summary-totals.csv` contains cumulative totals for each validator across all intervals:

```csv
Validator ID,Total Fees Allocated (POL)
8,0.095430037634430601
9,0.565732000493765819
10,0.153331236915766667
```

**Note:** All validator IDs are consistent across all interval CSV files, with missing validators shown as `0` for that interval.

## How It Works

### Overview: Interval-Based Allocation

The calculator uses an **interval-based approach** that accurately accounts for stake and performance changes over time. This ensures fair fee distribution that reflects:
1. **Dynamic stake distribution**: Stakes change as validators join, leave, or adjust their stake
2. **Time-weighted allocations**: Validators receive fees proportional to how long they staked
3. **Performance accountability**: Performance scores directly impact fee allocations

### Detailed Calculation Steps

#### 1. Query StakeUpdate Events (Ethereum)

The tool queries the Ethereum staking contract for `StakeUpdate` events, which are emitted whenever a validator's stake changes:
- Validator ID
- New staked amount
- Block number and timestamp
- Transaction hash

These events define the **boundaries of time intervals** where stake distribution remains constant.

#### 2. Create Intervals Between Stake Changes

The timestamps of StakeUpdate events define a series of consecutive intervals:
- **Interval 0**: Period start → First StakeUpdate
- **Interval 1**: First StakeUpdate → Second StakeUpdate
- **Interval 2**: Second StakeUpdate → Third StakeUpdate
- ... and so on
- **Interval <last>**: Last StakeUpdate → Period end

Within each interval, the stake distribution is **constant** (no validators changed their stake).

When multiple validators update their stake in the same Ethereum block, they are grouped together and define a single interval boundary.

#### 3. Map Timestamps to Polygon Blocks and Query Fee Balances

For each interval ending boundary:
1. Map the Ethereum timestamp to a Polygon block number (smallest block with a greater than or equal timestamp) using binary search
2. Query the fee collection contract balance at that Polygon block (requires archive node)
3. The delta between this balance, and the previous balance is the fee delta accrued during the interval.

NB - for the final boundary corresponding to the end of the period, we use the fee balance at the exact end Polygon block supplied.

This gives us the exact fees collected during each interval.

#### 4. Fetch Validator Performance Scores

For each interval ending boundary:
1. Map the Ethereum timestamp to a Heimdall block number (smallest block with a greater than or equal timestamp) using binary search
2. Query Heimdall for validator performance scores at that Heimdall block
3. The delta between these scores, and the scores calculated at the previous boundary are the scores used for this interval.

#### 5. Calculate Interval-Based Fee Allocations

For each interval, fees are allocated using the PIP-65 formula with the stake distribution at the **start of that interval**:

**For a single interval:**
```
1. Calculate validator pool for interval:
   Pool_interval = feeDelta × (1 - 0.26)  [74% after block producer commission]

2. For each validator, calculate performance-weighted stake:
   WeightedStake_v = Stake_v × Performance_v

3. Sum all weighted stakes:
   TotalWeightedStake = Σ(WeightedStake_v)

4. Allocate fees proportionally:
   Allocation_v = (WeightedStake_v / TotalWeightedStake) × Pool_interval
```

**Accumulate across all intervals:**
```
TotalFees_v = Σ(Allocation_v,i) for all intervals i
```

This ensures that:
- Validators receive fees **only for intervals when they had stake**
- Fees are allocated **proportional to stake amount** at each interval
- Performance scores **for the specific interval** weight fees at each interval
- **Time-weighted**: A validator with stake for longer receives more fees

## Technical Details

### Rate Limiting

The tool implements rate limiting to respect RPC provider limits:
- Configurable concurrent requests (default: 3)
- Configurable delay between requests (default: 200ms)
- Configurable timeouts (default: none)
- Automatic retry with exponential backoff

### Error Handling

- Comprehensive error logging to `logs/error.log` and `logs/combined.log`
- Graceful handling of RPC failures
- Validation of configuration and results

### Performance Optimization

- Binary search for block mapping
- Caching of timestamp-to-block mappings
- Batched RPC queries where possible
- Efficient event querying in 5000-block chunks

## Development

### Build and Run

Compile TypeScript to JavaScript:

```bash
npm run build
npm start -- --start-block 77414656 --end-block 77415299
```

### Clean Build

Remove compiled files:

```bash
npm run clean
```

## Configuration Reference

Configuration is done via environment variables in `.env`. Contract addresses are hardcoded as canonical constants.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ETHEREUM_RPC_URL` | Ethereum mainnet RPC URL | Required |
| `POLYGON_RPC_URL` | Polygon PoS RPC URL (archive) | Required |
| `HEIMDALL_RPC_URL` | Heimdall RPC URL | Required |
| `BLOCK_PRODUCER_COMMISSION` | Producer commission rate | `0.26` (26%) |
| `OUTPUT_PATH` | Default output file path | `./output/fee-splits.json` |
| `MAX_CONCURRENT_REQUESTS` | Max concurrent RPC calls | `3` |
| `REQUEST_DELAY_MS` | Delay between requests | `200` |
| `MAX_RETRIES` | Max retry attempts | `3` |
| `REQUEST_TIMEOUT_MS` | RPC Time Out | none |
| `LOG_LEVEL` | Logging level | `info` |

### Hardcoded Contract Addresses

These are canonical contract addresses defined in `src/config/contracts.ts`:

| Contract | Address |
|----------|---------|
| Ethereum Staking Contract | `0xa59c847bd5ac0172ff4fe912c5d29e5a71a7512b` |
| Polygon Fee Collection Contract | `0x7Ee41D8A25641000661B1EF5E6AE8A00400466B0` |

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Resources

- [PIP-65 Economic Model](https://forum.polygon.technology/t/pip-65-economic-model-for-veblop-architecture/20933)
- [Polygon Documentation](https://docs.polygon.technology/)