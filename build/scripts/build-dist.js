const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// Legacy pre-installer ZIP builder, superseded by build-installer.js.
// __dirname is now build/scripts, so root is two levels up.
const ROOT = path.join(__dirname, '..', '..');
const DIST_DIR = path.join(ROOT, 'archive', 'DISTRIBUZIONE');
const DIST_APP = path.join(DIST_DIR, 'VAMPJRO-Remote-Control-Center');

const EXCLUDE_DIRS = new Set([
  'node_modules', 'local-data', '.git', '.claude', 'archive',
  'docs', 'scripts', '.vscode', '.idea'
]);

const EXCLUDE_FILES = new Set([
  '.env', '.env.local', '.env.production',
  '.gitignore', '.npmrc', '.eslintrc',
  'after-bench.js', 'fast-bench.js', 'perf-audit.js', 'ps-bench.js',
  'package-lock.json'
]);

const EXCLUDE_PATTERNS = [
  /\.log$/i, /\.tmp$/i, /\.bak$/i, /\.swp$/i,
  /~$/, /\.orig$/i, /\.db$/i, /\.sqlite$/i,
  /thumbs\.db$/i, /desktop\.ini$/i, /\.ds_store$/i
];

const SECRET_PATTERNS = [
  // Matches an actual hardcoded value, not just the bare env-var name
  // (which legitimately appears in code that reads/writes that env var).
  /GITHUB_TOKEN\s*[:=]\s*['"][^'"]+['"]/i,
  /gh[oprsu]_[a-zA-Z0-9]{36,}/, /github_pat_[a-zA-Z0-9_]{20,}/,
  /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i,
  /password\s*[:=]\s*['"][^'"]+['"]/i,
  /secret\s*[:=]\s*['"][^'"]+['"]/i,
  /Bearer\s+[a-zA-Z0-9._\-]+/,
  /sk-[a-zA-Z0-9]{32,}/,
  /-----BEGIN.*PRIVATE KEY-----/
];

const PERSONAL_PATTERNS = [
  /C:\\Users\\[^\\]+\\/i,
  /\/home\/[^/]+\//i,
  /diegomia/i,
  /hostname.*diego/i
];

let issues = [];
let fileCount = 0;

function shouldExclude(name, isDir) {
  if (isDir && EXCLUDE_DIRS.has(name)) return true;
  if (!isDir && EXCLUDE_FILES.has(name)) return true;
  if (!isDir && EXCLUDE_PATTERNS.some(p => p.test(name))) return true;
  return false;
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldExclude(entry.name, entry.isDirectory())) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      fileCount++;
    }
  }
}

function scanSecrets(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      scanSecrets(full);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (!['.js', '.json', '.html', '.bat', '.txt', '.md', '.css'].includes(ext)) continue;
      try {
        const content = fs.readFileSync(full, 'utf8');
        const relPath = path.relative(DIST_APP, full);
        for (const pat of SECRET_PATTERNS) {
          const match = content.match(pat);
          if (match) {
            issues.push({ type: 'SECRET', file: relPath, match: match[0].substring(0, 50) });
          }
        }
        for (const pat of PERSONAL_PATTERNS) {
          const match = content.match(pat);
          if (match) {
            issues.push({ type: 'PERSONAL', file: relPath, match: match[0].substring(0, 50) });
          }
        }
      } catch {}
    }
  }
}

function generateHashes(dir, base) {
  const hashes = {};
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      Object.assign(hashes, generateHashes(full, rel));
    } else {
      const buf = fs.readFileSync(full);
      hashes[rel.replace(/\\/g, '/')] = crypto.createHash('sha256').update(buf).digest('hex');
    }
  }
  return hashes;
}

function createDefaultConfig() {
  const configDir = path.join(DIST_APP, 'config');
  const defaultConfig = JSON.parse(fs.readFileSync(path.join(configDir, 'default.json'), 'utf8'));
  defaultConfig.security.pinHash = null;
  defaultConfig.security.trustedDevices = [];
  defaultConfig.updates.gistId = null;
  fs.writeFileSync(path.join(configDir, 'default.json'), JSON.stringify(defaultConfig, null, 2), 'utf8');
}

console.log('VAMPJRO Distribution Builder');
console.log('============================\n');

if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  console.log('Cleaned previous distribution.');
}

console.log('1. Copying files...');
copyDir(ROOT, DIST_APP);

console.log('2. Installing production dependencies...');
execSync('npm install --omit=dev --ignore-scripts', { cwd: DIST_APP, stdio: 'pipe' });

const distLockFile = path.join(DIST_APP, 'package-lock.json');
if (fs.existsSync(distLockFile)) fs.unlinkSync(distLockFile);

console.log('3. Ensuring clean config...');
createDefaultConfig();

console.log('4. Scanning for secrets and personal data...');
scanSecrets(DIST_APP);

if (issues.length > 0) {
  console.log('\n⚠ ISSUES FOUND:');
  for (const issue of issues) {
    console.log(`  [${issue.type}] ${issue.file}: ${issue.match}`);
  }
  console.log('\n❌ Distribution blocked. Fix issues above first.');
  process.exit(1);
}
console.log('   No secrets or personal data found.');

console.log('5. Generating SHA-256 manifest...');
const hashes = generateHashes(DIST_APP, '');
const manifest = {
  product: 'VAMPJRO Remote Control Center',
  version: JSON.parse(fs.readFileSync(path.join(DIST_APP, 'package.json'), 'utf8')).version || '1.0.0',
  buildDate: new Date().toISOString(),
  fileCount,
  files: hashes
};
fs.writeFileSync(path.join(DIST_DIR, 'SHA256SUMS.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`   ${Object.keys(hashes).length} files hashed.`);

console.log('6. Creating ZIP...');
const zipName = `VAMPJRO-v${manifest.version}.zip`;
try {
  execSync(`powershell -Command "Compress-Archive -Path '${DIST_APP}' -DestinationPath '${path.join(DIST_DIR, zipName)}' -Force"`, { stdio: 'pipe' });
  const zipPath = path.join(DIST_DIR, zipName);
  const zipBuf = fs.readFileSync(zipPath);
  const zipHash = crypto.createHash('sha256').update(zipBuf).digest('hex');
  const zipSize = (zipBuf.length / 1024 / 1024).toFixed(2);
  console.log(`   ${zipName} (${zipSize} MB)`);
  console.log(`   SHA-256: ${zipHash}`);
  fs.writeFileSync(path.join(DIST_DIR, `${zipName}.sha256`), `${zipHash}  ${zipName}\n`, 'utf8');
} catch (err) {
  console.log(`   ZIP creation failed: ${err.message}`);
}

console.log('\n✓ Distribution ready at: DISTRIBUZIONE/');
console.log(`  Files: ${fileCount}`);
console.log(`  Version: ${manifest.version}`);
