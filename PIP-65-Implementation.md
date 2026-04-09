# PIP-65 Implementation Review

## Scope
This note documents how the current codebase implements the validator-fee side of [PIP-65](https://forum.polygon.technology/t/pip-65-economic-model-for-veblop-architecture/20933) and where the implementation makes assumptions beyond the proposal.

PIP-65 defines the validator pool for a period as:

- `Pool_validators = T * (1 - C)`
- `Rv = (Sv * Pv / sum(Sv * Pv)) * Pool_validators`

Where `Sv` is validator stake and `Pv` is performance. The current code applies that formula interval by interval rather than once per whole checkpoint period.

## Current End-to-End Flow
The main pipeline is in `src/index.ts`.

1. Read the start and end Polygon PoS blocks and their timestamps.
2. Map each Polygon timestamp to the latest Ethereum block with `timestamp <= target`.
3. Query validator stake state at the start Ethereum block.
4. Query the Polygon fee contract balance at the start and end Polygon blocks.
5. Query Ethereum `StakeUpdate` and `Staked` events strictly inside the Ethereum block range.
6. Build interval boundaries from stake-update timestamps plus the final Ethereum timestamp.
7. For each boundary timestamp:
   - map the Ethereum timestamp to the smallest Polygon block with `timestamp >= target`
   - read the fee-contract balance there
   - map the same timestamp to the smallest Heimdall block with `timestamp >= target`
   - read Heimdall performance counters for all relevant validators
8. For each interval, allocate the fee delta using stake at interval start and Heimdall performance delta across the interval.
9. Sum interval allocations and write a detailed report plus a transfer file.

## Chain-Specific Semantics
### Ethereum
- Stake is queried with `totalValidatorStake(validatorId, { blockTag })`.
- The initial state comes from the latest Ethereum block at or before the Polygon start timestamp.
- Stake updates are applied only after the interval ending at that event timestamp is allocated, so each update affects the next interval.

### Polygon PoS
- Fee snapshots use historical native balance reads on the fee contract.
- Manual withdrawals already executed from the fee wallet are added back from `distributions.json` so the reconstructed pool is monotonic.
- The final interval is forced to use the exact user-provided end Polygon block.

### Heimdall
- Performance is read directly from Bor module state via Tendermint `abci_query`.
- The code uses the raw performance counter delta between consecutive snapshots as `Pv`.
- This is equivalent to using a normalized participation ratio only if all validators share the same opportunity set for the interval.

## Calculator Behavior
`src/calculators/feeSplit.calculator.ts`:

- Calculates `feeDelta = feeSnapshot[end] - feeSnapshot[start]`
- Applies commission once per interval to get `validatorPool`
- Computes `weightedStake_v = stakeAtStart_v * performanceDelta_v`
- Allocates `validatorPool * weightedStake_v / totalWeightedStake`
- Floors division to wei, leaving any remainder undistributed

This is internally consistent with the PIP-65 validator formula, but it is an implementation inference: PIP-65 specifies the reward formula for a period, while this repository decomposes the period into stake-change intervals and assumes fee accumulation and performance should be sliced on the same boundaries.

## Review Findings
### High risk: initial validator set is capped to IDs 1..200
`src/index.ts` seeds initial stake discovery with a hardcoded range of 200 validator IDs. Any validator with stake at the analysis start but an ID above 200 is omitted unless it later appears in a stake-update event. That shrinks the denominator of `sum(Sv * Pv)` and can overpay included validators.

### High risk: boundary timestamps are snapped forward on Polygon and Heimdall
`src/services/blockMapper.service.ts` and `src/services/heimdallBlockMapper.service.ts` map to the smallest block with `timestamp >= target`. That means the “interval end” snapshot can include fee accrual or milestone increments that happened after the Ethereum stake-update timestamp. Because stake updates are applied only after allocation, some post-update activity may be assigned to the pre-update stake distribution.

### Medium risk: leftover wei remains undistributed
`src/calculators/feeSplit.calculator.ts` uses integer division per validator and never assigns the remainder. The validation script explicitly tolerates this. Totals stay close, but the transfer file can be smaller than the theoretical validator pool by up to roughly one wei per rewarded validator per interval.

### Medium risk: `Pv` is implemented as raw Heimdall counter delta
PIP-65 describes `Pv` as a performance score in `[0,1]`. The implementation uses raw milestone-count deltas. This is mathematically fine if each validator has the same number of possible milestones in the interval, because the common denominator cancels. If opportunity sets differ, the current approach is not equivalent to the PIP wording.

## Recommended Follow-Up
- Replace the hardcoded validator discovery range with authoritative validator enumeration.
- Decide and document the intended cross-chain boundary rule: nearest-before, nearest-after, or explicit reconciliation logic.
- Decide whether remainder wei should be assigned deterministically.
- Confirm with protocol owners whether raw milestone deltas are the intended `Pv` for production accounting.
