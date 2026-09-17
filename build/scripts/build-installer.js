'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// __dirname is build/scripts, so the repo root is two levels up.
const ROOT = path.join(__dirname, '..', '..');
const SRC_DIR = path.join(ROOT, 'src');
const DIST_DIR = path.join(ROOT, 'dist');
const RELEASE_DIR = path.join(ROOT, 'release');
const VERSION = require(path.join(ROOT, 'package.json')).version;

// CC/Owner metadata files copied from the repo root into each staged product.
const ROOT_METADATA_FILES = ['package.json', 'README.md', 'LICENSE.txt'];

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.claude',
  'owner', 'backend', 'shared'
]);

const EXCLUDE_FILES = new Set([
  '.env', '.env.local', '.env.production',
  '.gitignore', '.npmrc', '.eslintrc',
  'after-bench.js', 'fast-bench.js', 'perf-audit.js', 'ps-bench.js',
  'package-lock.json',
  'OVERNIGHT-ENGINEERING-REPORT.md',
  'ENGINEERING-REPORT.md'
]);

const EXCLUDE_PATTERNS = [
  /\.log$/i, /\.tmp$/i, /\.bak$/i, /\.swp$/i,
  /~$/, /\.orig$/i, /\.db$/i, /\.sqlite$/i
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
  /\/home\/[^/]+\//i
];

let issues = [];

function shouldExclude(name, isDir) {
  if (isDir && EXCLUDE_DIRS.has(name)) return true;
  if (!isDir && EXCLUDE_FILES.has(name)) return true;
  if (!isDir && EXCLUDE_PATTERNS.some(p => p.test(name))) return true;
  return false;
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (shouldExclude(entry.name, entry.isDirectory())) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function scanSecrets(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      scanSecrets(full);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (!['.js', '.json', '.html', '.bat', '.txt', '.md', '.css'].includes(ext)) continue;
      try {
        const content = fs.readFileSync(full, 'utf8');
        const rel = path.relative(DIST_DIR, full);
        for (const pat of SECRET_PATTERNS) {
          const m = content.match(pat);
          if (m) issues.push({ type: 'SECRET', file: rel, match: m[0].substring(0, 50) });
        }
        for (const pat of PERSONAL_PATTERNS) {
          const m = content.match(pat);
          if (m) issues.push({ type: 'PERSONAL', file: rel, match: m[0].substring(0, 50) });
        }
      } catch {}
    }
  }
}

// GIST_ID is not a secret (it's a public gist identifier the shipped app
// needs to check for updates on its own) — read it from the local,
// gitignored .env.release if present, so normal users never have to
// configure it themselves. Falls back to whatever ships in default.json
// (null) when no release config exists, e.g. for other forks/dev use.
function readReleaseGistId() {
  const envPath = path.join(ROOT, '.env.release');
  if (!fs.existsSync(envPath)) return null;
  const m = fs.readFileSync(envPath, 'utf8').match(/^GIST_ID=(.*)$/m);
  const value = m ? m[1].trim() : '';
  return value || null;
}

function cleanConfig(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  cfg.security.pinHash = null;
  cfg.security.trustedDevices = [];
  cfg.updates.gistId = readReleaseGistId();
  if (cfg.backend) {
    cfg.backend.clientId = null;
    cfg.backend.secret = null;
    cfg.backend.url = null;
  }
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

function buildProduct(name, srcDir, destDir, extraExcludes, rootMetadataFiles) {
  console.log(`\n--- Building ${name} ---`);

  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });

  console.log('  Copying files...');
  const prevExcludes = new Set(EXCLUDE_DIRS);
  if (extraExcludes) extraExcludes.forEach(e => EXCLUDE_DIRS.add(e));
  copyDir(srcDir, destDir);
  EXCLUDE_DIRS.clear();
  prevExcludes.forEach(e => EXCLUDE_DIRS.add(e));

  // package.json must land here before `npm install` runs below, otherwise
  // npm finds no manifest in destDir and silently no-ops instead of
  // installing dependencies (this is what SRC_DIR lacks for Control Center,
  // since its package.json lives at the repo root, not under src/).
  if (rootMetadataFiles) {
    for (const f of rootMetadataFiles) {
      const s = path.join(ROOT, f);
      if (fs.existsSync(s)) fs.copyFileSync(s, path.join(destDir, f));
    }
  }

  console.log('  Installing production dependencies...');
  try {
    execSync('npm install --omit=dev --ignore-scripts', { cwd: destDir, stdio: 'pipe' });
    const lockFile = path.join(destDir, 'package-lock.json');
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch (err) {
    console.log(`  Warning: npm install failed: ${err.message}`);
  }

  const cfgFile = path.join(destDir, 'config', 'default.json');
  if (fs.existsSync(cfgFile)) {
    console.log('  Cleaning config...');
    cleanConfig(cfgFile);
  }

  console.log('  Scanning for secrets...');
  const prevIssues = issues.length;
  scanSecrets(destDir);
  if (issues.length > prevIssues) {
    console.log(`  WARNING: ${issues.length - prevIssues} issues found!`);
  } else {
    console.log('  Clean.');
  }
}

// --- Main ---
console.log('VAMPJRO Release Builder');
console.log('=======================');
console.log(`Version: ${VERSION}\n`);

require(path.join(ROOT, 'tools', 'sync-version.js')).sync();

if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
if (!fs.existsSync(RELEASE_DIR)) fs.mkdirSync(RELEASE_DIR, { recursive: true });

// Build Control Center — staged from src/ so the shipped app keeps the same
// flat layout (server/, client/, config/, extension/) it always had; the
// dev-only src/ wrapper never appears inside the installed product.
const ccDist = path.join(DIST_DIR, 'control-center');
buildProduct(
  'Control Center',
  SRC_DIR,
  ccDist,
  null,
  ROOT_METADATA_FILES
);

// Copy shared protocol into CC dist (needed by backend-connector)
const ccSharedDest = path.join(ccDist, 'shared');
if (!fs.existsSync(ccSharedDest)) fs.mkdirSync(ccSharedDest, { recursive: true });
fs.copyFileSync(
  path.join(SRC_DIR, 'shared', 'protocol.js'),
  path.join(ccSharedDest, 'protocol.js')
);

// Create launcher bat — runtime data lives under %LOCALAPPDATA%\VAMPJRO\Data,
// never inside the app install folder, so updates/reinstalls never touch it.
fs.writeFileSync(path.join(ccDist, 'VAMPJRO.bat'),
  `@echo off\r\ntitle VAMPJRO Control Center\r\ncd /d "%~dp0"\r\nset "VAMPJRO_DATA_DIR=%LOCALAPPDATA%\\VAMPJRO\\Data\\ControlCenter"\r\nif not exist "%VAMPJRO_DATA_DIR%" mkdir "%VAMPJRO_DATA_DIR%"\r\nif exist runtime\\node.exe (\r\n  runtime\\node.exe --max-old-space-size=128 server/index.js\r\n) else (\r\n  node --max-old-space-size=128 server/index.js\r\n)\r\n`,
  'utf8');

// Build Control Owner
const ownerSrc = path.join(SRC_DIR, 'owner');
if (fs.existsSync(ownerSrc)) {
  const ownerDist = path.join(DIST_DIR, 'control-owner');
  const ownerSubdir = path.join(ownerDist, 'owner');
  // Wipe the whole product dir first: buildProduct() only cleans its own
  // destDir (ownerSubdir), so stale top-level leftovers from older build
  // layouts would otherwise survive and get swept into the installer.
  if (fs.existsSync(ownerDist)) fs.rmSync(ownerDist, { recursive: true, force: true });
  buildProduct(
    'Control Owner',
    ownerSrc,
    ownerSubdir
  );

  // Copy shared protocol (owner/server/index.js requires ../../shared/protocol)
  const sharedDest = path.join(ownerDist, 'shared');
  if (!fs.existsSync(sharedDest)) fs.mkdirSync(sharedDest, { recursive: true });
  fs.copyFileSync(
    path.join(SRC_DIR, 'shared', 'protocol.js'),
    path.join(sharedDest, 'protocol.js')
  );

  fs.writeFileSync(path.join(ownerDist, 'VAMPJRO-Owner.bat'),
    `@echo off\r\ntitle VAMPJRO Control Owner\r\ncd /d "%~dp0"\r\nif not exist "%LOCALAPPDATA%\\VAMPJRO\\Data\\Owner" mkdir "%LOCALAPPDATA%\\VAMPJRO\\Data\\Owner"\r\nif exist runtime\\node.exe (\r\n  runtime\\node.exe owner/server/index.js\r\n) else (\r\n  node owner/server/index.js\r\n)\r\n`,
    'utf8');
}

// Check for issues
if (issues.length > 0) {
  console.log('\n=== ISSUES FOUND ===');
  for (const issue of issues) {
    console.log(`  [${issue.type}] ${issue.file}: ${issue.match}`);
  }
  console.log('\nBuild blocked. Fix issues above first.');
  process.exit(1);
}

// Generate SHA-256 manifest
console.log('\nGenerating checksums...');
function hashDir(dir, base) {
  const hashes = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      Object.assign(hashes, hashDir(full, rel));
    } else {
      hashes[rel.replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  }
  return hashes;
}

const manifest = {
  version: VERSION,
  buildDate: new Date().toISOString(),
  products: {
    controlCenter: { files: hashDir(path.join(DIST_DIR, 'control-center'), '') },
    controlOwner: fs.existsSync(path.join(DIST_DIR, 'control-owner'))
      ? { files: hashDir(path.join(DIST_DIR, 'control-owner'), '') }
      : null
  }
};
fs.writeFileSync(path.join(DIST_DIR, 'release-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

// Try to build installers with Inno Setup
const isccPaths = [
  'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
  'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'Inno Setup 6', 'ISCC.exe')
];

let iscc = null;
for (const p of isccPaths) {
  if (fs.existsSync(p)) { iscc = p; break; }
}

if (iscc) {
  console.log('\nBuilding installers with Inno Setup...');
  try {
    execSync(`"${iscc}" "/DAppVersion=${VERSION}" "${path.join(ROOT, 'build', 'installers', 'control-center.iss')}"`, { stdio: 'inherit' });
    console.log('  Control Center installer built.');
  } catch (err) {
    console.log(`  Control Center installer failed: ${err.message}`);
  }
  try {
    execSync(`"${iscc}" "/DAppVersion=${VERSION}" "${path.join(ROOT, 'build', 'installers', 'control-owner.iss')}"`, { stdio: 'inherit' });
    console.log('  Control Owner installer built.');
  } catch (err) {
    console.log(`  Control Owner installer failed: ${err.message}`);
  }
} else {
  console.log('\nInno Setup not found. Install from https://jrsoftware.org/isinfo.php');
  console.log('Then run ISCC.exe on the .iss files in build/installers/ to build .exe installers.');
}

console.log(`\nBuild complete.`);
console.log(`  dist/control-center/        — Control Center staging (build-time only)`);
console.log(`  dist/control-owner/         — Control Owner staging (build-time only)`);
console.log(`  dist/release-manifest.json  — SHA-256 checksums`);
console.log(`  release/VAMPJRO Build.exe        — final Control Center installer`);
console.log(`  release/VAMPJRO Build Owner.exe  — final Control Owner installer`);
