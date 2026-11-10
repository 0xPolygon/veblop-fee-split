import test from 'node:test';
import assert from 'node:assert/strict';
import { AxiosError, AxiosHeaders, AxiosResponse } from 'axios';
import { isRetryableError, TimeoutError } from '../src/utils/retryableError';

function httpError(status: number): AxiosError {
  const config = { headers: new AxiosHeaders() };
  const response = { status, statusText: '', data: {}, headers: {}, config } as AxiosResponse;
  const code = status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST;
  return new AxiosError(`Request failed with status code ${status}`, code, config, {}, response);
}

test('retries axios HTTP 429 and 5xx responses', () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(isRetryableError(httpError(status)), true, `status ${status}`);
  }
});

test('does not retry other axios HTTP 4xx responses', () => {
  for (const status of [400, 401, 403, 404]) {
    assert.equal(isRetryableError(httpError(status)), false, `status ${status}`);
  }
});

test('retries axios errors that never got a response', () => {
  assert.equal(isRetryableError(new AxiosError('timeout of 10000ms exceeded', AxiosError.ECONNABORTED)), true);
  assert.equal(isRetryableError(new AxiosError('Network Error', AxiosError.ERR_NETWORK)), true);
});

test('retries timeouts and transient ethers errors', () => {
  assert.equal(isRetryableError(new TimeoutError('Operation timed out after 5ms', 5)), true);
  assert.equal(isRetryableError(Object.assign(new Error('server response 503'), { code: 'SERVER_ERROR' })), true);
});

test('does not retry other errors', () => {
  assert.equal(isRetryableError(new Error('execution reverted')), false);
  assert.equal(isRetryableError(Object.assign(new Error('bad'), { code: 'CALL_EXCEPTION' })), false);
  assert.equal(isRetryableError('not an error'), false);
});
