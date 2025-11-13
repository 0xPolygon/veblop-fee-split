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
 * Includes StakeUpdate and Staked events and validator query methods
 * Note: StakeUpdate has all three parameters indexed
 * Staked event emitted on initial validator onboarding
 */
export const STAKING_CONTRACT_ABI = [
  'event StakeUpdate(uint256 indexed validatorId, uint256 indexed nonce, uint256 indexed newAmount)',
  'event Staked(address indexed signer, uint256 indexed validatorId, uint256 nonce, uint256 indexed activationEpoch, uint256 amount, uint256 total, bytes signerPubkey)',
  'function totalValidatorStake(uint256 validatorId) view returns (uint256)'
];