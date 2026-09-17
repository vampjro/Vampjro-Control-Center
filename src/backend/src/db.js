'use strict';

const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.BACKEND_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'vampjro.db');
let db = null;

async function init() {
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'stable',
      version TEXT,
      state TEXT NOT NULL DEFAULT 'offline',
      last_seen INTEGER,
      last_health TEXT,
      paired_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      data TEXT,
      ip TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'stable',
      rollout_percent INTEGER NOT NULL DEFAULT 100,
      download_url TEXT,
      sha256 TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_clients_state ON clients(state)');
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_releases_channel ON releases(channel, active)');

  save();
  return db;
}

function get() {
  return db;
}

function save() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch {}
}

function close() {
  save();
  if (db) db.close();
  db = null;
}

// Convenience wrappers matching better-sqlite3 patterns
function prepare(sql) {
  return {
    run(...params) {
      db.run(sql, params);
      save();
    },
    get(...params) {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      let row = null;
      if (stmt.step()) {
        row = stmt.getAsObject();
      }
      stmt.free();
      return row;
    },
    all(...params) {
      const rows = [];
      const stmt = db.prepare(sql);
      stmt.bind(params);
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows;
    }
  };
}

module.exports = { init, get, close, save, prepare };
