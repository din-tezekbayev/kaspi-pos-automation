import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.TOKEN_SECRET_KEY = 'a'.repeat(64);
process.env.PAYMENT_DB_PATH = ':memory:';
const { createInvoiceHandler } = await import('../src/routes/invoice.js');
const { PaymentStore } = await import('../src/paymentStore.js');
const { paymentStore } = await import('../src/polling.js');
after(() => paymentStore.close());

const requestFor = (amount = 5000) => ({
  body: { phoneNumber: '77000000000', amount, correlation_id: 'operation-1' },
  headers: { 'x-vtoken-secret': 'test-encrypted-secret' },
  session: { profileId: 'account-1', tokenSN: 'test-token', decryptedSecret: Buffer.alloc(32, 1) },
  get: (name) => name === 'Idempotency-Key' ? 'key-1' : undefined,
});
const response = () => ({
  statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

describe('Invoice creation boundary', () => {
  it('propagates correlation, persists response and never repeats a completed creation', async () => {
    const store = new PaymentStore(':memory:');
    let calls = 0;
    let tracked;
    try {
      const handler = createInvoiceHandler({ store, request: async () => {
        calls++;
        return { status: 200, json: async () => ({ Data: { QrOperationId: 123 } }) };
      }, track: (...args) => { tracked = args; } });
      const first = response();
      await handler(requestFor(), first);
      const second = response();
      await handler(requestFor(), second);
      assert.equal(calls, 1);
      assert.equal(tracked[3].correlationId, 'operation-1');
      assert.equal(tracked[3].amount, 5000);
      assert.deepEqual(second.body, first.body);
      const conflict = response();
      await handler(requestFor(99), conflict);
      assert.equal(conflict.statusCode, 409);
      assert.equal(calls, 1);
    } finally { store.close(); }
  });

  it('does not retry a creation whose upstream result is unknown', async () => {
    const store = new PaymentStore(':memory:');
    let calls = 0;
    try {
      const handler = createInvoiceHandler({ store, request: async () => {
        calls++;
        throw new Error('Connection lost after upstream accepted invoice');
      }, track: () => assert.fail('Must not track without a response') });
      await handler(requestFor(), response());
      const retry = response();
      await handler(requestFor(), retry);
      assert.equal(retry.statusCode, 409);
      assert.equal(calls, 1);
    } finally { store.close(); }
  });

  it('preserves an upstream HTTP error and does not interpret it as a created invoice', async () => {
    const store = new PaymentStore(':memory:');
    try {
      const handler = createInvoiceHandler({ store,
        request: async () => ({ status: 503, json: async () => ({ error: 'Unavailable' }) }),
        track: () => assert.fail('No invoice ID') });
      const result = response();
      await handler(requestFor(), result);
      assert.equal(result.statusCode, 503);
      assert.deepEqual(result.body, { error: 'Unavailable' });
    } finally { store.close(); }
  });
});
