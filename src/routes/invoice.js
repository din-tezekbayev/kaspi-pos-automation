import { Router } from 'express';
import { KASPI_QRPAY_URL } from '../config.js';
import { loggedFetch, signedQrPayHeaders } from '../helpers.js';
import { decryptSecret } from '../crypto.js';
import { trackPayment, paymentStore } from '../polling.js';

const router = Router();

// Extract session from request headers
const extractSession = (req) => ({
  tokenSN: req.headers['x-token-sn'] || null,
  profileId: req.headers['x-profile-id'] || null,
  vtokenSecret: req.headers['x-vtoken-secret'] || null,
});

const requireAuth = (req, res, next) => {
  const session = extractSession(req);
  if (!session.tokenSN) return res.status(401).json({ error: 'Missing X-Token-SN header.' });
  if (!session.vtokenSecret) return res.status(401).json({ error: 'Missing X-Vtoken-Secret header.' });
  try {
    session.decryptedSecret = decryptSecret(session.vtokenSecret);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired vtokenSecret. Re-authenticate.' });
  }
  req.session = session;
  next();
};

router.use(requireAuth);

// ─── Client info ───

router.get('/client-info', async (req, res) => {
  const { phoneNumber } = req.query;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' });

  try {
    const url = `${KASPI_QRPAY_URL}/v01/remote/client-info?phoneNumber=${phoneNumber}`;
    const resp = await loggedFetch(url, { headers: signedQrPayHeaders(url, req.session) });
    res.json(await resp.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create invoice ───

export const createInvoiceHandler = ({ request = loggedFetch, track = trackPayment, store = paymentStore } = {}) => async (req, res) => {
  const { phoneNumber, amount, comment } = req.body;
  if (!phoneNumber || !Number.isFinite(Number(amount)) || Number(amount) <= 0)
    return res.status(400).json({ error: 'phoneNumber and positive amount required' });
  const correlationId = req.body.correlation_id || req.get('X-Correlation-ID') || null;
  const idempotencyKey = req.get('Idempotency-Key') || null;
  if ((correlationId && (typeof correlationId !== 'string' || correlationId.length > 200)) ||
      (idempotencyKey && idempotencyKey.length > 200))
    return res.status(400).json({ error: 'Invalid operation identifiers' });
  let reservation = null;

  try {
    if (idempotencyKey) {
      reservation = store.reserveInvoice(req.session.profileId || req.session.tokenSN,
        idempotencyKey, { phoneNumber: String(phoneNumber), amount: Number(amount), comment: comment || '', correlationId });
      if (!reservation.created) {
        if (reservation.conflict) return res.status(409).json({ error: 'Idempotency-Key already used with different parameters' });
        if (reservation.status === 'completed') return res.status(reservation.httpStatus).json(reservation.response);
        // Upstream may already have created the invoice. Do not create another one.
        return res.status(409).json({ error: 'Invoice creation outcome unknown; reconcile before retrying', correlation_id: correlationId });
      }
    }
    const url = `${KASPI_QRPAY_URL}/v01/remote/create`;
    const payload = JSON.stringify({ PhoneNumber: phoneNumber, Amount: Number(amount), Comment: comment || '' });
    const headers = { ...signedQrPayHeaders(url, req.session, payload), 'Content-Type': 'application/json' };
    const resp = await request(url, {
      method: 'POST',
      headers,
      body: payload,
    });
    const kaspiResponse = await resp.json();
    const d = kaspiResponse.Data;
    if (d && d.QrOperationId) {
      track(
        d.QrOperationId,
        'invoice',
        {
          tokenSN: req.session.tokenSN,
          vtokenSecret: req.headers['x-vtoken-secret'],
          profileId: req.session.profileId,
        },
        {
          amount: d.Amount ?? Number(amount),
          correlationId,
          clientMobile: d.ClientMobile,
          receiptUrl: d.ReceiptUrl,
          orderNumber: d.OrderNumber,
        },
      );
    }
    // A crash before this commit leaves the key reserved, preventing duplicate creation.
    if (reservation) store.completeInvoice(reservation.id, kaspiResponse, resp.status);
    res.status(resp.status).json(kaspiResponse);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

router.post('/create', createInvoiceHandler());

// Delivery diagnostics contain no auth headers or webhook secrets.
router.get('/webhook-deliveries', (req, res) => {
  if (!req.session.profileId) return res.status(400).json({ error: 'Profile ID required' });
  res.json({ deliveries: paymentStore.listDeliveries(String(req.session.profileId)) });
});
router.post('/webhook-deliveries/:id/replay', (req, res) => {
  if (!req.session.profileId) return res.status(400).json({ error: 'Profile ID required' });
  const replayed = paymentStore.replayDelivery(req.params.id, String(req.session.profileId));
  res.status(replayed ? 202 : 404).json({ replayed });
});

// ─── Invoice details ───

router.get('/details', async (req, res) => {
  const { operationId } = req.query;
  if (!operationId) return res.status(400).json({ error: 'operationId required' });

  try {
    const url = `${KASPI_QRPAY_URL}/v02/remote/details?operationId=${operationId}`;
    const resp = await loggedFetch(url, { headers: signedQrPayHeaders(url, req.session) });
    res.json(await resp.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Cancel invoice ───

router.post('/cancel', async (req, res) => {
  const { operationId } = req.body;
  if (!operationId) return res.status(400).json({ error: 'operationId required' });

  try {
    const url = `${KASPI_QRPAY_URL}/v01/remote/cancel`;
    const payload = JSON.stringify({ qrOperationId: Number(operationId) });
    const headers = { ...signedQrPayHeaders(url, req.session, payload), 'Content-Type': 'application/json' };
    const resp = await loggedFetch(url, {
      method: 'POST',
      headers,
      body: payload,
    });
    res.json(await resp.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Invoice history ───

router.post('/history', async (req, res) => {
  try {
    const url = `${KASPI_QRPAY_URL}/v01/remote/history`;
    const payload = JSON.stringify({ MaxResult: 20 });
    const headers = { ...signedQrPayHeaders(url, req.session, payload), 'Content-Type': 'application/json' };
    const resp = await loggedFetch(url, {
      method: 'POST',
      headers,
      body: payload,
    });
    res.json(await resp.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
