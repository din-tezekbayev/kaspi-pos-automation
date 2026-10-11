import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { KASPI_QRPAY_URL } from './config.js';
import { signedQrPayHeaders } from './helpers.js';
import { decryptSecret } from './crypto.js';
import { getWebhooksByEvent } from './webhookStore.js';
import { logger } from './logger.js';
import { PaymentStore } from './paymentStore.js';
import { deliverWebhook } from './webhookDelivery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACKED_FILE = path.join(__dirname, '..', 'tracked-payments.json');

// SQLite commits payment state and callback outbox atomically.
export const paymentStore = new PaymentStore(process.env.PAYMENT_DB_PATH || path.join(__dirname, '..', 'payments.sqlite'));
const trackedPayments = new Map();
const RETRY_FILE = path.join(__dirname, '..', 'webhook-retries.json');
const saveTracked = () => paymentStore.savePayments(trackedPayments);
const loadTracked = () => {
  paymentStore.migrateLegacy(TRACKED_FILE, RETRY_FILE);
  for (const [id, entry] of paymentStore.payments()) trackedPayments.set(id, entry);
};

// ─── Status → event mapping ───

const QR_FINAL_STATUSES = {
  Processed: 'payment.success',
  CancelledByUser: 'payment.failed',
  NotConfirmedByUser: 'payment.failed',
  CancelledByExternalSource: 'payment.failed',
  ProcessingFailed: 'payment.failed',
  Rejected: 'payment.failed',
  InsufficientFunds: 'payment.failed',
  InsufficientFundsError: 'payment.failed',
  Error: 'payment.failed',
  IrisSrcBlockCode1: 'payment.failed',
  IrisSrcBlockCode3: 'payment.failed',
  IrisSrcBlockCode9: 'payment.failed',
  IrisDestBlockCode3: 'payment.failed',
  IrisDestBlockCode5: 'payment.failed',
  IrisDestBlockCode7: 'payment.failed',
  IrisDestBlockCode10: 'payment.failed',
  QrTokenDiscarded: 'payment.expired',
  Expired: 'payment.expired',
};

const INVOICE_FINAL_STATUSES = {
  Processed: 'payment.success',
  RemotePaymentCanceled: 'payment.failed',
  RemotePaymentRejected: 'payment.failed',
  Expired: 'payment.expired',
};

const QR_INTERMEDIATE = new Set(['QrTokenCreated', 'Wait']);
const INVOICE_INTERMEDIATE = new Set(['RemotePaymentCreated']);

// ─── Track a payment ───

export const trackPayment = (paymentId, type, sessionHeaders, meta = {}) => {
  trackedPayments.set(`${sessionHeaders.profileId || ''}:${paymentId}`, {
    paymentId: String(paymentId),
    type,
    status: type === 'qr' ? 'QrTokenCreated' : 'RemotePaymentCreated',
    sessionHeaders,
    meta,
    createdAt: Date.now(),
    retryCount: 0,
  });
  saveTracked();
  logger.info('POLLING', `Tracking ${type} payment ${paymentId}`);
};

// ─── Fetch status from Kaspi (quiet — no loggedFetch) ───

const fetchStatus = async (entry) => {
  const { paymentId, type, sessionHeaders } = entry;

  let decryptedSecret;
  try {
    decryptedSecret = decryptSecret(sessionHeaders.vtokenSecret);
  } catch {
    logger.error('POLLING', `Failed to decrypt session for payment ${paymentId} — session may have expired`);
    return { error: 'session_expired' };
  }

  const session = {
    tokenSN: sessionHeaders.tokenSN,
    decryptedSecret,
    profileId: sessionHeaders.profileId,
  };

  let url;
  if (type === 'qr') {
    url = `${KASPI_QRPAY_URL}/v02/kaspi-qr/status?qrOperationId=${paymentId}`;
  } else {
    url = `${KASPI_QRPAY_URL}/v02/remote/details?operationId=${paymentId}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url, {
      headers: signedQrPayHeaders(url, session),
      signal: controller.signal,
    });
    return await resp.json();
  } catch (err) {
    logger.error('POLLING', `Error fetching status for ${paymentId}:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
};

// Events are durable before the first HTTP attempt, including every non-2xx.
const finishPayment = (id, event, entry, data) => {
  const payload = buildPayload(event, entry, data);
  paymentStore.finishPayment(id, event, payload, getWebhooksByEvent(event));
  trackedPayments.delete(id);
};

const processRetries = async () => {
  for (const delivery of paymentStore.claimDeliveries()) {
    try {
      await deliverWebhook(delivery.hook, delivery.payload);
      paymentStore.deliverySucceeded(delivery.id);
      logger.info('WEBHOOK', `Delivered event ${delivery.payload.event_id}`);
    } catch (error) {
      paymentStore.deliveryFailed(delivery.id, error.message);
      logger.error('WEBHOOK', `Event ${delivery.payload.event_id} delivery failed: ${error.message}`);
    }
  }
};

const resolveEvent = (type, status) => {
  if (type === 'qr') {
    if (QR_INTERMEDIATE.has(status)) return null;
    return QR_FINAL_STATUSES[status] || 'payment.lost';
  } else {
    if (INVOICE_INTERMEDIATE.has(status)) return null;
    return INVOICE_FINAL_STATUSES[status] || 'payment.lost';
  }
};

// ─── Poll cycle ───

const pollOnce = async () => {
  let changed = false;

  for (const [id, entry] of trackedPayments) {
    // TTL check via expireDate
    if (entry.meta.expireDate) {
      const expiry = new Date(entry.meta.expireDate).getTime();
      if (Date.now() > expiry && resolveEvent(entry.type, entry.status) === null) {
        logger.info('POLLING', `Payment ${id} expired (TTL)`);
        finishPayment(id, 'payment.expired', entry, { Status: 'Expired', StatusDesc: 'Время оплаты истекло' });
        changed = true;
        continue;
      }
    }

    const result = await fetchStatus(entry);

    // Handle session expiration
    if (result && result.error === 'session_expired') {
      entry.retryCount++;
      if (entry.retryCount > 3) {
        logger.warn('POLLING', `Payment ${id} — session expired, sending session.expired webhook`);
        finishPayment(id, 'payment.lost', entry, { Status: 'SessionExpired' });
        changed = true;
      }
      continue;
    }

    if (!result || !result.Data) {
      // Kaspi returns StatusCode -101001 when session was evicted (login from another device)
      if (result && result.StatusCode === -101001) {
        logger.warn('POLLING', `Payment ${id} — session evicted (StatusCode -101001)`);
        finishPayment(id, 'payment.lost', entry, { Status: 'SessionExpired' });
        changed = true;
        continue;
      }

      entry.retryCount++;
      if (entry.retryCount > 10) {
        logger.warn('POLLING', `Removing payment ${id} after 10 failed attempts`);
        finishPayment(id, 'payment.lost', entry, { Status: 'PollingFailed' });
        changed = true;
      }
      continue;
    }

    // Reset retry count on successful fetch
    entry.retryCount = 0;

    const newStatus = result.Data.Status;
    if (newStatus === entry.status) continue;

    logger.info('POLLING', `Payment ${id}: ${entry.status} → ${newStatus}`);
    changed = true;

    const event = resolveEvent(entry.type, newStatus);
    if (event) {
      finishPayment(id, event, entry, result.Data);
    } else {
      entry.status = newStatus;
    }
  }

  if (changed) {
    saveTracked();
  }
};

const buildPayload = (event, entry, data) => ({
  event,
  paymentId: entry.paymentId,
  correlation_id: entry.meta.correlationId || null,
  accountId: entry.sessionHeaders.profileId || null,
  type: entry.type,
  status: data.Status || entry.status,
  statusDesc: data.StatusDesc || '',
  amount: data.Amount ?? entry.meta.amount ?? null,
  qrToken: entry.meta.qrToken || null,
  receiptUrl: entry.meta.receiptUrl || data.ReceiptUrl || null,
  orderNumber: entry.meta.orderNumber || data.OrderNumber || null,
  data,
  timestamp: new Date().toISOString(),
});

// ─── Polling loop (setTimeout-based, no overlap) ───

let pollActive = false;
let pollTimer = null;
const POLL_MS = 3000;

const scheduleNext = () => {
  if (!pollActive) return;
  pollTimer = setTimeout(async () => {
    try {
      if (trackedPayments.size > 0) {
        await pollOnce();
      }
      // Process pending webhook retries
      await processRetries();
    } catch (err) {
      logger.error('POLLING', 'Unexpected error:', err.message);
    }
    scheduleNext();
  }, POLL_MS);
};

export const startPolling = () => {
  if (pollActive) return;

  // Load persisted state
  loadTracked();

  pollActive = true;
  scheduleNext();
  logger.info('POLLING', 'Started (interval: 3s, persistence: enabled)');
};

export const stopPolling = () => {
  pollActive = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  saveTracked();
  logger.info('POLLING', 'Stopped');
};

export const getTrackedPayments = () => Object.fromEntries(trackedPayments);
