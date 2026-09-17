'use strict';

const http = require('http');
const WebSocket = require('ws');

const CC_PORT = 3000;
const ITERATIONS = 50;

const results = {};

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ data: JSON.parse(data), ms: Date.now() - start }));
    }).on('error', reject);
  });
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const ws = new WebSocket(`ws://localhost:${CC_PORT}`);
    ws.on('open', () => resolve({ ws, ms: Date.now() - start }));
    ws.on('error', reject);
  });
}

function wsRoundtrip(ws, msg) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const handler = (raw) => {
      try {
        const data = JSON.parse(raw);
        if (data.requestId === msg.requestId || data.type === 'needAuth' || data.type === 'needSetup') {
          ws.removeListener('message', handler);
          resolve({ data, ms: Date.now() - start });
        }
      } catch {}
    };
    ws.on('message', handler);
    ws.send(JSON.stringify(msg));
    setTimeout(() => reject(new Error('Timeout')), 10000);
  });
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stat(label, times) {
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  results[label] = {
    avg: Math.round(avg * 100) / 100,
    min: Math.min(...times),
    max: Math.max(...times),
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    p99: percentile(times, 99)
  };
  console.log(`  ${label}: avg=${results[label].avg}ms min=${results[label].min}ms max=${results[label].max}ms p95=${results[label].p95}ms`);
}

async function run() {
  console.log('');
  console.log('VAMPJRO Control Center Performance Test');
  console.log('========================================');
  console.log(`Target: http://localhost:${CC_PORT}`);
  console.log(`Iterations: ${ITERATIONS}`);
  console.log('');

  // 1. HTTP health endpoint
  console.log('--- HTTP Endpoints ---');
  const healthTimes = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const { ms } = await httpGet(`http://localhost:${CC_PORT}/api/health`);
    healthTimes.push(ms);
  }
  stat('GET /api/health', healthTimes);

  // 2. WebSocket connect time
  console.log('');
  console.log('--- WebSocket ---');
  const wsTimes = [];
  const sockets = [];
  for (let i = 0; i < 20; i++) {
    const { ws, ms } = await connectWs();
    wsTimes.push(ms);
    sockets.push(ws);
  }
  stat('WS connect', wsTimes);

  // Close test sockets
  for (const ws of sockets) ws.close();

  // 3. WebSocket message roundtrip (auth attempt — will fail but measures roundtrip)
  const { ws: testWs } = await connectWs();
  // Wait for initial message
  await new Promise(r => {
    testWs.once('message', () => r());
  });

  const authTimes = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const { ms } = await wsRoundtrip(testWs, { type: 'auth', pin: '9999', requestId: i + 1 });
    authTimes.push(ms);
  }
  stat('WS auth roundtrip', authTimes);
  testWs.close();

  // 4. Concurrent HTTP requests
  console.log('');
  console.log('--- Concurrent Load ---');
  const concurrentStart = Date.now();
  const concurrent = await Promise.all(
    Array.from({ length: 50 }, () => httpGet(`http://localhost:${CC_PORT}/api/health`))
  );
  const concurrentMs = Date.now() - concurrentStart;
  console.log(`  50 concurrent /api/health: ${concurrentMs}ms total, avg=${Math.round(concurrent.reduce((a, b) => a + b.ms, 0) / 50)}ms each`);

  // 5. Memory snapshot
  console.log('');
  console.log('--- Server Health ---');
  const health = await httpGet(`http://localhost:${CC_PORT}/api/health`);
  console.log(`  Server uptime: ${health.data.uptime}s`);
  console.log(`  Test process heap: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);

  // Summary
  console.log('');
  console.log('========================================');
  console.log('PERFORMANCE SUMMARY');
  console.log('========================================');

  let pass = true;
  for (const [label, r] of Object.entries(results)) {
    const ok = r.p95 < 200;
    console.log(`  ${ok ? 'PASS' : 'WARN'} ${label}: p95=${r.p95}ms`);
    if (r.p95 > 500) pass = false;
  }

  console.log('');
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL — some operations exceed 500ms p95');
  console.log('');
}

run().catch(err => {
  console.error('Performance test error:', err.message);
  process.exit(1);
});
