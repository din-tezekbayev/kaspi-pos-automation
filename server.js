import express from 'express';
import path from 'path';
import { PORT, ROOT_DIR } from './src/config.js';
import authRoutes from './src/routes/auth.js';
import invoiceRoutes from './src/routes/invoice.js';
import qrRoutes from './src/routes/qr.js';
import historyRoutes from './src/routes/history.js';
import refundRoutes from './src/routes/refund.js';
import sessionRoutes from './src/routes/session.js';
import { startPolling } from './src/polling.js';
import 'dotenv/config';

const app = express();

app.use(express.json());
app.use(express.static(path.join(ROOT_DIR, 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// API-токен для внешних систем: «Authorization: Bearer <токен>» вместо трёх заголовков сессии.
// Токен — base64url от JSON {tokenSN, profileId, vtokenSecret}, его выдаёт веб-интерфейс после входа.
app.use('/api', (req, res, next) => {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
  if (!bearer) return next();
  try {
    const { tokenSN, profileId, vtokenSecret } = JSON.parse(Buffer.from(bearer, 'base64url').toString('utf8'));
    req.headers['x-token-sn'] = tokenSN;
    req.headers['x-profile-id'] = String(profileId ?? '');
    req.headers['x-vtoken-secret'] = vtokenSecret;
  } catch {
    return res.status(401).json({ error: 'Invalid API token. Copy a fresh one from the web UI.' });
  }
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/invoice', invoiceRoutes);
app.use('/api/qr', qrRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/refund', refundRoutes);
app.use('/api/session', sessionRoutes);

app.listen(PORT, () => {
  console.log(`\n  🟢 Kaspi Pay App running at http://localhost:${PORT}\n`);
  startPolling();
});
