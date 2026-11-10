import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { CallFrame, netOutflowFromTrace } from '../src/services/distributionDetector.service';

const SAFE = '0x7Ee41D8A25641000661B1EF5E6AE8A00400466B0';
const SAFE_LOWER = SAFE.toLowerCase();
const EXECUTOR = '0x05466fc96ba8dbb4b0f3f360adfdd7c14e828a5f';
const MULTISEND = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2';
const ALICE = '0x0000000000000000000000000000000000000a11';
const BOB = '0x0000000000000000000000000000000000000b0b';

function wei(pol: string): string {
  return ethers.toQuantity(ethers.parseEther(pol));
}

function execTx(calls: CallFrame[]): CallFrame {
  return { type: 'CALL', from: EXECUTOR, to: SAFE_LOWER, value: '0x0', calls };
}

test('counts a direct transfer plus the gas refund paid to the executor', () => {
  const trace = execTx([
    { type: 'CALL', from: SAFE_LOWER, to: ALICE, value: wei('2217276') },
    { type: 'CALL', from: SAFE_LOWER, to: EXECUTOR, value: wei('0.02') },
  ]);

  assert.equal(netOutflowFromTrace(trace, SAFE), ethers.parseEther('2217276.02'));
});

test('counts multisend transfers but not the value echoed on the delegatecall frame', () => {
  const trace = execTx([
    {
      type: 'DELEGATECALL',
      from: SAFE_LOWER,
      to: MULTISEND,
      value: wei('5'),
      calls: [
        { type: 'CALL', from: SAFE_LOWER, to: ALICE, value: wei('3') },
        { type: 'CALL', from: SAFE_LOWER, to: BOB, value: wei('2') },
      ],
    },
  ]);

  assert.equal(netOutflowFromTrace(trace, SAFE), ethers.parseEther('5'));
});

test('ignores reverted frames and everything beneath them', () => {
  const trace = execTx([
    {
      type: 'CALL',
      from: SAFE_LOWER,
      to: ALICE,
      value: wei('10'),
      error: 'execution reverted',
      calls: [{ type: 'CALL', from: SAFE_LOWER, to: BOB, value: wei('1') }],
    },
    { type: 'CALL', from: SAFE_LOWER, to: EXECUTOR, value: wei('0.01') },
  ]);

  assert.equal(netOutflowFromTrace(trace, SAFE), ethers.parseEther('0.01'));
});

test('nets POL sent back to the Safe within the same transaction', () => {
  const trace = execTx([
    {
      type: 'CALL',
      from: SAFE_LOWER,
      to: ALICE,
      value: wei('10'),
      calls: [{ type: 'CALL', from: ALICE, to: SAFE_LOWER, value: wei('4') }],
    },
  ]);

  assert.equal(netOutflowFromTrace(trace, SAFE), ethers.parseEther('6'));
});

test('returns zero for owner-management calls that move no value', () => {
  const trace = execTx([{ type: 'CALL', from: SAFE_LOWER, to: SAFE_LOWER, value: '0x0' }]);

  assert.equal(netOutflowFromTrace(trace, SAFE), 0n);
});

test('matches the address case-insensitively', () => {
  const trace = execTx([{ type: 'CALL', from: SAFE, to: ALICE, value: wei('1') }]);

  assert.equal(netOutflowFromTrace(trace, SAFE_LOWER), ethers.parseEther('1'));
});
