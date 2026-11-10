import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { HeimdallService } from '../src/services/heimdall.service';
import type { HeimdallBlockMapperService } from '../src/services/heimdallBlockMapper.service';
import type { RpcService } from '../src/utils/rateLimit';

const originalPost = axios.post;

afterEach(() => {
  axios.post = originalPost;
});

function serviceReturning(response: { code: number; log?: string; value?: string | null }): HeimdallService {
  axios.post = (async () => ({
    data: { jsonrpc: '2.0', id: 1, result: { response: { height: '100', ...response } } },
  })) as unknown as typeof axios.post;

  // Without an RpcService the query runs directly; rateLimit.ts pulls in ESM-only p-limit, which tsx can't load
  return new HeimdallService('http://heimdall.invalid', undefined as unknown as RpcService, {} as HeimdallBlockMapperService);
}

test('decodes a stored performance score', async () => {
  const value = Buffer.alloc(8);
  value.writeBigUInt64BE(11602206n);
  const service = serviceReturning({ code: 0, log: '', value: value.toString('base64') });

  assert.equal(await service.queryPerformanceScoreAtHeight(16, 100), 11602206n);
});

test('treats a missing key as no score', async () => {
  const service = serviceReturning({ code: 0, log: '', value: null });

  assert.equal(await service.queryPerformanceScoreAtHeight(16, 100), null);
});

test('fails when the node has pruned state at the height', async () => {
  const service = serviceReturning({ code: 0, log: 'version does not exist', value: null });

  await assert.rejects(service.queryPerformanceScoreAtHeight(16, 100), /version does not exist.*pruned state/);
});

test('fails on a non-zero response code', async () => {
  const service = serviceReturning({ code: 18, log: '', value: null });

  await assert.rejects(service.queryPerformanceScoreAtHeight(16, 100), /code 18/);
});
