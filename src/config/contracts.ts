/**
 * Contract addresses and ABIs
 */

/**
 * Ethereum Staking Contract Address
 */
export const ETHEREUM_STAKING_CONTRACT = '0xa59c847bd5ac0172ff4fe912c5d29e5a71a7512b';

/**
 * Polygon PoS Fee Contract Address
 */
export const POLYGON_FEE_CONTRACT = '0x7Ee41D8A25641000661B1EF5E6AE8A00400466B0';

/**
 * Staking Contract ABI
 * Includes StakeUpdate event and validator query methods
 * Note: All three event parameters are indexed!
 */
export const STAKING_CONTRACT_ABI = [
  'event StakeUpdate(uint256 indexed validatorId, uint256 indexed nonce, uint256 indexed newAmount)',
  'function totalValidatorStake(uint256 validatorId) view returns (uint256)'
];