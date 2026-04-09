# PIP-85 Implementation

This repository now applies the PIP-85 adjustment to the original PIP-65 validator fee formula.

## Interval model
The code still calculates fees interval by interval, where intervals are bounded by Ethereum stake-update timestamps and the final analysis timestamp. For each interval it derives:

- `grossFees`
- `postCommissionPool = grossFees * (1 - C)`
- `stakersPool = postCommissionPool * Sf`
- `validatorsPool = postCommissionPool * (1 - Sf)`
- `stakeWeightedPool = validatorsPool * (1 - Ef)`
- `equalPool = validatorsPool * Ef`

Only the validator side is allocated per validator. The staker pool is currently tracked as an aggregate amount in the report outputs.

## Validator allocation
For the stake-weighted portion, the code keeps the existing performance-weighted stake logic:

- `weightedStake_v = stakeAtStart_v * performanceDelta_v`
- `stakeWeightedAllocation_v = weightedStake_v / sum(weightedStake) * stakeWeightedPool`

For the equal portion:

- `N = number of validators with performanceDelta > 0`
- `perfectPerformance = max(performanceDelta)` across those validators
- `equalBaseShare = equalPool / N`
- `equalAllocation_v = equalBaseShare * performanceDelta_v / perfectPerformance`

This means the best-performing validator(s) receive their full equal-base share, while lower-performing validators receive a discounted share.

## Burn amount
The equal pool is not always fully distributed. The undistributed amount is tracked as:

- `equalPoolBurn = equalPool - sum(equalAllocation_v)`

This amount is reported in the detailed and summary JSON outputs so it can be sent to a burn address downstream.

## Important fallback
PIP-85 refers to performance relative to perfect performance. The current implementation does **not** derive a theoretical milestone-opportunity count from Heimdall. Instead, it uses:

- `perfectPerformance = max observed performanceDelta in the interval`

So the equal component is normalized relative to the best-performing validator in that interval, not a separately queried theoretical maximum.
