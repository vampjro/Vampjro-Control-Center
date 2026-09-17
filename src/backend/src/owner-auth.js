'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.BACKEND_DATA_DIR || path.join(__dirname, '..', 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'owner-token.json');

const MAX_FAILED_ATTEMPTS = 5;
const COOLDOWN_MS = 60000;
const failedAttempts = new Map();

function getStoredToken() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return data.tokenHash;
  } catch {
    return null;
  }
}

function setupToken(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const dataDir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ tokenHash, createdAt: Date.now() }), 'utf8');
  return tokenHash;
}

function checkRateLimit(ip) {
  const entry = failedAttempts.get(ip);
  if (!entry) return { allowed: true };
  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    const elapsed = Date.now() - entry.lastAttempt;
    if (elapsed < COOLDOWN_MS) {
      return { allowed: false, cooldown: Math.ceil((COOLDOWN_MS - elapsed) / 1000) };
    }
    failedAttempts.delete(ip);
  }
  return { allowed: true };
}

function recordFailure(ip) {
  const entry = failedAttempts.get(ip) || { count: 0, lastAttempt: 0 };
  entry.count++;
  entry.lastAttempt = Date.now();
  failedAttempts.set(ip, entry);
}

function clearFailures(ip) {
  failedAttempts.delete(ip);
}

function authenticate(token, ip) {
  if (!token) return { success: false, error: 'Token required' };

  if (ip) {
    const limit = checkRateLimit(ip);
    if (!limit.allowed) {
      return { success: false, error: 'Too many attempts', cooldown: limit.cooldown };
    }
  }

  const storedHash = getStoredToken();
  if (!storedHash) {
    setupToken(token);
    if (ip) clearFailures(ip);
    return { success: true, firstSetup: true };
  }

  const hash = crypto.createHash('sha256').update(token).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(hash, 'hex'))) {
    if (ip) recordFailure(ip);
    return { success: false, error: 'Invalid token' };
  }

  if (ip) clearFailures(ip);
  return { success: true };
}

function isConfigured() {
  return !!getStoredToken();
}

module.exports = { authenticate, setupToken, isConfigured };
