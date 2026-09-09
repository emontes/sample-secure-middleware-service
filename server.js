const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const express = require('express');

const app = express();
app.use(express.json());

const MOCK_AI_TIMEOUT_MS = 2000;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 10000;
const DB_FILE = path.resolve(__dirname, process.env.DB_FILE || 'mockDb.json');

let writeQueue = Promise.resolve();
let encryptionKey;

function getEncryptionKey() {
  if (encryptionKey) return encryptionKey;

  if (process.env.AUDIT_ENCRYPTION_KEY) {
    encryptionKey = crypto.scryptSync(process.env.AUDIT_ENCRYPTION_KEY, 'audit-log-salt', 32);
  } else {
    encryptionKey = crypto.randomBytes(32);
    console.warn('AUDIT_ENCRYPTION_KEY not set; using an ephemeral 256-bit key generated at startup.');
  }

  return encryptionKey;
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function sanitize(message) {
  let redacted = message;

  redacted = redacted.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    '<REDACTED: EMAIL>'
  );

  redacted = redacted.replace(
    /\b(?:\d[ -]?){13,19}\b/g,
    '<REDACTED: CREDIT_CARD>'
  );

  redacted = redacted.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '<REDACTED: SSN>');
  redacted = redacted.replace(/\b\d{9}\b/g, '<REDACTED: SSN>');

  return redacted;
}

function callMockAI(shouldFail = false) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (shouldFail) {
        reject(new Error('Mock AI service unavailable'));
      } else {
        resolve('Generated Answer');
      }
    }, MOCK_AI_TIMEOUT_MS);
  });
}

class CircuitBreaker {
  constructor(threshold, resetTimeoutMs) {
    this.failureThreshold = threshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.nextAttempt = 0;
  }

  isOpen() {
    if (this.state === 'OPEN') {
      if (Date.now() >= this.nextAttempt) {
        this.state = 'HALF_OPEN';
        return false;
      }
      return true;
    }
    return false;
  }

  async fire(operation) {
    if (this.isOpen()) {
      throw new Error('Service Busy');
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  onSuccess() {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  onFailure() {
    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.resetTimeoutMs;
      console.warn(`Circuit breaker OPENED after ${this.failureThreshold} consecutive failures`);
    }
  }
}

const breaker = new CircuitBreaker(CIRCUIT_BREAKER_THRESHOLD, CIRCUIT_BREAKER_RESET_MS);

function appendAudit(record) {
  writeQueue = writeQueue
    .then(async () => {
      let db = [];
      try {
        const data = await fs.readFile(DB_FILE, 'utf8');
        db = JSON.parse(data);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }

      db.push(record);
      await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
      return record;
    })
    .catch((err) => {
      console.error('Audit log write failed:', err.message);
      throw err;
    });

  return writeQueue;
}

app.post('/secure-inquiry', async (req, res) => {
  try {
    const { userId, message } = req.body;

    if (
      typeof userId !== 'string' ||
      typeof message !== 'string' ||
      !userId.trim() ||
      message.length === 0
    ) {
      return res.status(400).json({
        error: 'userId and message are required and must be non-empty strings'
      });
    }

    const redactedMessage = sanitize(message);

    const simulateFailure = req.get('x-simulate-ai-failure') === 'true';
    const answer = await breaker.fire(() => callMockAI(simulateFailure));

    await appendAudit({
      timestamp: new Date().toISOString(),
      userId,
      originalEncrypted: encrypt(message),
      redactedMessage
    });

    return res.json({ userId, answer, redactedMessage });
  } catch (err) {
    if (err.message === 'Service Busy') {
      return res.status(503).json({ message: 'Service Busy' });
    }

    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Secure inquiry service listening on http://localhost:${PORT}`);
});
