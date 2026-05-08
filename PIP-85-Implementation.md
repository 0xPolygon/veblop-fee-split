# PIP-85 Implementation

This repository now applies the PIP-85 adjustment to the original PIP-65 validator fee formula.

## Operational scope
The implementation assumes it is run only for start and end Polygon blocks after the PIP-85 activation block. It does not enforce the activation block in code and does not split a range that crosses activation. If a mixed pre/post-activation range is needed in the future, run or implement that as a separate mode.

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

This intentionally excludes validators with zero interval performance from the equal-share denominator. Their would-be share is effectively distributed to validators with positive interval performance. The best-performing validator(s) receive their full equal-base share, while lower-performing validators receive a discounted share.

If the stake-weighted pool is non-zero but no validator with positive stake has positive interval performance, the calculator aborts instead of carrying an unallocated stake-weighted amount into the report.

## Burn amount
The equal pool is not always fully distributed. The undistributed amount is tracked as:

- `equalPoolBurn = equalPool - sum(equalAllocation_v)`
- `equalPoolDistributed = equalPool - equalPoolBurn`

Both the distributed and burn amounts are reported per interval and in the summary JSON output. The burn amount is sent to a burn address downstream, while the distributed amount reconciles the equal-share pool against the validator allocations.

## Performance normalization
PIP-85 refers to performance relative to perfect performance. The current implementation intentionally does **not** derive a theoretical milestone-opportunity count from Heimdall. Instead, it uses:

- `perfectPerformance = max observed performanceDelta in the interval`

So the equal component is normalized relative to the best-performing validator in that interval, not a separately queried theoretical maximum. This is a deliberate implementation choice because the theoretical perfect-performance score is hard to derive reliably.
