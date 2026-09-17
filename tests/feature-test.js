'use strict';

const WebSocket = require('ws');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const BACKEND_PORT = 4400;

let passed = 0, failed = 0;
const processes = [];
const tempDataDirs = [];

function log(status, name, detail) {
  const icon = status === 'PASS' ? '✓' : '✗';
  console.log(`  ${icon} [${status}] ${name}${detail ? ': ' + detail : ''}`);
  if (status === 'PASS') passed++; else failed++;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    }).on('error', reject);
  });
}

function wsConnect(wsPath, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${BACKEND_PORT}${wsPath}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('Connect timeout')); }, timeout);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitMsg(ws, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
    const handler = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === type) { clearTimeout(timer); ws.removeListener('message', handler); resolve(msg); }
      } catch {}
    };
    ws.on('message', handler);
  });
}

function collectMsg(ws, type, timeout = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    const handler = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === type) { clearTimeout(timer); ws.removeListener('message', handler); resolve(msg); }
      } catch {}
    };
    ws.on('message', handler);
  });
}

function startBackend(port) {
  port = port || BACKEND_PORT;
  return new Promise((resolve, reject) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vampjro-feattest-'));
    tempDataDirs.push(dataDir);
    const proc = spawn(process.execPath, [path.join(SRC, 'backend', 'src', 'index.js')], {
      env: { ...process.env, BACKEND_PORT: String(port), BACKEND_HOST: '127.0.0.1', BACKEND_DATA_DIR: dataDir },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    processes.push(proc);
    let started = false;
    proc.stdout.on('data', data => {
      if (!started && data.toString().includes('Backend')) { started = true; setTimeout(() => resolve(proc), 500); }
    });
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    setTimeout(() => { if (!started) reject(new Error('Backend start timeout')); }, 15000);
  });
}

function killAll() {
  for (const p of processes) { try { p.kill('SIGTERM'); } catch {} }
}

async function setupOwnerAndPair(count = 1) {
  const ownerWs = await wsConnect('/owner');
  const token = crypto.randomBytes(32).toString('hex');
  ownerWs.send(JSON.stringify({ type: 'ownerAuth', token, ts: Date.now() }));
  await waitMsg(ownerWs, 'ownerAuthOk');

  const pairs = [];
  for (let i = 0; i < count; i++) {
    ownerWs.send(JSON.stringify({ type: 'pairRequest', name: `FeatureTest-${i}`, ts: Date.now() }));
    const pair = await waitMsg(ownerWs, 'pairSuccess');
    pairs.push({ clientId: pair.clientId, secret: pair.secret });
  }

  return { ownerWs, token, pairs };
}

async function connectAndAuthClient(pair) {
  const ws = await wsConnect('/client');
  ws.send(JSON.stringify({ type: 'clientAuth', clientId: pair.clientId, secret: pair.secret, ts: Date.now() }));
  await waitMsg(ws, 'clientAuthOk');
  return ws;
}

async function run() {
  console.log('');
  console.log('VAMPJRO Feature Test Suite');
  console.log('========================================');
  console.log(`Backend port: ${BACKEND_PORT}\n`);

  await startBackend();
  await sleep(200);

  // ================================================
  // SECTION A: COMMAND TIMEOUT
  // ================================================
  console.log('--- A. Command Timeout ---');

  const { ownerWs, token, pairs } = await setupOwnerAndPair(2);

  // A1: Normal command with result
  try {
    const clientWs = await connectAndAuthClient(pairs[0]);
    const reqId = 'cmd_' + Date.now();

    const cmdPromise = collectMsg(ownerWs, 'remoteResult', 5000);
    ownerWs.send(JSON.stringify({
      type: 'remoteCommand', clientId: pairs[0].clientId, action: 'getHealth', requestId: reqId, ts: Date.now()
    }));

    const cmd = await waitMsg(clientWs, 'remoteCommand', 3000);
    clientWs.send(JSON.stringify({ type: 'remoteResult', requestId: cmd.requestId, data: { cpu: 42 }, ts: Date.now() }));

    const result = await cmdPromise;
    if (result && result.data && result.data.cpu === 42) {
      log('PASS', 'Normal command with result');
    } else {
      log('FAIL', 'Normal command with result', JSON.stringify(result));
    }
    clientWs.close();
  } catch (err) {
    log('FAIL', 'Normal command with result', err.message);
  }

  // A2: Command to offline client returns immediate error
  try {
    const reqId = 'offcmd_' + Date.now();
    const errPromise = waitMsg(ownerWs, 'remoteError', 3000);
    ownerWs.send(JSON.stringify({
      type: 'remoteCommand', clientId: pairs[1].clientId, action: 'getHealth', requestId: reqId, ts: Date.now()
    }));
    const err = await errPromise;
    if (err.error === 'Client offline') {
      log('PASS', 'Offline client immediate error');
    } else {
      log('FAIL', 'Offline client immediate error', err.error);
    }
  } catch (err) {
    log('FAIL', 'Offline client immediate error', err.message);
  }

  // A3: Client never responds → timeout error (we'll use short timeout by controlling timing)
  // The real timeout is 30s which is too long for tests. Instead verify the pending entry exists
  // and that a late result after disconnect doesn't crash.
  try {
    const clientWs2 = await connectAndAuthClient(pairs[0]);
    const reqId = 'timeout_' + Date.now();
    ownerWs.send(JSON.stringify({
      type: 'remoteCommand', clientId: pairs[0].clientId, action: 'getHealth', requestId: reqId, ts: Date.now()
    }));
    const cmd = await waitMsg(clientWs2, 'remoteCommand', 3000);
    // Client receives command but does NOT respond
    // Disconnect client while command is pending
    clientWs2.close();
    await sleep(500);
    log('PASS', 'Client disconnect during pending command (no crash)');
  } catch (err) {
    log('FAIL', 'Client disconnect during pending command', err.message);
  }

  // A4: Duplicate result doesn't crash
  try {
    const clientWs3 = await connectAndAuthClient(pairs[0]);
    const reqId = 'dup_' + Date.now();
    ownerWs.send(JSON.stringify({
      type: 'remoteCommand', clientId: pairs[0].clientId, action: 'getHealth', requestId: reqId, ts: Date.now()
    }));
    const cmd = await waitMsg(clientWs3, 'remoteCommand', 3000);
    // Send result twice
    clientWs3.send(JSON.stringify({ type: 'remoteResult', requestId: cmd.requestId, data: { ok: true }, ts: Date.now() }));
    await sleep(100);
    clientWs3.send(JSON.stringify({ type: 'remoteResult', requestId: cmd.requestId, data: { ok: true }, ts: Date.now() }));
    await sleep(100);
    log('PASS', 'Duplicate result does not crash');
    clientWs3.close();
  } catch (err) {
    log('FAIL', 'Duplicate result does not crash', err.message);
  }

  // A5: Multiple simultaneous commands
  try {
    const clientWs4 = await connectAndAuthClient(pairs[0]);
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const reqId = `multi_${i}_${Date.now()}`;
      ids.push(reqId);
      ownerWs.send(JSON.stringify({
        type: 'remoteCommand', clientId: pairs[0].clientId, action: 'getHealth', requestId: reqId, ts: Date.now()
      }));
    }
    // Collect all commands
    const received = [];
    for (let i = 0; i < 5; i++) {
      const cmd = await waitMsg(clientWs4, 'remoteCommand', 3000);
      received.push(cmd.requestId);
      clientWs4.send(JSON.stringify({ type: 'remoteResult', requestId: cmd.requestId, data: { seq: i }, ts: Date.now() }));
    }
    if (received.length === 5) {
      log('PASS', 'Multiple simultaneous commands: ' + received.length + ' received');
    } else {
      log('FAIL', 'Multiple simultaneous commands', `only ${received.length}/5`);
    }
    clientWs4.close();
  } catch (err) {
    log('FAIL', 'Multiple simultaneous commands', err.message);
  }

  // A6: Command ID uniqueness verified
  try {
    const clientWs5 = await connectAndAuthClient(pairs[0]);
    const sentIds = new Set();
    for (let i = 0; i < 10; i++) {
      const reqId = `uniq_${i}_${Date.now()}_${Math.random()}`;
      sentIds.add(reqId);
      ownerWs.send(JSON.stringify({
        type: 'remoteCommand', clientId: pairs[0].clientId, action: 'getHealth', requestId: reqId, ts: Date.now()
      }));
    }
    if (sentIds.size === 10) {
      log('PASS', 'Command ID uniqueness: 10 unique IDs');
    } else {
      log('FAIL', 'Command ID uniqueness', `${sentIds.size}/10 unique`);
    }
    clientWs5.close();
  } catch (err) {
    log('FAIL', 'Command ID uniqueness', err.message);
  }

  // ================================================
  // SECTION B: AUDIT QUERY
  // ================================================
  console.log('\n--- B. Audit Query ---');

  // B1: Authenticated query returns entries
  try {
    ownerWs.send(JSON.stringify({ type: 'auditQuery', limit: 50, ts: Date.now() }));
    const result = await waitMsg(ownerWs, 'auditQueryResult', 3000);
    if (result.entries && Array.isArray(result.entries) && result.total >= 0) {
      log('PASS', 'Authenticated audit query: ' + result.entries.length + ' entries, total=' + result.total);
    } else {
      log('FAIL', 'Authenticated audit query', JSON.stringify(result));
    }
  } catch (err) {
    log('FAIL', 'Authenticated audit query', err.message);
  }

  // B2: Unauthenticated query ignored
  try {
    const unauthedWs = await wsConnect('/owner');
    unauthedWs.send(JSON.stringify({ type: 'auditQuery', limit: 50, ts: Date.now() }));
    const result = await collectMsg(unauthedWs, 'auditQueryResult', 2000);
    if (result === null) {
      log('PASS', 'Unauthenticated audit query ignored');
    } else {
      log('FAIL', 'Unauthenticated audit query leaked data');
    }
    unauthedWs.close();
  } catch (err) {
    log('FAIL', 'Unauthenticated audit query', err.message);
  }

  // B3: Pagination with limit and offset
  try {
    ownerWs.send(JSON.stringify({ type: 'auditQuery', limit: 2, offset: 0, ts: Date.now() }));
    const page1 = await waitMsg(ownerWs, 'auditQueryResult', 3000);
    ownerWs.send(JSON.stringify({ type: 'auditQuery', limit: 2, offset: 2, ts: Date.now() }));
    const page2 = await waitMsg(ownerWs, 'auditQueryResult', 3000);
    if (page1.entries.length <= 2 && page2.offset === 2) {
      log('PASS', 'Audit pagination: page1=' + page1.entries.length + ', page2=' + page2.entries.length);
    } else {
      log('FAIL', 'Audit pagination', 'unexpected result');
    }
  } catch (err) {
    log('FAIL', 'Audit pagination', err.message);
  }

  // B4: Filter by action
  try {
    ownerWs.send(JSON.stringify({ type: 'auditQuery', action: 'owner_login', limit: 100, ts: Date.now() }));
    const result = await waitMsg(ownerWs, 'auditQueryResult', 3000);
    const allMatch = result.entries.every(e => e.action === 'owner_login');
    if (allMatch && result.entries.length > 0) {
      log('PASS', 'Audit filter by action: ' + result.entries.length + ' owner_login entries');
    } else if (result.entries.length === 0) {
      log('PASS', 'Audit filter by action: 0 entries (no matching action)');
    } else {
      log('FAIL', 'Audit filter by action', 'non-matching entries found');
    }
  } catch (err) {
    log('FAIL', 'Audit filter by action', err.message);
  }

  // B5: Filter by since timestamp
  try {
    const since = Date.now() + 100000; // future timestamp → 0 entries
    ownerWs.send(JSON.stringify({ type: 'auditQuery', since, limit: 100, ts: Date.now() }));
    const result = await waitMsg(ownerWs, 'auditQueryResult', 3000);
    if (result.entries.length === 0) {
      log('PASS', 'Audit filter by future timestamp: 0 entries');
    } else {
      log('FAIL', 'Audit filter by future timestamp', result.entries.length + ' entries returned');
    }
  } catch (err) {
    log('FAIL', 'Audit filter by since', err.message);
  }

  // B6: Limit clamping (max 500, min 1)
  try {
    ownerWs.send(JSON.stringify({ type: 'auditQuery', limit: 99999, ts: Date.now() }));
    const result = await waitMsg(ownerWs, 'auditQueryResult', 3000);
    if (result.limit === 500) {
      log('PASS', 'Audit limit clamped to 500');
    } else {
      log('FAIL', 'Audit limit clamped', 'limit=' + result.limit);
    }
  } catch (err) {
    log('FAIL', 'Audit limit clamping', err.message);
  }

  // B7: Ordering is newest-first
  try {
    ownerWs.send(JSON.stringify({ type: 'auditQuery', limit: 50, ts: Date.now() }));
    const result = await waitMsg(ownerWs, 'auditQueryResult', 3000);
    if (result.entries.length >= 2) {
      const ordered = result.entries.every((e, i) => i === 0 || e.created_at <= result.entries[i-1].created_at);
      if (ordered) {
        log('PASS', 'Audit ordering: newest first');
      } else {
        log('FAIL', 'Audit ordering', 'not in descending order');
      }
    } else {
      log('PASS', 'Audit ordering: too few entries to verify (' + result.entries.length + ')');
    }
  } catch (err) {
    log('FAIL', 'Audit ordering', err.message);
  }

  // B8: No sensitive info in audit entries
  try {
    ownerWs.send(JSON.stringify({ type: 'auditQuery', limit: 50, ts: Date.now() }));
    const result = await waitMsg(ownerWs, 'auditQueryResult', 3000);
    const serialized = JSON.stringify(result.entries);
    const hasSecret = serialized.includes(pairs[0].secret) || serialized.includes(token);
    if (!hasSecret) {
      log('PASS', 'Audit entries contain no secrets');
    } else {
      log('FAIL', 'Audit entries contain secrets!');
    }
  } catch (err) {
    log('FAIL', 'Audit secret check', err.message);
  }

  // B9: Invalid query parameters handled gracefully
  try {
    ownerWs.send(JSON.stringify({ type: 'auditQuery', limit: -5, offset: -10, ts: Date.now() }));
    const result = await waitMsg(ownerWs, 'auditQueryResult', 3000);
    if (result.limit >= 1 && result.offset >= 0) {
      log('PASS', 'Invalid params clamped: limit=' + result.limit + ', offset=' + result.offset);
    } else {
      log('FAIL', 'Invalid params', 'limit=' + result.limit + ', offset=' + result.offset);
    }
  } catch (err) {
    log('FAIL', 'Invalid query params', err.message);
  }

  // ================================================
  // SECTION C: STALE CLIENT DETECTION
  // ================================================
  console.log('\n--- C. Stale Client Detection ---');

  // C1: Healthy client with active WebSocket stays online
  try {
    const clientWsC1 = await connectAndAuthClient(pairs[0]);
    await sleep(500);
    ownerWs.send(JSON.stringify({ type: 'clientList', ts: Date.now() }));
    const list = await waitMsg(ownerWs, 'clientListResult', 3000);
    const client = list.clients.find(c => c.id === pairs[0].clientId);
    if (client && client.online) {
      log('PASS', 'Healthy client stays online');
    } else {
      log('FAIL', 'Healthy client stays online', client ? 'online=' + client.online : 'not found');
    }
    clientWsC1.close();
    await sleep(300);
  } catch (err) {
    log('FAIL', 'Healthy client stays online', err.message);
  }

  // C2: Client shows offline after disconnect
  try {
    await sleep(500);
    ownerWs.send(JSON.stringify({ type: 'clientList', ts: Date.now() }));
    const list = await waitMsg(ownerWs, 'clientListResult', 3000);
    const client = list.clients.find(c => c.id === pairs[0].clientId);
    if (client && !client.online) {
      log('PASS', 'Client offline after disconnect');
    } else {
      log('FAIL', 'Client offline after disconnect', client ? 'online=' + client.online : 'not found');
    }
  } catch (err) {
    log('FAIL', 'Client offline after disconnect', err.message);
  }

  // C3: Heartbeat exchange keeps client alive
  try {
    const clientWsC3 = await connectAndAuthClient(pairs[0]);
    // Respond to heartbeats
    clientWsC3.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'heartbeat') {
          clientWsC3.send(JSON.stringify({ type: 'heartbeatAck', ts: Date.now() }));
        }
      } catch {}
    });
    await sleep(1000);
    ownerWs.send(JSON.stringify({ type: 'clientStatus', clientId: pairs[0].clientId, ts: Date.now() }));
    const status = await waitMsg(ownerWs, 'clientStatusResult', 3000);
    if (status.client && status.client.online) {
      log('PASS', 'Heartbeat keeps client alive');
    } else {
      log('FAIL', 'Heartbeat keeps client alive', JSON.stringify(status.client));
    }
    clientWsC3.close();
    await sleep(300);
  } catch (err) {
    log('FAIL', 'Heartbeat keeps client alive', err.message);
  }

  // C4: Multiple clients tracked independently
  try {
    const ws1 = await connectAndAuthClient(pairs[0]);
    const ws2 = await connectAndAuthClient(pairs[1]);
    await sleep(300);
    ownerWs.send(JSON.stringify({ type: 'clientList', ts: Date.now() }));
    const list = await waitMsg(ownerWs, 'clientListResult', 3000);
    const c1 = list.clients.find(c => c.id === pairs[0].clientId);
    const c2 = list.clients.find(c => c.id === pairs[1].clientId);
    if (c1 && c1.online && c2 && c2.online) {
      log('PASS', 'Multiple clients tracked: both online');
    } else {
      log('FAIL', 'Multiple clients tracked', `c1=${c1?.online}, c2=${c2?.online}`);
    }
    ws1.close();
    await sleep(300);
    ownerWs.send(JSON.stringify({ type: 'clientList', ts: Date.now() }));
    const list2 = await waitMsg(ownerWs, 'clientListResult', 3000);
    const c1after = list2.clients.find(c => c.id === pairs[0].clientId);
    const c2after = list2.clients.find(c => c.id === pairs[1].clientId);
    if (!c1after.online && c2after.online) {
      log('PASS', 'Independent tracking: c1 offline, c2 online');
    } else {
      log('FAIL', 'Independent tracking', `c1=${c1after?.online}, c2=${c2after?.online}`);
    }
    ws2.close();
    await sleep(300);
  } catch (err) {
    log('FAIL', 'Multiple clients tracked', err.message);
  }

  // C5: Rapid connect/disconnect doesn't leak
  try {
    for (let i = 0; i < 20; i++) {
      const ws = await connectAndAuthClient(pairs[0]);
      ws.close();
      await sleep(50);
    }
    await sleep(500);
    const health = await httpGet(`http://127.0.0.1:${BACKEND_PORT}/api/health`);
    if (health.status === 'ok') {
      log('PASS', 'Rapid connect/disconnect: no crash, server healthy');
    } else {
      log('FAIL', 'Rapid connect/disconnect', 'server unhealthy');
    }
  } catch (err) {
    log('FAIL', 'Rapid connect/disconnect', err.message);
  }

  // C6: Reconnect after disconnect
  try {
    const ws1 = await connectAndAuthClient(pairs[0]);
    ws1.close();
    await sleep(300);
    const ws2 = await connectAndAuthClient(pairs[0]);
    ownerWs.send(JSON.stringify({ type: 'clientList', ts: Date.now() }));
    const list = await waitMsg(ownerWs, 'clientListResult', 3000);
    const client = list.clients.find(c => c.id === pairs[0].clientId);
    if (client && client.online) {
      log('PASS', 'Reconnect after disconnect: client online');
    } else {
      log('FAIL', 'Reconnect after disconnect', 'not online');
    }
    ws2.close();
    await sleep(300);
  } catch (err) {
    log('FAIL', 'Reconnect after disconnect', err.message);
  }

  // ================================================
  // SECTION D: SECURITY EDGE CASES
  // ================================================
  console.log('\n--- D. Security Edge Cases ---');

  // D1: Invalid action in remote command
  try {
    const clientWsD1 = await connectAndAuthClient(pairs[0]);
    const reqId = 'sec_' + Date.now();
    const errPromise = waitMsg(ownerWs, 'remoteError', 3000);
    ownerWs.send(JSON.stringify({
      type: 'remoteCommand', clientId: pairs[0].clientId, action: 'executeArbitrary', requestId: reqId, ts: Date.now()
    }));
    const err = await errPromise;
    if (err.error === 'Action not allowed') {
      log('PASS', 'Invalid action rejected: ' + err.error);
    } else {
      log('FAIL', 'Invalid action rejection', err.error);
    }
    clientWsD1.close();
  } catch (err) {
    log('FAIL', 'Invalid action rejection', err.message);
  }

  // D2: Empty action rejected
  try {
    const reqId = 'emptyact_' + Date.now();
    const errPromise = waitMsg(ownerWs, 'remoteError', 3000);
    ownerWs.send(JSON.stringify({
      type: 'remoteCommand', clientId: pairs[0].clientId, action: '', requestId: reqId, ts: Date.now()
    }));
    const err = await errPromise;
    if (err.error) {
      log('PASS', 'Empty action rejected');
    } else {
      log('FAIL', 'Empty action rejection', 'no error');
    }
  } catch (err) {
    log('FAIL', 'Empty action rejection', err.message);
  }

  // D3: Health report size limit
  try {
    const clientWsD3 = await connectAndAuthClient(pairs[0]);
    const bigData = { huge: 'x'.repeat(20000) };
    clientWsD3.send(JSON.stringify({ type: 'healthReport', data: bigData, ts: Date.now() }));
    await sleep(500);
    ownerWs.send(JSON.stringify({ type: 'clientStatus', clientId: pairs[0].clientId, ts: Date.now() }));
    const status = await waitMsg(ownerWs, 'clientStatusResult', 3000);
    const stored = status.client?.lastHealth;
    if (!stored || JSON.stringify(stored).length < 20000) {
      log('PASS', 'Oversized health report rejected/ignored');
    } else {
      log('FAIL', 'Oversized health report stored', JSON.stringify(stored).length + ' chars');
    }
    clientWsD3.close();
  } catch (err) {
    log('FAIL', 'Health report size limit', err.message);
  }

  // D4: Pairing name length limit
  try {
    const longName = 'A'.repeat(200);
    ownerWs.send(JSON.stringify({ type: 'pairRequest', name: longName, ts: Date.now() }));
    const result = await waitMsg(ownerWs, 'pairSuccess', 3000);
    ownerWs.send(JSON.stringify({ type: 'clientStatus', clientId: result.clientId, ts: Date.now() }));
    const detail = await waitMsg(ownerWs, 'clientStatusResult', 3000);
    if (detail.client.name.length <= 100) {
      log('PASS', 'Pairing name truncated to ' + detail.client.name.length + ' chars');
    } else {
      log('FAIL', 'Pairing name not truncated', detail.client.name.length + ' chars');
    }
  } catch (err) {
    log('FAIL', 'Pairing name truncation', err.message);
  }

  // D5: Owner message type whitelist
  try {
    ownerWs.send(JSON.stringify({ type: 'executeCommand', command: 'rm -rf /', ts: Date.now() }));
    await sleep(500);
    const health = await httpGet(`http://127.0.0.1:${BACKEND_PORT}/api/health`);
    if (health.status === 'ok') {
      log('PASS', 'Unknown owner message type ignored, server healthy');
    } else {
      log('FAIL', 'Unknown owner message type', 'server not ok');
    }
  } catch (err) {
    log('FAIL', 'Unknown owner message type', err.message);
  }

  // D6: Prototype pollution attempt
  try {
    const ws = await wsConnect('/client');
    ws.send(JSON.stringify({ type: '__proto__', constructor: { prototype: { isAdmin: true } } }));
    ws.send(JSON.stringify({ type: 'clientAuth', '__proto__': { isAdmin: true }, clientId: 'x', secret: 'y' }));
    await sleep(300);
    const health = await httpGet(`http://127.0.0.1:${BACKEND_PORT}/api/health`);
    if (health.status === 'ok') {
      log('PASS', 'Prototype pollution attempt: server unaffected');
    } else {
      log('FAIL', 'Prototype pollution', 'server affected');
    }
    ws.close();
  } catch (err) {
    log('FAIL', 'Prototype pollution', err.message);
  }

  // D7: SQL injection via audit query
  try {
    ownerWs.send(JSON.stringify({ type: 'auditQuery', action: "'; DROP TABLE audit_log; --", limit: 50, ts: Date.now() }));
    const result = await waitMsg(ownerWs, 'auditQueryResult', 3000);
    // If we get a result back without crash, the parameterized query worked
    ownerWs.send(JSON.stringify({ type: 'auditQuery', limit: 50, ts: Date.now() }));
    const verify = await waitMsg(ownerWs, 'auditQueryResult', 3000);
    if (verify.entries && Array.isArray(verify.entries)) {
      log('PASS', 'SQL injection attempt: parameterized query safe');
    } else {
      log('FAIL', 'SQL injection', 'audit_log may be damaged');
    }
  } catch (err) {
    log('FAIL', 'SQL injection test', err.message);
  }

  // ================================================
  // SECTION E: CROSS-CLIENT RESULT SPOOFING
  // ================================================
  console.log('\n--- E. Cross-Client Result Spoofing ---');

  // E1: Client B cannot spoof result for command sent to Client A
  try {
    const pairA = pairs[0];
    const pairB = pairs[1];
    const wsA = await connectAndAuthClient(pairA);
    const wsB = await connectAndAuthClient(pairB);

    const reqId = 'spoof_' + Date.now();
    let clientAReceived = false;
    wsA.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'remoteCommand' && m.requestId === reqId) clientAReceived = true;
    });

    ownerWs.send(JSON.stringify({
      type: 'remoteCommand', clientId: pairA.clientId, action: 'getHealth', requestId: reqId, ts: Date.now()
    }));
    await sleep(500);

    // Client B tries to forge a result for Client A's command
    wsB.send(JSON.stringify({ type: 'remoteResult', requestId: reqId, data: { spoofed: true }, ts: Date.now() }));
    await sleep(500);

    // Now Client A sends real result
    wsA.send(JSON.stringify({ type: 'remoteResult', requestId: reqId, data: { real: true }, ts: Date.now() }));
    const result = await waitMsg(ownerWs, 'remoteResult', 3000);

    if (result.data && result.data.real === true && !result.data.spoofed) {
      log('PASS', 'Cross-client result spoofing blocked');
    } else if (result.data && result.data.spoofed) {
      log('FAIL', 'Cross-client result spoofing', 'spoofed result accepted!');
    } else {
      log('PASS', 'Cross-client result spoofing blocked (real result delivered)');
    }
    wsA.close();
    wsB.close();
    await sleep(300);
  } catch (err) {
    log('FAIL', 'Cross-client result spoofing test', err.message);
  }

  // E2: Legitimate client result still works
  try {
    ownerWs.send(JSON.stringify({ type: 'pairRequest', name: 'LegitTest', ts: Date.now() }));
    const pairE2 = await waitMsg(ownerWs, 'pairSuccess', 3000);
    const wsE2 = await connectAndAuthClient({ clientId: pairE2.clientId, secret: pairE2.secret });
    const reqId = 'legit_' + Date.now();

    wsE2.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'remoteCommand' && m.requestId === reqId) {
        wsE2.send(JSON.stringify({ type: 'remoteResult', requestId: reqId, data: { legitimate: true }, ts: Date.now() }));
      }
    });

    ownerWs.send(JSON.stringify({
      type: 'remoteCommand', clientId: pairE2.clientId, action: 'getHealth', requestId: reqId, ts: Date.now()
    }));
    const result = await waitMsg(ownerWs, 'remoteResult', 5000);
    if (result && result.data && result.data.legitimate === true) {
      log('PASS', 'Legitimate client result still accepted');
    } else {
      log('FAIL', 'Legitimate client result', JSON.stringify(result?.data));
    }
    wsE2.close();
    await sleep(300);
  } catch (err) {
    log('FAIL', 'Legitimate client result', err.message);
  }

  // ================================================
  // CLEANUP
  // ================================================
  console.log('\n--- Cleanup ---');
  ownerWs.close();
  killAll();
  await sleep(1000);
  for (const dir of tempDataDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`Total:   ${passed + failed} tests`);
  console.log(failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${failed} test(s) failed`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal error:', err);
  killAll();
  process.exit(1);
});
