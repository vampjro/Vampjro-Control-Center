'use strict';

const db = require('./db');

function log(action, data) {
  try {
    db.prepare(
      'INSERT INTO audit_log (action, data, ip, created_at) VALUES (?, ?, ?, ?)'
    ).run(action, JSON.stringify(data || {}), data?.ip || null, Date.now());
  } catch {}
}

function query(options = {}) {
  const { limit = 100, offset = 0, action, since } = options;
  let sql = 'SELECT * FROM audit_log';
  const params = [];
  const conditions = [];

  if (action) {
    conditions.push('action = ?');
    params.push(action);
  }
  if (since) {
    conditions.push('created_at >= ?');
    params.push(since);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

function count() {
  return db.prepare('SELECT COUNT(*) as count FROM audit_log').get().count;
}

module.exports = { log, query, count };
