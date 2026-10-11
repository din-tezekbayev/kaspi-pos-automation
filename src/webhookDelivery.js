import crypto from 'node:crypto';
import fetch from 'node-fetch';

/** Stable event ID; fresh signed delivery timestamp for every attempt. */
export const deliverWebhook = async (hook, payload, fetcher = fetch, now = Date.now()) => {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(now / 1000));
  // Keep legacy body-only signing for existing consumers. SoftIT opts into v2.
  const signed = hook.signatureVersion === 2 ? `${timestamp}.${body}` : body;
  const signature = 'sha256=' + crypto.createHmac('sha256', hook.secret || '').update(signed).digest('hex');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetcher(hook.url, { method: 'POST', body, signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signature,
        'X-Webhook-Timestamp': timestamp, 'X-Webhook-Id': payload.event_id } });
    if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
};
