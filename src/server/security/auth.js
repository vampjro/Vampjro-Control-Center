const crypto = require('crypto');
const config = require('../core/config');
const logger = require('../core/logger');

const sessions = new Map();
const failedAttempts = new Map();

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin.toString(), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pin.toString(), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

function setupPin(pin) {
  const hashed = hashPin(pin);
  config.set('security.pinHash', hashed);
  logger.info('PIN configured');
  return true;
}

function isPinSet() {
  return !!config.get('security.pinHash');
}

function authenticate(pin, deviceId) {
  const ip = deviceId || 'unknown';
  const now = Date.now();
  const attempts = failedAttempts.get(ip) || { count: 0, lastAttempt: 0, cooldownUntil: 0 };

  if (now < attempts.cooldownUntil) {
    const remaining = Math.ceil((attempts.cooldownUntil - now) / 1000);
    return { success: false, error: `Too many attempts. Wait ${remaining}s`, cooldown: remaining };
  }

  const stored = config.get('security.pinHash');
  if (!stored) return { success: false, error: 'PIN not configured' };

  if (!verifyPin(pin, stored)) {
    attempts.count++;
    attempts.lastAttempt = now;
    const max = config.get('security.maxFailedAttempts') || 5;
    if (attempts.count >= max) {
      const cooldown = config.get('security.cooldownMs') || 60000;
      attempts.cooldownUntil = now + cooldown;
      attempts.count = 0;
      logger.warn(`Auth lockout for ${ip}`);
    }
    failedAttempts.set(ip, attempts);
    logger.logAction(ip, 'auth', 'failed');
    return { success: false, error: 'Invalid PIN' };
  }

  failedAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  const ttl = config.get('security.sessionTTL') || 86400000;
  sessions.set(token, { deviceId: ip, createdAt: now, expiresAt: now + ttl });
  logger.logAction(ip, 'auth', 'success');
  return { success: true, token, expiresAt: now + ttl };
}

function validateToken(token, deviceId) {
  const session = sessions.get(token);
  if (!session) return false;

  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return false;
  }

  // When a device identifier is supplied, bind the token to it.
  // Backwards-compatible: callers that do not supply deviceId
  // still receive normal token validation.
  if (deviceId !== undefined && deviceId !== null) {
    if (session.deviceId !== deviceId) {
      return false;
    }
  }

  return true;
}

function revokeToken(token) {
  sessions.delete(token);
}

function revokeAll() {
  sessions.clear();
  logger.info('All sessions revoked');
}

function getSessionCount() {
  cleanExpired();
  return sessions.size;
}

function cleanExpired() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(token);
  }
}

setInterval(cleanExpired, 300000);

module.exports = { setupPin, isPinSet, authenticate, validateToken, revokeToken, revokeAll, getSessionCount, hashPin };
