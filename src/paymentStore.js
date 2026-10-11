import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';

const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** One SQLite transaction commits a final status and every notification together. */
export class PaymentStore {
  constructor(filename) {
    if (filename !== ':memory:') {
      fs.closeSync(fs.openSync(filename, 'a', 0o600));
      fs.chmodSync(filename, 0o600);
    }
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, entry TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, hook TEXT NOT NULL, payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS invoice_requests (
        id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'started',
        response TEXT, http_status INTEGER
      );
      CREATE TABLE IF NOT EXISTS metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  savePayments(entries) {
    this.transaction(() => {
      this.db.exec('DELETE FROM payments');
      const insert = this.db.prepare('INSERT INTO payments(id, entry) VALUES (?, ?)');
      for (const [id, entry] of entries) insert.run(id, JSON.stringify(entry));
    });
  }

  payments() {
    return this.db.prepare('SELECT id, entry FROM payments').all().map((row) => [row.id, JSON.parse(row.entry)]);
  }

  finishPayment(id, event, payload, hooks) {
    this.transaction(() => {
      const eventId = hash([payload.accountId || '', payload.paymentId, event, payload.status]);
      const previous = this.db.prepare('SELECT payload FROM events WHERE id=?').get(eventId);
      const envelope = previous ? JSON.parse(previous.payload) : { ...payload, event_id: eventId };
      this.db.prepare('INSERT OR IGNORE INTO events(id, payload) VALUES (?, ?)').run(eventId, JSON.stringify(envelope));
      for (const hook of hooks) this.enqueue(hook, envelope);
      this.db.prepare('DELETE FROM payments WHERE id=?').run(id);
    });
  }

  enqueue(hook, payload) {
    if (!payload.event_id) payload = { ...payload, event_id: hash([payload.paymentId, payload.event, payload.status, payload.timestamp]) };
    const id = hash([hook.url, payload.event_id]);
    this.db.prepare('INSERT OR IGNORE INTO deliveries(id,event_id,hook,payload) VALUES (?,?,?,?)')
      .run(id, payload.event_id, JSON.stringify(hook), JSON.stringify(payload));
  }

  claimDeliveries(now = Date.now(), limit = 20) {
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM deliveries WHERE status='pending'
        AND available_at<=? AND lease_until<=? ORDER BY available_at LIMIT ?`).all(now, now, limit);
      for (const row of rows) this.db.prepare('UPDATE deliveries SET lease_until=? WHERE id=?').run(now + 300000, row.id);
      return rows.map((row) => ({ ...row, hook: JSON.parse(row.hook), payload: JSON.parse(row.payload) }));
    });
  }

  deliverySucceeded(id) {
    this.db.prepare("UPDATE deliveries SET status='delivered', lease_until=0, last_error='' WHERE id=?").run(id);
  }

  deliveryFailed(id, message, now = Date.now()) {
    const row = this.db.prepare('SELECT attempts FROM deliveries WHERE id=?').get(id);
    if (!row) return;
    const delivered = this.db.prepare('SELECT status FROM deliveries WHERE id=?').get(id);
    if (delivered.status === 'delivered') return;
    const attempts = row.attempts + 1;
    const delay = Math.min(3600000, 5000 * 2 ** Math.min(attempts - 1, 10)) + crypto.randomInt(0, 1000);
    this.db.prepare('UPDATE deliveries SET attempts=?,status=?,available_at=?,lease_until=0,last_error=? WHERE id=?')
      .run(attempts, attempts >= 20 ? 'failed' : 'pending', now + delay, message.slice(0, 200), id);
  }

  reserveInvoice(account, idempotencyKey, request) {
    return this.transaction(() => {
      const id = hash([account, idempotencyKey]);
      const requestHash = hash(request);
      const previous = this.db.prepare('SELECT * FROM invoice_requests WHERE id=?').get(id);
      if (previous) return { created: false, conflict: previous.request_hash !== requestHash,
        status: previous.status, response: previous.response ? JSON.parse(previous.response) : null,
        httpStatus: previous.http_status, id };
      this.db.prepare('INSERT INTO invoice_requests(id, request_hash) VALUES (?,?)').run(id, requestHash);
      return { created: true, id };
    });
  }

  completeInvoice(id, response, httpStatus) {
    this.db.prepare("UPDATE invoice_requests SET status='completed',response=?,http_status=? WHERE id=?")
      .run(JSON.stringify(response), httpStatus, id);
  }

  migrateLegacy(trackedPath, retriesPath) {
    if (this.db.prepare("SELECT id FROM metadata WHERE id='legacy-import'").get()) return;
    const tracked = fs.existsSync(trackedPath) ? JSON.parse(fs.readFileSync(trackedPath, 'utf8')) : {};
    const retries = fs.existsSync(retriesPath) ? JSON.parse(fs.readFileSync(retriesPath, 'utf8')) : [];
    this.transaction(() => {
      for (const [id, entry] of Object.entries(tracked)) {
        const key = `${entry.sessionHeaders?.profileId || ''}:${id}`;
        this.db.prepare('INSERT OR IGNORE INTO payments(id,entry) VALUES (?,?)').run(key, JSON.stringify(entry));
      }
      for (const retry of retries) this.enqueue(retry.hook, retry.payload);
      this.db.prepare("INSERT INTO metadata(id,value) VALUES ('legacy-import','done')").run();
    });
  }

  listDeliveries(account) {
    return this.db.prepare(`SELECT id,event_id,attempts,status,last_error,
      json_extract(payload,'$.paymentId') AS payment_id,
      json_extract(payload,'$.correlation_id') AS correlation_id
      FROM deliveries WHERE json_extract(payload,'$.accountId')=?
      ORDER BY available_at DESC LIMIT 100`).all(account);
  }

  replayDelivery(id, account) {
    return this.db.prepare(`UPDATE deliveries SET status='pending', attempts=0, available_at=0, lease_until=0
      WHERE id=? AND status='failed' AND json_extract(payload,'$.accountId')=?`).run(id, account).changes > 0;
  }

  close() { this.db.close(); }
}
