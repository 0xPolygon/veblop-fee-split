/**
 * PIP-82 base-fee rebate constants (Polygon PoS mainnet)
 */

/**
 * Bor's BurntContract switches to PIP82_FEE_RECIPIENT at this block, so from here on every
 * transaction's gasUsed × baseFee accrues to it instead of the burn collector.
 */
export const PIP82_BLOCK = 83_756_500;

export const PIP82_FEE_RECIPIENT = '0x3ef57def668054dd750bd260526105c4eeef104f';

/**
 * Base fees that are not rebated go on to the burn collector.
 */
export const PIP82_BURN_COLLECTOR = '0x7A8ed27F4C30512326878652d20fC85727401854';

/**
 * The payout at block 89,413,444 settled blocks 85,530,000–88,560,000, but its burn was the fee
 * recipient's whole balance as read a few hours after that range ended, minus the rebates. So it
 * also paid out base fees from blocks 88,560,001 onwards. The range starting at 88,560,001 burns
 * that much less; from then on each range settles exactly its own blocks.
 *
 * overpaidWei = (everything sent out of the fee recipient at payoutBlock) − (its balance at
 * lastBlock), and is re-checked on-chain whenever it is applied.
 */
export const PIP82_PRIOR_SETTLEMENT = {
  lastBlock: 88_560_000,
  payoutBlock: 89_413_444,
  overpaidWei: 31_063_098_046_802_557_487_921n,
};
