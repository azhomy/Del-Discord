import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPerson } from '../src/features/history/verify.js';
import { RateLimitError } from '../src/discord/api.js';

const channelId = '123456789012345678';

test('repeated rate limits while closing a temporary DM stop verification and report the open conversation', async t => {
  t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
  const methods = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const method = options.method || 'GET'; methods.push(method);
    if (method === 'POST') return Response.json({ id: channelId });
    if (method === 'DELETE') return Response.json({ retry_after: 0 }, { status: 429 });
    return Response.json({ total_results: 5 });
  });
  await assert.rejects(verifyPerson('close-rate-limit', 'self', 'recipient', '', false), error => {
    assert.match(error.message, /temporarily opened DM.*may remain open/);
    assert.ok(error.cause instanceof RateLimitError);
    return true;
  });
  assert.deepEqual(methods, ['POST', 'GET', 'DELETE', 'DELETE', 'DELETE']);
});

test('a failed HTTP response while closing a temporary DM does not report successful verification', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => options.method === 'POST'
    ? Response.json({ id: channelId }) : options.method === 'DELETE'
      ? new Response(null, { status: 503 }) : Response.json({ total_results: 5 }));
  await assert.rejects(verifyPerson('close-http-error', 'self', 'recipient', '', false), /temporarily opened DM.*may remain open.*503/);
});

test('successful or already-absent temporary DMs preserve verified counts, and existing DMs are not closed', async t => {
  for (const status of [204, 404]) {
    const methods = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const method = options.method || 'GET'; methods.push(method);
      return method === 'POST' ? Response.json({ id: channelId }) : method === 'DELETE'
        ? new Response(null, { status }) : Response.json({ total_results: 5 });
    });
    assert.deepEqual(await verifyPerson(`close-success-${status}`, 'self', 'recipient', '', false), { count: 5, channelId });
    assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
    methods.length = 0;
    assert.deepEqual(await verifyPerson(`existing-dm-${status}`, 'self', 'recipient', channelId, true), { count: 5, channelId });
    assert.deepEqual(methods, ['GET']);
  }
});

test('failed verification still closes a temporary DM and preserves the original error when closing succeeds', async t => {
  const failure = new Error('Search connection failed'), methods = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const method = options.method || 'GET'; methods.push(method);
    if (method === 'POST') return Response.json({ id: channelId });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    throw failure;
  });
  await assert.rejects(verifyPerson('search-failure-close', 'self', 'recipient', '', false), error => error === failure);
  assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
});
