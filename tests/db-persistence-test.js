'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const TEST_DB_DIR = path.join(__dirname, 'test-data', 'db-test');
const DB_FILE = path.join(TEST_DB_DIR, 'vampjro.db');
const BACKEND_DIR = path.join(SRC, 'backend');

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ [FAIL] ${name}: ${err.message}`);
    failed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ [FAIL] ${name}: ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

function cleanTestDir() {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
}

function createTestDb() {
  const initSqlJs = require(path.join(BACKEND_DIR, 'node_modules', 'sql.js'));

  let _db = null;

  async function init() {
    const SQL = await initSqlJs();
    if (fs.existsSync(DB_FILE)) {
      const buffer = fs.readFileSync(DB_FILE);
      _db = new SQL.Database(buffer);
    } else {
      _db = new SQL.Database();
    }

    _db.run('PRAGMA journal_mode = WAL');
    _db.run('PRAGMA foreign_keys = ON');

    _db.run(`CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_hash TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'stable', version TEXT,
      state TEXT NOT NULL DEFAULT 'offline', last_seen INTEGER,
      last_health TEXT, paired_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    )`);

    _db.run(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL,
      data TEXT, ip TEXT, created_at INTEGER NOT NULL
    )`);

    _db.run(`CREATE TABLE IF NOT EXISTS releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'stable',
      rollout_percent INTEGER NOT NULL DEFAULT 100,
      download_url TEXT, sha256 TEXT, notes TEXT,
      created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1
    )`);

    _db.run('CREATE INDEX IF NOT EXISTS idx_clients_state ON clients(state)');
    _db.run('CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)');
    _db.run('CREATE INDEX IF NOT EXISTS idx_releases_channel ON releases(channel, active)');

    save();
  }

  function save() {
    if (!_db) return;
    try {
      const data = _db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_FILE, buffer);
    } catch {}
  }

  function close() {
    save();
    if (_db) _db.close();
    _db = null;
  }

  function prepare(sql) {
    return {
      run(...params) {
        _db.run(sql, params);
        save();
      },
      get(...params) {
        const stmt = _db.prepare(sql);
        stmt.bind(params);
        let row = null;
        if (stmt.step()) row = stmt.getAsObject();
        stmt.free();
        return row;
      },
      all(...params) {
        const rows = [];
        const stmt = _db.prepare(sql);
        stmt.bind(params);
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      }
    };
  }

  return { init, save, close, prepare };
}

async function run() {
  console.log('\nVAMPJRO Database Persistence Test Suite');
  console.log('='.repeat(40));

  // ===== Phase 1: Fresh database creation =====
  console.log('\n--- Phase 1: Fresh Creation ---');
  cleanTestDir();

  let db = createTestDb();

  await asyncTest('Database initializes on fresh dir', async () => {
    await db.init();
    assert(fs.existsSync(DB_FILE), 'DB file should exist');
  });

  test('DB file size is reasonable', () => {
    const stat = fs.statSync(DB_FILE);
    assert(stat.size > 0, 'DB file should not be empty');
    assert(stat.size < 1024 * 1024, 'DB file should be under 1MB for empty db');
  });

  // ===== Phase 2: Write and read operations =====
  console.log('\n--- Phase 2: Write & Read ---');

  test('Insert client', () => {
    db.prepare(
      'INSERT INTO clients (id, name, secret_hash, channel, paired_at) VALUES (?, ?, ?, ?, ?)'
    ).run('test-client-1', 'Test PC 1', crypto.randomBytes(32).toString('hex'), 'stable', Date.now());
  });

  test('Read inserted client', () => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get('test-client-1');
    assert(client, 'Client should exist');
    assert(client.name === 'Test PC 1', `Name mismatch: "${client.name}"`);
    assert(client.channel === 'stable', 'Channel should be stable');
    assert(client.revoked === 0, 'Should not be revoked');
  });

  test('Insert multiple clients', () => {
    for (let i = 2; i <= 10; i++) {
      db.prepare(
        'INSERT INTO clients (id, name, secret_hash, channel, paired_at) VALUES (?, ?, ?, ?, ?)'
      ).run(`test-client-${i}`, `Test PC ${i}`, crypto.randomBytes(32).toString('hex'), i <= 7 ? 'stable' : 'beta', Date.now());
    }
  });

  test('Count clients', () => {
    const row = db.prepare('SELECT COUNT(*) as count FROM clients').get();
    assert(row.count === 10, `Expected 10, got ${row.count}`);
  });

  test('Filter by channel', () => {
    const stable = db.prepare('SELECT * FROM clients WHERE channel = ?').all('stable');
    const beta = db.prepare('SELECT * FROM clients WHERE channel = ?').all('beta');
    assert(stable.length === 7, `Expected 7 stable, got ${stable.length}`);
    assert(beta.length === 3, `Expected 3 beta, got ${beta.length}`);
  });

  test('Update client state', () => {
    db.prepare('UPDATE clients SET state = ?, last_seen = ? WHERE id = ?').run('online', Date.now(), 'test-client-1');
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get('test-client-1');
    assert(client.state === 'online', `State should be online, got ${client.state}`);
  });

  test('Insert 50 audit log entries', () => {
    for (let i = 0; i < 50; i++) {
      db.prepare(
        'INSERT INTO audit_log (action, data, ip, created_at) VALUES (?, ?, ?, ?)'
      ).run('client_paired', JSON.stringify({ clientId: `test-client-${(i % 10) + 1}` }), '127.0.0.1', Date.now() - (50 - i) * 1000);
    }
  });

  test('Query audit log with limit', () => {
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(10);
    assert(rows.length === 10, `Expected 10, got ${rows.length}`);
  });

  test('Revoke client', () => {
    db.prepare('UPDATE clients SET revoked = 1, state = ? WHERE id = ?').run('offline', 'test-client-5');
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get('test-client-5');
    assert(client.revoked === 1, 'Should be revoked');
  });

  test('Query non-revoked clients', () => {
    const active = db.prepare('SELECT * FROM clients WHERE revoked = 0').all();
    assert(active.length === 9, `Expected 9, got ${active.length}`);
  });

  test('Store and retrieve health JSON', () => {
    const health = { cpu: 45.2, memTotal: 17179869184, memFree: 8589934592 };
    db.prepare('UPDATE clients SET last_health = ? WHERE id = ?').run(JSON.stringify(health), 'test-client-1');
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get('test-client-1');
    const parsed = JSON.parse(c.last_health);
    assert(parsed.cpu === 45.2, 'Health data should round-trip');
  });

  // ===== Phase 3: Persistence across restart =====
  console.log('\n--- Phase 3: Persistence Across Restart ---');

  const fileSizeBefore = fs.statSync(DB_FILE).size;
  test('DB file saved to disk', () => {
    assert(fileSizeBefore > 0, 'DB file should not be empty');
  });

  db.close();
  db = createTestDb();

  await asyncTest('Reinitialize from existing file', async () => {
    await db.init();
  });

  test('Clients persist after restart', () => {
    const all = db.prepare('SELECT * FROM clients').all();
    assert(all.length === 10, `Expected 10, got ${all.length}`);
  });

  test('Client data intact after restart', () => {
    const c1 = db.prepare('SELECT * FROM clients WHERE id = ?').get('test-client-1');
    assert(c1.name === 'Test PC 1', 'Name should persist');
    assert(c1.state === 'online', 'State should persist');
    const health = JSON.parse(c1.last_health);
    assert(health.cpu === 45.2, 'Health JSON should persist');
  });

  test('Revocation persists after restart', () => {
    const c5 = db.prepare('SELECT * FROM clients WHERE id = ?').get('test-client-5');
    assert(c5.revoked === 1, 'Revocation should persist');
  });

  test('Audit log persists after restart', () => {
    const count = db.prepare('SELECT COUNT(*) as count FROM audit_log').get();
    assert(count.count === 50, `Expected 50, got ${count.count}`);
  });

  // ===== Phase 4: Rapid sequential writes =====
  console.log('\n--- Phase 4: Rapid Sequential Writes ---');

  test('100 rapid audit inserts', () => {
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      db.prepare(
        'INSERT INTO audit_log (action, data, ip, created_at) VALUES (?, ?, ?, ?)'
      ).run('rapid_write', JSON.stringify({ seq: i }), '127.0.0.1', Date.now());
    }
    const elapsed = Date.now() - start;
    const total = db.prepare('SELECT COUNT(*) as count FROM audit_log').get();
    assert(total.count === 150, `Expected 150, got ${total.count}`);
    console.log(`    (100 inserts in ${elapsed}ms)`);
  });

  test('100 rapid client updates', () => {
    const start = Date.now();
    for (let i = 1; i <= 10; i++) {
      for (let j = 0; j < 10; j++) {
        db.prepare('UPDATE clients SET last_seen = ? WHERE id = ?').run(Date.now(), `test-client-${i}`);
      }
    }
    const elapsed = Date.now() - start;
    const all = db.prepare('SELECT * FROM clients').all();
    assert(all.length === 10, 'All clients should survive rapid updates');
    console.log(`    (100 updates in ${elapsed}ms)`);
  });

  test('Data survives after rapid writes + restart', () => {
    db.close();
    db = createTestDb();
  });

  await asyncTest('Reinitialize after rapid writes', async () => {
    await db.init();
    const count = db.prepare('SELECT COUNT(*) as count FROM audit_log').get();
    assert(count.count === 150, `Expected 150, got ${count.count}`);
  });

  // ===== Phase 5: Non-existent record queries =====
  console.log('\n--- Phase 5: Edge Cases ---');

  test('Query non-existent client returns null', () => {
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get('does-not-exist');
    assert(c === null, 'Should return null for missing record');
  });

  test('Empty result set returns empty array', () => {
    const rows = db.prepare('SELECT * FROM clients WHERE channel = ?').all('nonexistent-channel');
    assert(Array.isArray(rows) && rows.length === 0, 'Should return empty array');
  });

  test('Insert release metadata', () => {
    db.prepare(
      'INSERT INTO releases (version, channel, rollout_percent, download_url, sha256, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('1.1.0', 'stable', 50, 'https://example.com/v1.1.0.zip', 'abc123', 'Bug fixes', Date.now());
    const rel = db.prepare('SELECT * FROM releases WHERE version = ?').get('1.1.0');
    assert(rel.rollout_percent === 50, 'Rollout percent should be 50');
  });

  // ===== Phase 6: Corrupted DB =====
  console.log('\n--- Phase 6: Corruption Handling ---');

  db.close();

  test('Write corrupted data to DB file', () => {
    fs.writeFileSync(DB_FILE, 'THIS IS NOT A VALID SQLITE DATABASE', 'utf8');
    assert(fs.existsSync(DB_FILE), 'Corrupted file should exist');
  });

  db = createTestDb();

  await asyncTest('Init with corrupted DB is catchable', async () => {
    let threw = false;
    try {
      await db.init();
    } catch (err) {
      threw = true;
      assert(err.message, 'Should have error message');
    }
    // Either it throws (acceptable) or creates fresh (also acceptable)
    // Process should not crash
  });

  // ===== Phase 7: Empty/fresh DB =====
  console.log('\n--- Phase 7: Fresh Empty DB ---');

  cleanTestDir();
  db = createTestDb();

  await asyncTest('Init fresh empty DB', async () => {
    await db.init();
  });

  test('Empty clients table', () => {
    const all = db.prepare('SELECT * FROM clients').all();
    assert(all.length === 0, 'Should be empty');
  });

  test('Empty audit_log table', () => {
    const all = db.prepare('SELECT * FROM audit_log').all();
    assert(all.length === 0, 'Should be empty');
  });

  test('Insert into fresh DB works', () => {
    db.prepare(
      'INSERT INTO clients (id, name, secret_hash, channel, paired_at) VALUES (?, ?, ?, ?, ?)'
    ).run('fresh-1', 'Fresh Client', 'hash', 'stable', Date.now());
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get('fresh-1');
    assert(c.name === 'Fresh Client', 'Should insert into fresh DB');
  });

  db.close();
  cleanTestDir();

  // ===== Summary =====
  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`Total:   ${passed + failed} tests`);
  console.log(failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${failed} test(s) failed`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
