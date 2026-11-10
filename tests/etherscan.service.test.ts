import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readProgress } from '../src/services/etherscan.service';

function tempFile(contents?: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pip82-')), 'x.progress');
  if (contents !== undefined) {
    fs.writeFileSync(file, contents);
  }
  return file;
}

test('returns null when there is no checkpoint', () => {
  assert.equal(readProgress(tempFile()), null);
});

test('returns the checkpointed block', () => {
  assert.equal(readProgress(tempFile('92000123')), 92000123);
});

test('rejects a corrupt checkpoint', () => {
  assert.throws(() => readProgress(tempFile('')), /Corrupt checkpoint/);
});
