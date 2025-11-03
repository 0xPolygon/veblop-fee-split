# Polygon PoS Validator Fee Split Calculator

A Node.js application that calculates the distribution of transaction fees across Polygon PoS validators based on their stake and performance, following the [PIP-65 economic model](https://forum.polygon.technology/t/pip-65-economic-model-for-veblop-architecture/20933).

## Overview

This tool calculates fee distributions using an **interval-based allocation approach** that accurately tracks how stakes change over time while applying performance scores uniformly across all intervals:

1. Queries `StakeUpdate` events from Ethereum's staking contract to track validator stake changes
2. Creates time intervals between consecutive stake updates (checkpoints)
3. Maps Ethereum timestamps to Polygon blocks and queries fee balances at each checkpoint
4. Fetches validator performance scores from the Heimdall API for the entire period
5. For each interval:
   - Allocates fees collected during that interval proportionally to validators based on their stake at the start of the interval
   - Applies the performance score (from the total period) uniformly across all intervals
6. Sums allocations across all intervals to calculate total fees per validator
7. Validates all calculations and generates multiple output formats

The calculation uses the PIP-65 formula: `Rv = (Sv × Pv / Σ(Sv × Pv)) × Pool_interval`

Where:
- `Rv` = Validator reward for an interval
- `Sv` = Validator's staked amount at the start of the interval
- `Pv` = Performance score (0-1) from the total period
- `Pool_interval` = Fees collected during interval × (1 - 0.26) [74% after block producer commission]

## Prerequisites

- Node.js 18+
- npm or yarn
- RPC provider accounts with **archive node access** for Polygon (required for historical balance queries)
  - Recommended: [Alchemy](https://www.alchemy.com/) or [QuickNode](https://www.quicknode.com/)
  - Archive node access is typically available on paid plans

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd fee_split
```

2. Install dependencies:
```bash
npm install
```

3. Create your `.env` file:
```bash
cp .env.example .env
```

4. Edit `.env` and update your RPC URLs:
```bash
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_API_KEY
```

**Important:** Make sure your Polygon RPC provider supports archive node queries. Without archive access, you won't be able to query historical balances.

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

## Output Format

The tool generates multiple output files for different use cases:

### 1. Distribution CSV (`*-distribution.csv`)

Simple 2-column CSV for executing the fee split distribution:

```csv
Validator ID,Amount (POL)
148,64.887792306167560881
163,57.613414458515842295
142,50.286766752630103318
```

**Purpose:** Direct input for fee distribution transactions.

### 2. Detailed Report JSON (`*-detailed-report.json`)

Comprehensive JSON with all calculation details for transparency and visualization:

```json
{
  "metadata": {
    "generatedAt": "2025-11-02T20:46:08.000Z",
    "polygonBlockRange": {
      "start": 77414656,
      "end": 77415299,
      "startTimestamp": 1759933384,
      "startTimestampISO": "2025-10-08T14:23:04.000Z",
      "endTimestamp": 1759934686,
      "endTimestampISO": "2025-10-08T14:44:46.000Z"
    },
    "ethereumBlockRange": {
      "start": 23533599,
      "end": 23533707
    },
    "feeDistribution": {
      "totalFeesCollected": "903.57690777519055196",
      "blockProducerCommissionRate": 0.26,
      "blockProducerShare": "234.92999602154954351",
      "validatorPoolShare": "668.64691175364100845"
    }
  },
  "intervals": [
    {
      "intervalNumber": 0,
      "startTimestamp": 1759933384,
      "endTimestamp": 1759933655,
      "feeBalance": "179.163419400267768003",
      "feeDelta": "178.561705475178799830",
      "validatorStakes": {
        "1": "35094142818181818181818",
        "18": "247101408359855922364150",
        ...
      }
    }
  ],
  "performanceScores": [
    {
      "validatorId": 148,
      "rawScore": 1072708,
      "normalizedScore": 0.978016
    }
  ],
  "allocations": [
    {
      "validatorId": 148,
      "allocation": "64.887792306167560881",
      "blendedStake": "314846149.344681269851959395",
      "stakeRatio": 0.09128445,
      "performanceScore": 0.978016,
      "performanceWeightedStake": 307924431.763464
    }
  ]
}
```

**Purpose:** Complete audit trail, visualization, and community transparency.

### 3. Validator Allocations CSV (`*-validator-allocations.csv`)

Detailed breakdown for spreadsheet analysis:

```csv
Validator ID,Allocation (POL),Allocation Ratio (%),Blended Stake (POL),Stake Ratio (%),Performance Score (Normalized),Performance Score (Raw),Performance Weighted Stake
148,64.887792,9.704343,314846149.34,9.128445,0.978016,1072708,307924431.76
163,57.613414,8.616418,305093499.29,8.845683,0.896132,982896,273403937.45
```

**Purpose:** Detailed analysis in spreadsheet tools (Excel, Google Sheets).

### 4. Intervals CSV (`*-intervals.csv`)

Time intervals with stake distributions and fee deltas:

```csv
Interval,Start Time,End Time,Start Ethereum Block,End Ethereum Block,Start Polygon Block,End Polygon Block,Fee Balance (POL),Fee Delta (POL)
0,2025-10-08T14:23:04.000Z,2025-10-08T14:29:15.000Z,23533599,23533621,77414656,77414882,179.163419,178.561705
1,2025-10-08T14:29:15.000Z,2025-10-08T14:44:46.000Z,23533621,23533707,77414882,77415299,904.178621,725.015203
```

**Purpose:** Interval-by-interval breakdown showing when stakes changed and fees accrued.

### 5. Performance Scores CSV (`*-performance-scores.csv`)

Validator performance data:

```csv
Validator ID,Raw Score,Normalized Score
148,1072708,0.978016
163,982896,0.896132
```

**Purpose:** Performance score reference for validation.

### 6. Legacy JSON (`*.json`)

Backward-compatible JSON format with all data combined.

**Purpose:** Compatibility with existing tooling.

## Project Structure

```
fee_split/
├── src/
│   ├── config/           # Configuration and contract definitions
│   │   ├── contracts.ts  # Contract addresses and ABIs
│   │   └── env.ts        # Environment variable validation
│   ├── services/         # Blockchain and API services
│   │   ├── ethereum.service.ts    # Query Ethereum staking events
│   │   ├── polygon.service.ts     # Query Polygon fee balances
│   │   ├── heimdall.service.ts    # Fetch validator performance
│   │   └── blockMapper.service.ts # Map timestamps to blocks
│   ├── models/
│   │   └── types.ts      # TypeScript type definitions
│   ├── calculators/
│   │   └── feeSplit.calculator.ts # PIP-65 interval-based fee split logic
│   ├── utils/
│   │   ├── logger.ts     # Winston logging
│   │   ├── rateLimit.ts  # Rate limiting and retry logic
│   │   ├── validation.ts # Output validation utilities
│   │   └── csvWriter.ts  # CSV file generation
│   └── index.ts          # Main CLI entry point
├── tests/
│   └── verify-output.js  # Standalone validation script
├── output/               # Generated output files
├── logs/                 # Application logs
├── .env                  # Your configuration (not committed)
├── .env.example          # Example configuration
├── package.json
├── tsconfig.json
└── README.md
```

## How It Works

### Overview: Interval-Based Allocation with Fixed Performance Scores

The calculator uses an **interval-based approach** that accurately accounts for stake changes over time while applying a uniform performance score across all intervals. This ensures fair fee distribution that reflects:
1. **Dynamic stake distribution**: Stakes change as validators join, leave, or adjust their stake
2. **Time-weighted allocations**: Validators receive fees proportional to how long they staked
3. **Performance accountability**: A single performance score from the total period is applied uniformly

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

Within each interval, the stake distribution is **constant** (no validators changed their stake).

When multiple validators update their stake in the same Ethereum block, they are grouped together and define a single interval boundary.

#### 3. Map Timestamps to Polygon Blocks and Query Fee Balances

For each interval boundary (StakeUpdate timestamp):
1. Map the Ethereum timestamp to a Polygon block number using binary search
2. Query the fee collection contract balance at that Polygon block (requires archive node)
3. Calculate the **feeDelta** for the interval: `balance_end - balance_start`

This gives us the exact fees collected during each interval.

**Important**: When multiple StakeUpdates occur in the same Ethereum block, only the **first fee snapshot** is used (others would have `feeDelta=0` due to balance already being captured).

#### 4. Fetch Validator Performance Scores

The Heimdall API provides performance scores for each validator based on their voting participation and correctness over the entire period:
- Raw scores range from 0 to ~1,000,000
- Scores are normalized to 0-1: `normalized = raw_score / max_score`

**Critical**: These performance scores represent the **entire analysis period** and are applied **uniformly across all intervals**. This means:
- A validator's performance score doesn't change between intervals
- Performance is measured over the total period, not per-interval
- The same performance score is used when calculating allocations for every interval

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
- Performance scores **from the total period** weight all allocations
- **Time-weighted**: A validator with stake for longer receives more fees

#### 6. Calculate Blended Stakes (for reporting)

To provide a single "average stake" value for each validator, a **blended stake** is calculated:

```
BlendedStake_v = Σ(Stake_v,i × Pool_i) / Σ(Pool_i)
```

Where:
- `Stake_v,i` = Validator v's stake in interval i
- `Pool_i` = Validator pool size in interval i
- The sum is across all intervals

This is a **weighted average** where intervals with higher fee collection have more influence, reflecting their importance to the total allocation.

#### 7. Validate Results

The tool automatically validates:
- Sum of fee deltas equals total fees collected
- Balance changes match fee deltas
- Sum of validator allocations equals validator pool (74% of total fees)
- Commission calculations are correct (26% block producer share)

All validations must pass with less than 0.001 POL tolerance.

### Why This Approach?

**Accuracy**: By processing each interval separately with the correct stake distribution, the calculation perfectly accounts for stake changes over time.

**Fairness**: Validators receive fees proportional to their stake during each interval, weighted by their overall performance.

**Transparency**: Every interval is tracked with complete data on stakes, fees, and allocations.

**Simplicity**: Performance scores are measured once for the entire period, avoiding complex per-interval performance tracking.

### Example Scenario

Consider 3 validators over 2 intervals:

**Interval 1** (100 POL collected):
- Validator A: 1000 POL staked, 0.95 performance → receives ~31.67 POL
- Validator B: 1000 POL staked, 0.95 performance → receives ~31.67 POL
- Validator C: 500 POL staked, 0.90 performance → receives ~15.00 POL

**Interval 2** (100 POL collected, Validator A increased stake):
- Validator A: 2000 POL staked, 0.95 performance → receives ~46.51 POL
- Validator B: 1000 POL staked, 0.95 performance → receives ~23.26 POL
- Validator C: 500 POL staked, 0.90 performance → receives ~11.05 POL

**Total Allocations**:
- Validator A: 31.67 + 46.51 = 78.18 POL
- Validator B: 31.67 + 23.26 = 54.93 POL
- Validator C: 15.00 + 11.05 = 26.05 POL

Notice how Validator A receives more total fees because they had higher stake in Interval 2, even though they had the same stake as Validator B in Interval 1.

## Technical Details

### Rate Limiting

The tool implements rate limiting to respect RPC provider limits:
- Configurable concurrent requests (default: 3)
- Configurable delay between requests (default: 200ms)
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

## Troubleshooting

### "Archive node required" Error

**Problem:** Your RPC provider doesn't support historical state queries.

**Solution:** Use a provider with archive node access:
- Alchemy (Growth plan or higher)
- QuickNode (with archive add-on)
- Your own archive node

### Rate Limit Errors

**Problem:** Too many requests to RPC provider.

**Solution:** Adjust rate limiting in `.env`:
```bash
MAX_CONCURRENT_REQUESTS=2
REQUEST_DELAY_MS=500
```

### "No StakeUpdate events found"

**Problem:** No stake changes in the specified block range.

**Solution:** Try a larger block range:
```bash
npm start -- --start-block 77414656 --end-block 78000000
```

### Connection Timeouts

**Problem:** Network issues or slow RPC provider.

**Solution:** The tool will automatically retry. If issues persist:
1. Check your internet connection
2. Try a different RPC provider
3. Increase `MAX_RETRIES` in `.env`

## Output Validation

The tool includes comprehensive validation that runs automatically after each calculation:

### Automatic Validation

After generating output files, the tool validates:
1. **Fee Delta Sum**: Sum of fee deltas across all intervals matches total fees collected
2. **Balance Changes**: Changes in contract balance match fee deltas
3. **Allocation Sum**: Sum of validator allocations equals validator pool (74% of total)
4. **Commission Calculation**: Block producer commission (26%) is calculated correctly

All checks must pass with < 0.001 POL tolerance.

### Manual Validation

You can also validate output files manually:

```bash
npm run test:validate output/fee-splits_2025-11-02_20-46-08.json
```

This is useful for:
- CI/CD pipelines
- Independent verification of results
- Testing new calculation approaches

### Validation Output

```
✓ All validation checks passed
  - Fee deltas sum correctly
  - Balance changes match fee deltas
  - Validator allocations sum correctly
  - Commission calculated correctly
```

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

### Test Validation

Test the validation logic on existing output:

```bash
npm run test:validate output/fee-splits_TIMESTAMP.json
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
- [Heimdall API](https://heimdall-api.polygon.technology/)
- [ethers.js Documentation](https://docs.ethers.org/v6/)
