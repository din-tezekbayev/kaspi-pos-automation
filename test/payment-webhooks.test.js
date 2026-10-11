import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PaymentStore } from '../src/paymentStore.js';
import { deliverWebhook } from '../src/webhookDelivery.js';

const directories = [];
const stores = [];
const temporaryDirectory = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-webhooks-'));
  directories.push(directory);
  return directory;
};
const storeAt = (filename = ':memory:') => {
  const store = new PaymentStore(filename);
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
const hook = { url: 'https://receiver.example/events', secret: 's'.repeat(32), signatureVersion: 2 };
const payload = { event: 'payment.success', paymentId: '1', status: 'Processed',
  correlation_id: 'operation-1', accountId: 'account-1', amount: 5000, timestamp: '2026-10-11T00:00:00Z' };


describe('PaymentStore', () => {
  it('persists tracked payments and stages notifications before removing a payment', () => {
    const filename = path.join(temporaryDirectory(), 'payments.sqlite');
    const store = storeAt(filename);
    store.savePayments([['account-1:1', { paymentId: '1' }]]);
    store.finishPayment('account-1:1', 'payment.success', payload, [hook]);
    assert.equal(store.payments().length, 0);
    const reopened = storeAt(filename);
    const [delivery] = reopened.claimDeliveries();
    assert.equal(delivery.payload.correlation_id, 'operation-1');
    assert.ok(delivery.payload.event_id);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  });

  it('rolls back payment removal if the outbox cannot be written', () => {
    const store = storeAt();
    store.savePayments([['1', { paymentId: '1' }]]);
    store.db.exec("CREATE TRIGGER fail_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
    assert.throws(() => store.finishPayment('1', 'payment.success', payload, [hook]), /disk failure/);
    assert.equal(store.payments().length, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 0);
  });

  it('does not duplicate a final event or reset a delivered callback', () => {
    const store = storeAt();
    store.finishPayment('1', 'payment.success', payload, [hook]);
    const [delivery] = store.claimDeliveries();
    store.deliverySucceeded(delivery.id);
    store.finishPayment('1', 'payment.success', { ...payload, timestamp: 'later' }, [hook]);
    assert.equal(store.claimDeliveries().length, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 1);
  });

  it('recovers delivery after a worker crash and retries non-2xx', async () => {
    const store = storeAt();
    store.finishPayment('1', 'payment.success', payload, [hook]);
    const [delivery] = store.claimDeliveries(1000000);
    assert.equal(store.claimDeliveries(1000001).length, 0);
    assert.equal(store.claimDeliveries(1300001).length, 1);
    await assert.rejects(deliverWebhook(hook, delivery.payload, async () => ({ ok: false, status: 500 })), /HTTP 500/);
    store.deliveryFailed(delivery.id, 'HTTP 500', 1300001);
    assert.equal(store.claimDeliveries(1300002).length, 0);
    const [retry] = store.claimDeliveries(1400000);
    assert.equal(retry.payload.event_id, delivery.payload.event_id);
    assert.equal(retry.attempts, 1);
  });

  it('retains exhausted deliveries and allows account-scoped replay', () => {
    const store = storeAt();
    store.finishPayment('1', 'payment.success', payload, [hook]);
    const [delivery] = store.claimDeliveries();
    for (let i = 0; i < 20; i++) store.deliveryFailed(delivery.id, 'failure');
    const [failed] = store.listDeliveries('account-1');
    assert.equal(failed.status, 'failed');
    assert.equal(store.replayDelivery(delivery.id, 'another-account'), false);
    assert.equal(store.replayDelivery(delivery.id, 'account-1'), true);
    assert.equal(store.claimDeliveries().length, 1);
    assert.equal(JSON.stringify(failed).includes(hook.secret), false);
  });

  it('imports previous JSON files once without losing retries', () => {
    const directory = temporaryDirectory();
    const tracked = path.join(directory, 'tracked.json');
    const retries = path.join(directory, 'retries.json');
    fs.writeFileSync(tracked, JSON.stringify({ 1: { paymentId: '1', sessionHeaders: { profileId: 'account' } } }));
    fs.writeFileSync(retries, JSON.stringify([{ hook, payload }]));
    const store = storeAt();
    store.migrateLegacy(tracked, retries);
    assert.equal(store.payments()[0][0], 'account:1');
    assert.equal(store.claimDeliveries().length, 1);
    store.migrateLegacy(tracked, retries);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 1);
  });

  it('reserves invoice creation durably and never retries an uncertain upstream request', () => {
    const filename = path.join(temporaryDirectory(), 'payments.sqlite');
    const store = storeAt(filename);
    const request = { amount: 5000, phoneNumber: '123' };
    const first = store.reserveInvoice('account', 'key', request);
    assert.equal(first.created, true);
    const reopened = storeAt(filename);
    assert.equal(reopened.reserveInvoice('account', 'key', request).status, 'started');
    assert.equal(reopened.reserveInvoice('account', 'key', { amount: 99 }).conflict, true);
    store.completeInvoice(first.id, { Data: { QrOperationId: 1 } }, 200);
    assert.deepEqual(reopened.reserveInvoice('account', 'key', request).response, { Data: { QrOperationId: 1 } });
    assert.equal(reopened.reserveInvoice('another-account', 'key', request).created, true);
  });
});

describe('Webhook signatures', () => {
  it('signs the timestamp and exact body while keeping event identity stable', async () => {
    let options;
    const event = { ...payload, event_id: 'stable-id' };
    await deliverWebhook(hook, event, async (_url, request) => { options = request; return { ok: true }; }, 2000000);
    const timestamp = options.headers['X-Webhook-Timestamp'];
    const expected = 'sha256=' + crypto.createHmac('sha256', hook.secret).update(`${timestamp}.${options.body}`).digest('hex');
    assert.equal(options.headers['X-Webhook-Signature'], expected);
    assert.equal(options.headers['X-Webhook-Id'], 'stable-id');
  });

  it('preserves body-only signatures for existing consumers', async () => {
    let options;
    await deliverWebhook({ ...hook, signatureVersion: 1 }, payload,
      async (_url, request) => { options = request; return { ok: true }; });
    assert.equal(options.headers['X-Webhook-Signature'], 'sha256=' + crypto.createHmac('sha256', hook.secret).update(options.body).digest('hex'));
  });
});
