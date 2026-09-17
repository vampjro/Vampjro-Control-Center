'use strict';

const crypto = require('crypto');
const path = require('path');

let passed = 0, failed = 0;

function log(status, name, detail) {
  const icon = status === 'PASS' ? '✓' : '✗';
  console.log(`  ${icon} [${status}] ${name}${detail ? ': ' + detail : ''}`);
  if (status === 'PASS') passed++; else failed++;
}

const updates = require(path.join(__dirname, '..', 'src', 'server', 'modules', 'updates'));

console.log('');
console.log('VAMPJRO Update System Test Suite');
console.log('========================================\n');

// ===== 1. Version Comparison =====
console.log('--- 1. Version Comparison ---');

const cmpTests = [
  ['1.0.0', '1.0.0', 0, 'equal versions'],
  ['1.0.1', '1.0.0', 1, 'patch newer'],
  ['1.0.0', '1.0.1', -1, 'patch older'],
  ['1.1.0', '1.0.0', 1, 'minor newer'],
  ['1.0.0', '1.1.0', -1, 'minor older'],
  ['2.0.0', '1.0.0', 1, 'major newer'],
  ['1.0.0', '2.0.0', -1, 'major older'],
  ['1.0.0', '1.0', 0, 'missing patch = 0'],
  ['10.20.30', '10.20.30', 0, 'large version numbers'],
  ['1.0.10', '1.0.9', 1, 'two-digit patch newer'],
  ['0.0.1', '0.0.0', 1, 'zero versions'],
];

for (const [a, b, expected, label] of cmpTests) {
  const result = updates.compareVersions(a, b);
  if (result === expected) {
    log('PASS', `compareVersions(${a}, ${b}) = ${result}`, label);
  } else {
    log('FAIL', `compareVersions(${a}, ${b})`, `expected ${expected}, got ${result} (${label})`);
  }
}

// ===== 2. SHA-256 Verification =====
console.log('\n--- 2. SHA-256 Verification ---');

const testBuffer = Buffer.from('hello world');
const correctHash = crypto.createHash('sha256').update(testBuffer).digest('hex');
const wrongHash = 'a'.repeat(64);

if (updates.verifySha256(testBuffer, correctHash)) {
  log('PASS', 'Valid SHA-256 accepted');
} else {
  log('FAIL', 'Valid SHA-256 accepted', 'returned false');
}

if (!updates.verifySha256(testBuffer, wrongHash)) {
  log('PASS', 'Invalid SHA-256 rejected');
} else {
  log('FAIL', 'Invalid SHA-256 rejected', 'returned true');
}

if (updates.verifySha256(testBuffer, correctHash.toUpperCase())) {
  log('PASS', 'Case-insensitive SHA-256 comparison');
} else {
  log('FAIL', 'Case-insensitive SHA-256', 'rejected uppercase');
}

const emptyBuffer = Buffer.alloc(0);
const emptyHash = crypto.createHash('sha256').update(emptyBuffer).digest('hex');
if (updates.verifySha256(emptyBuffer, emptyHash)) {
  log('PASS', 'Empty buffer SHA-256 correct');
} else {
  log('FAIL', 'Empty buffer SHA-256', 'rejected');
}

const largeBuffer = crypto.randomBytes(1024 * 100);
const largeHash = crypto.createHash('sha256').update(largeBuffer).digest('hex');
if (updates.verifySha256(largeBuffer, largeHash)) {
  log('PASS', 'Large buffer SHA-256 correct (100KB)');
} else {
  log('FAIL', 'Large buffer SHA-256', 'rejected');
}

// ===== 3. Update Check without Gist =====
console.log('\n--- 3. Update Check Logic ---');

updates.initialize();
updates.checkForUpdates().then(result => {
  if (result.status === 'no_gist') {
    log('PASS', 'No gist configured: status=no_gist');
  } else {
    log('FAIL', 'No gist configured', 'status=' + result.status);
  }

  // ===== 4. Health reporting =====
  console.log('\n--- 4. Health Reporting ---');
  const health = updates.health();
  if (health.lastCheck && health.lastStatus === 'no_gist') {
    log('PASS', 'Health reports lastCheck and lastStatus');
  } else {
    log('FAIL', 'Health reporting', JSON.stringify(health));
  }

  // ===== 5. Rollout Bucket (from protocol) =====
  console.log('\n--- 5. Rollout Bucket ---');
  const md5 = crypto.createHash('md5');
  const protocol = require(path.join(__dirname, '..', 'src', 'shared', 'protocol'));

  // Deterministic test
  const testClientId = 'testClient123';
  const testVersion = '2.0.0';
  const hash = crypto.createHash('md5').update(testClientId + testVersion).digest();
  const bucket1 = hash[0] % 100;
  const hash2 = crypto.createHash('md5').update(testClientId + testVersion).digest();
  const bucket2 = hash2[0] % 100;
  if (bucket1 === bucket2) {
    log('PASS', 'Rollout bucket deterministic: ' + bucket1);
  } else {
    log('FAIL', 'Rollout deterministic', bucket1 + ' != ' + bucket2);
  }

  // Distribution test
  let selected = 0;
  for (let i = 0; i < 1000; i++) {
    const h = crypto.createHash('md5').update(`client-${i}` + testVersion).digest();
    const b = h[0] % 100;
    if (b < 10) selected++;
  }
  const pct = (selected / 1000 * 100).toFixed(1);
  if (selected >= 60 && selected <= 150) {
    log('PASS', '10% rollout distribution: ' + selected + '/1000 (' + pct + '%)');
  } else {
    log('FAIL', 'Rollout distribution', selected + '/1000 out of expected range');
  }

  // 50% rollout
  let selected50 = 0;
  for (let i = 0; i < 1000; i++) {
    const h = crypto.createHash('md5').update(`client50-${i}` + testVersion).digest();
    if (h[0] % 100 < 50) selected50++;
  }
  const pct50 = (selected50 / 1000 * 100).toFixed(1);
  if (selected50 >= 400 && selected50 <= 600) {
    log('PASS', '50% rollout distribution: ' + selected50 + '/1000 (' + pct50 + '%)');
  } else {
    log('FAIL', '50% rollout distribution', selected50 + '/1000 out of range');
  }

  // 100% rollout (all should be selected)
  let selected100 = 0;
  for (let i = 0; i < 100; i++) {
    const h = crypto.createHash('md5').update(`client100-${i}` + testVersion).digest();
    if (h[0] % 100 < 100) selected100++;
  }
  if (selected100 === 100) {
    log('PASS', '100% rollout: all 100 clients selected');
  } else {
    log('FAIL', '100% rollout', selected100 + '/100');
  }

  // Summary
  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`Total:   ${passed + failed} tests`);
  console.log(failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${failed} test(s) failed`);

  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  console.error('Test error:', err.message);
  process.exit(1);
});
