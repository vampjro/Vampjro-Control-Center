'use strict';
// One-button release pipeline: validate -> test -> build -> package -> hash
// -> tag -> GitHub Release -> upload asset -> verify -> update Gist -> verify.
// Every network step checks current state before acting (get-or-create,
// get-or-upload) so re-running a failed/partial release is always safe —
// that's how this satisfies "retry without creating a duplicate release"
// instead of a separate resume/state-machine.
//
// This module only runs from a full clone of the repo in developer context
// (it needs tests/, build/, and .env.release) — never from an installed,
// distributed EXE. The Owner UI is responsible for hiding the Release
// Manager section when those prerequisites aren't present.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env.release');
const HISTORY_PATH = path.join(ROOT, 'local-data', 'release-history.json');

// Fast correctness suites only. stability-test.js/load-test.js/perf-test.js
// are multi-minute soak/perf tests, not release gates — they're for
// deliberate manual runs, not a click-and-wait publish flow.
const RELEASE_TEST_FILES = [
  'feature-test.js',
  'integration-test.js',
  'security-adversarial-test.js',
  'resilience-test.js',
  'db-persistence-test.js',
  'update-test.js'
];

// ---------- .env.release ----------

function loadReleaseConfig() {
  if (!fs.existsSync(ENV_PATH)) {
    return { GITHUB_TOKEN: '', GITHUB_OWNER: '', GITHUB_REPOSITORY: '', GITHUB_REPO_VISIBILITY: 'public', GIST_ID: '' };
  }
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  const cfg = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) cfg[m[1]] = m[2].trim();
  }
  return cfg;
}

// Only touches known keys; preserves comments and formatting of the file.
function saveReleaseConfig(partial) {
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  for (const [key, value] of Object.entries(partial)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) {
      text = text.replace(re, `${key}=${value}`);
    } else {
      text += `\n${key}=${value}`;
    }
  }
  fs.writeFileSync(ENV_PATH, text, 'utf8');
}

function maskedConfig() {
  const cfg = loadReleaseConfig();
  return {
    githubOwner: cfg.GITHUB_OWNER || '',
    githubRepository: cfg.GITHUB_REPOSITORY || '',
    githubRepoVisibility: cfg.GITHUB_REPO_VISIBILITY || 'public',
    gistId: cfg.GIST_ID || '',
    hasToken: !!cfg.GITHUB_TOKEN
  };
}

// ---------- GitHub API ----------

function githubRequest(token, method, apiPath, body, hostname) {
  return new Promise((resolve, reject) => {
    const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) : null;
    const req = https.request({
      hostname: hostname || 'api.github.com',
      path: apiPath,
      method,
      headers: Object.assign({
        'Authorization': 'Bearer ' + token,
        'User-Agent': 'vampjro-release-pipeline',
        'Accept': 'application/vnd.github+json'
      }, data ? {
        'Content-Type': body && body.__contentType ? body.__contentType : 'application/json',
        'Content-Length': data.length
      } : {})
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary or empty */ }
        resolve({ status: res.statusCode, json, buffer: buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// ---------- Steps ----------

async function stepValidateConnection(cfg) {
  if (!cfg.GITHUB_TOKEN) return { ok: false, message: 'Nessun token configurato.' };
  const user = await githubRequest(cfg.GITHUB_TOKEN, 'GET', '/user');
  if (user.status !== 200) return { ok: false, message: `Token non valido (HTTP ${user.status}).` };
  if (!cfg.GITHUB_OWNER || !cfg.GITHUB_REPOSITORY) return { ok: false, message: 'Owner/repository non configurati.' };
  const repo = await githubRequest(cfg.GITHUB_TOKEN, 'GET', `/repos/${cfg.GITHUB_OWNER}/${cfg.GITHUB_REPOSITORY}`);
  if (repo.status !== 200) return { ok: false, message: `Repository non trovata (HTTP ${repo.status}).` };
  if (!cfg.GIST_ID) return { ok: false, message: 'Gist non configurato.' };
  const gist = await githubRequest(cfg.GITHUB_TOKEN, 'GET', `/gists/${cfg.GIST_ID}`);
  if (gist.status !== 200) return { ok: false, message: `Gist non raggiungibile (HTTP ${gist.status}).` };
  return {
    ok: true,
    message: 'Connessione verificata.',
    data: { login: user.json.login, repoUrl: repo.json.html_url, repoPrivate: repo.json.private, gistUrl: gist.json.html_url }
  };
}

function readCurrentVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

async function stepValidateVersion(cfg, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return { ok: false, message: `Formato versione non valido: "${version}" (atteso X.Y.Z).` };
  }
  const currentVersion = readCurrentVersion();
  if (compareVersions(version, currentVersion) <= 0) {
    return { ok: false, message: `La versione ${version} non è successiva alla corrente ${currentVersion}.` };
  }
  const existing = await githubRequest(cfg.GITHUB_TOKEN, 'GET', `/repos/${cfg.GITHUB_OWNER}/${cfg.GITHUB_REPOSITORY}/releases/tags/v${version}`);
  if (existing.status === 200) {
    return { ok: false, message: `Esiste già una release v${version} su GitHub.` };
  }
  return { ok: true, message: `Versione ${version} valida (corrente: ${currentVersion}).` };
}

function runTests() {
  const results = [];
  for (const file of RELEASE_TEST_FILES) {
    const full = path.join(ROOT, 'tests', file);
    try {
      execFileSync(process.execPath, [full], { cwd: ROOT, stdio: 'pipe', timeout: 120000 });
      results.push({ file, ok: true });
    } catch (err) {
      results.push({ file, ok: false, output: (err.stdout || '').toString().slice(-2000) });
    }
  }
  return results;
}

async function stepRunTests() {
  const results = runTests();
  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    return { ok: false, message: `${failed.length}/${results.length} suite fallite: ${failed.map(f => f.file).join(', ')}`, data: results };
  }
  return { ok: true, message: `${results.length}/${results.length} suite di test superate.`, data: results };
}

function stepBumpVersion(version) {
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  delete require.cache[require.resolve(path.join(ROOT, 'tools', 'sync-version.js'))];
  require(path.join(ROOT, 'tools', 'sync-version.js')).sync();
  return { ok: true, message: `package.json e file dipendenti aggiornati a ${version}.` };
}

function stepBuild() {
  const distDir = path.join(ROOT, 'dist');
  const releaseDir = path.join(ROOT, 'release');
  if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true, force: true });
  if (fs.existsSync(releaseDir)) fs.rmSync(releaseDir, { recursive: true, force: true });
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'build', 'scripts', 'build-installer.js')], { cwd: ROOT, stdio: 'pipe', timeout: 300000 });
  } catch (err) {
    return { ok: false, message: `Build fallita: ${err.message}`, data: (err.stdout || '').toString().slice(-2000) };
  }
  const exePath = path.join(releaseDir, 'VAMPJRO Build.exe');
  if (!fs.existsSync(exePath)) {
    return { ok: false, message: 'Build completata ma release/VAMPJRO Build.exe non trovato.' };
  }
  return { ok: true, message: 'Build e packaging completati.', data: { exePath } };
}

function stepHash(exePath) {
  const hash = sha256File(exePath);
  return { ok: true, message: `SHA-256: ${hash}`, data: { hash, size: fs.statSync(exePath).size } };
}

function gitPush(cfg, refspec) {
  const remoteUrl = `https://x-access-token:${cfg.GITHUB_TOKEN}@github.com/${cfg.GITHUB_OWNER}/${cfg.GITHUB_REPOSITORY}.git`;
  execFileSync('git', ['-c', 'credential.helper=', 'push', remoteUrl, refspec], { cwd: ROOT, stdio: 'pipe' });
}

function stepTagAndPush(cfg, version) {
  try {
    execFileSync('git', ['add', 'package.json', 'src/config/default.json', 'src/owner/package.json'], { cwd: ROOT, stdio: 'pipe' });
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: ROOT }).toString().trim();
    if (staged) {
      execFileSync('git', ['commit', '-m', `Release v${version}`], { cwd: ROOT, stdio: 'pipe' });
    }
    const tagExists = (() => {
      try { execFileSync('git', ['rev-parse', `v${version}`], { cwd: ROOT, stdio: 'pipe' }); return true; }
      catch { return false; }
    })();
    if (!tagExists) {
      execFileSync('git', ['tag', '-a', `v${version}`, '-m', `Release v${version}`], { cwd: ROOT, stdio: 'pipe' });
    }
    gitPush(cfg, 'HEAD:main');
    gitPush(cfg, `v${version}`);
    return { ok: true, message: `Tag v${version} creato e pushato.` };
  } catch (err) {
    return { ok: false, message: `Git tag/push fallito: ${err.message}` };
  }
}

async function stepCreateRelease(cfg, version, releaseNotes) {
  const existing = await githubRequest(cfg.GITHUB_TOKEN, 'GET', `/repos/${cfg.GITHUB_OWNER}/${cfg.GITHUB_REPOSITORY}/releases/tags/v${version}`);
  if (existing.status === 200) {
    return { ok: true, message: 'Release già esistente, riutilizzata.', data: existing.json };
  }
  const created = await githubRequest(cfg.GITHUB_TOKEN, 'POST', `/repos/${cfg.GITHUB_OWNER}/${cfg.GITHUB_REPOSITORY}/releases`, {
    tag_name: `v${version}`,
    name: `VAMPJRO v${version}`,
    body: releaseNotes || '',
    draft: false,
    prerelease: false
  });
  if (created.status !== 201) {
    return { ok: false, message: `Creazione release fallita (HTTP ${created.status}): ${created.json && created.json.message}` };
  }
  return { ok: true, message: 'Release GitHub creata.', data: created.json };
}

async function stepUploadAsset(cfg, release, exePath) {
  const assetName = 'VAMPJRO-Build.exe';
  const existingAsset = (release.assets || []).find(a => a.name === assetName);
  if (existingAsset) {
    const del = await githubRequest(cfg.GITHUB_TOKEN, 'DELETE', `/repos/${cfg.GITHUB_OWNER}/${cfg.GITHUB_REPOSITORY}/releases/assets/${existingAsset.id}`);
    if (del.status !== 204) {
      return { ok: false, message: `Impossibile sostituire asset esistente (HTTP ${del.status}).` };
    }
  }
  const uploadUrlTemplate = release.upload_url; // e.g. https://uploads.github.com/repos/.../assets{?name,label}
  const uploadHost = 'uploads.github.com';
  const uploadPath = uploadUrlTemplate
    .replace(/^https:\/\/uploads\.github\.com/, '')
    .replace(/\{.*\}$/, '') + `?name=${encodeURIComponent(assetName)}`;
  const fileBuffer = fs.readFileSync(exePath);
  fileBuffer.__contentType = 'application/octet-stream';
  const uploaded = await githubRequest(cfg.GITHUB_TOKEN, 'POST', uploadPath, fileBuffer, uploadHost);
  if (uploaded.status !== 201) {
    return { ok: false, message: `Upload asset fallito (HTTP ${uploaded.status}): ${uploaded.json && uploaded.json.message}` };
  }
  return { ok: true, message: 'Asset caricato sulla release.', data: uploaded.json };
}

async function stepVerifyAsset(cfg, asset, expectedHash) {
  // asset.url with Accept: application/octet-stream triggers a redirect to the CDN; follow manually.
  return new Promise((resolve) => {
    https.get(asset.url, {
      headers: { 'Authorization': 'Bearer ' + cfg.GITHUB_TOKEN, 'Accept': 'application/octet-stream', 'User-Agent': 'vampjro-release-pipeline' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, res2 => {
          const chunks = [];
          res2.on('data', c => chunks.push(c));
          res2.on('end', () => {
            const hash = crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
            resolve(hash === expectedHash
              ? { ok: true, message: 'Asset verificato: SHA-256 corrisponde.' }
              : { ok: false, message: `Hash asset non corrisponde (atteso ${expectedHash}, ottenuto ${hash}).` });
          });
        }).on('error', e => resolve({ ok: false, message: `Verifica fallita: ${e.message}` }));
      } else {
        resolve({ ok: false, message: `Verifica fallita: risposta HTTP ${res.statusCode} senza redirect.` });
      }
    }).on('error', e => resolve({ ok: false, message: `Verifica fallita: ${e.message}` }));
  });
}

async function stepUpdateGist(cfg, version, releaseNotes, release, asset, hash) {
  const manifest = {
    schemaVersion: 1,
    version,
    minimumVersion: null,
    channel: 'stable',
    releaseNotes: releaseNotes || '',
    releaseDate: new Date().toISOString(),
    packageUrl: asset.browser_download_url,
    sha256: hash
  };
  const res = await githubRequest(cfg.GITHUB_TOKEN, 'PATCH', `/gists/${cfg.GIST_ID}`, {
    files: { 'vampjro-updates.json': { content: JSON.stringify(manifest, null, 2) } }
  });
  if (res.status !== 200) {
    return { ok: false, message: `Aggiornamento Gist fallito (HTTP ${res.status}).` };
  }
  return { ok: true, message: 'Gist aggiornato.', data: manifest };
}

async function stepVerifyGist(cfg, version, hash) {
  const res = await githubRequest(null, 'GET', `/gists/${cfg.GIST_ID}`);
  if (res.status !== 200) return { ok: false, message: `Verifica Gist fallita (HTTP ${res.status}).` };
  try {
    const content = JSON.parse(res.json.files['vampjro-updates.json'].content);
    if (content.version !== version) return { ok: false, message: `Gist non aggiornato: versione ${content.version}.` };
    if (content.sha256 !== hash) return { ok: false, message: 'Gist non aggiornato: hash non corrisponde.' };
    return { ok: true, message: 'Gist verificato pubblicamente (letto senza autenticazione).' };
  } catch {
    return { ok: false, message: 'Gist verificato ma manifest non valido.' };
  }
}

function recordHistory(entry) {
  const dir = path.dirname(HISTORY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let history = [];
  if (fs.existsSync(HISTORY_PATH)) {
    try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch { history = []; }
  }
  history.unshift(entry);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history.slice(0, 50), null, 2), 'utf8');
}

function getHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch { return []; }
}

// ---------- Orchestrator ----------

async function publishRelease({ version, releaseNotes, dryRun }, onProgress) {
  const report = (name, result) => {
    onProgress && onProgress({ step: name, ...result });
    return result;
  };
  const cfg = loadReleaseConfig();
  const steps = [];

  const conn = report('validate-connection', await stepValidateConnection(cfg));
  steps.push({ name: 'validate-connection', ...conn });
  if (!conn.ok) return finish(steps, version);

  const ver = report('validate-version', await stepValidateVersion(cfg, version));
  steps.push({ name: 'validate-version', ...ver });
  if (!ver.ok) return finish(steps, version);

  const tests = report('tests', await stepRunTests());
  steps.push({ name: 'tests', ...tests });
  if (!tests.ok) return finish(steps, version);

  // Snapshot the files bump-version touches so a dry run can restore them —
  // a "dry run" must never leave the working tree modified.
  const versionedFiles = ['package.json', 'src/config/default.json', 'src/owner/package.json'].map(f => path.join(ROOT, f));
  const originalContents = dryRun ? versionedFiles.map(f => fs.readFileSync(f, 'utf8')) : null;

  const bump = report('bump-version', stepBumpVersion(version));
  steps.push({ name: 'bump-version', ...bump });

  const build = report('build', stepBuild());
  steps.push({ name: 'build', ...build });

  if (dryRun) {
    versionedFiles.forEach((f, i) => fs.writeFileSync(f, originalContents[i], 'utf8'));
  }
  if (!build.ok) return finish(steps, version);

  const hash = report('hash', stepHash(build.data.exePath));
  steps.push({ name: 'hash', ...hash });

  if (dryRun) {
    steps.push({ name: 'dry-run', ok: true, message: 'Dry run: build e hash completati, versione ripristinata, nessuna pubblicazione eseguita.' });
    return finish(steps, version);
  }

  const tag = report('git-tag-push', stepTagAndPush(cfg, version));
  steps.push({ name: 'git-tag-push', ...tag });
  if (!tag.ok) return finish(steps, version);

  const rel = report('github-release', await stepCreateRelease(cfg, version, releaseNotes));
  steps.push({ name: 'github-release', ...rel });
  if (!rel.ok) return finish(steps, version);

  const upload = report('upload-asset', await stepUploadAsset(cfg, rel.data, build.data.exePath));
  steps.push({ name: 'upload-asset', ...upload });
  if (!upload.ok) return finish(steps, version);

  const verifyAsset = report('verify-asset', await stepVerifyAsset(cfg, upload.data, hash.data.hash));
  steps.push({ name: 'verify-asset', ...verifyAsset });

  const gist = report('update-gist', await stepUpdateGist(cfg, version, releaseNotes, rel.data, upload.data, hash.data.hash));
  steps.push({ name: 'update-gist', ...gist });
  if (!gist.ok) return finish(steps, version);

  const verifyGist = report('verify-gist', await stepVerifyGist(cfg, version, hash.data.hash));
  steps.push({ name: 'verify-gist', ...verifyGist });

  return finish(steps, version, rel.data.html_url);
}

function finish(steps, version, releaseUrl) {
  const allOk = steps.every(s => s.ok);
  const anyOk = steps.some(s => s.ok);
  const status = allOk ? 'success' : (anyOk ? 'partial' : 'failed');
  const entry = { version, date: new Date().toISOString(), status, releaseUrl: releaseUrl || null, steps };
  recordHistory(entry);
  return entry;
}

module.exports = {
  loadReleaseConfig,
  saveReleaseConfig,
  maskedConfig,
  publishRelease,
  getHistory,
  stepValidateConnection
};
