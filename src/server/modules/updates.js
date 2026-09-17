const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../core/config');
const logger = require('../core/logger');

const UPDATE_DIR = path.join(process.env.VAMPJRO_DATA_DIR || path.join(__dirname, '..', '..', '..', 'local-data'), 'updates');

let lastCheck = null;
let lastResult = null;
let checkTimer = null;
let downloadState = { status: 'idle' }; // idle | downloading | verifying | ready | error

function initialize() {
  logger.info('Updates module initialized');
}

function start() {
  const interval = config.get('updates.checkInterval') || 86400000;
  checkTimer = setInterval(() => {
    checkForUpdates().catch(() => {});
  }, interval);
}

function stop() {
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function fetchGist(gistId) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path: `/gists/${gistId}`,
      headers: { 'User-Agent': 'VAMPJRO-UpdateCheck', 'Accept': 'application/vnd.github.v3+json' },
      timeout: 15000
    };
    const req = https.get(opts, res => {
      if (res.statusCode === 403 || res.statusCode === 429) {
        return reject(new Error('Rate limited'));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

function parseManifest(gistData) {
  const files = gistData.files || {};
  const manifestFile = files['vampjro-updates.json'] || files['manifest.json'];
  if (!manifestFile || !manifestFile.content) return null;
  try {
    return JSON.parse(manifestFile.content);
  } catch {
    return null;
  }
}

function verifySha256(buffer, expected) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  return hash === expected.toLowerCase();
}

// Follows redirects manually (GitHub release asset URLs redirect to a CDN
// host) rather than trusting an arbitrary Location header — capped at a
// small number of hops so a malicious/broken manifest can't cause an
// infinite redirect loop.
function downloadToFile(url, destPath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\//i.test(url)) return reject(new Error('URL non sicuro (richiesto HTTPS)'));
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, { headers: { 'User-Agent': 'VAMPJRO-UpdateDownload' }, timeout: 60000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(destPath, () => {});
        if (maxRedirects <= 0) return reject(new Error('Troppi redirect'));
        return resolve(downloadToFile(res.headers.location, destPath, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', err => { file.close(); fs.unlink(destPath, () => {}); reject(err); });
  });
}

async function downloadUpdate() {
  if (!lastResult || !lastResult.packageUrl || !lastResult.sha256) {
    downloadState = { status: 'error', error: 'Nessun aggiornamento scaricabile disponibile.' };
    return downloadState;
  }
  if (downloadState.status === 'downloading' || downloadState.status === 'verifying') {
    return downloadState; // already in progress
  }
  downloadState = { status: 'downloading', version: lastResult.latestVersion };
  try {
    if (!fs.existsSync(UPDATE_DIR)) fs.mkdirSync(UPDATE_DIR, { recursive: true });
    const destPath = path.join(UPDATE_DIR, `VAMPJRO-${lastResult.latestVersion}.exe`);
    await downloadToFile(lastResult.packageUrl, destPath);

    downloadState = { status: 'verifying', version: lastResult.latestVersion };
    const buffer = fs.readFileSync(destPath);
    if (!verifySha256(buffer, lastResult.sha256)) {
      fs.unlink(destPath, () => {});
      downloadState = { status: 'error', error: 'Verifica integrità fallita: il file scaricato non corrisponde allo SHA-256 atteso.' };
      logger.error('Update download failed SHA-256 verification', { version: lastResult.latestVersion });
      return downloadState;
    }

    downloadState = { status: 'ready', version: lastResult.latestVersion, filePath: destPath };
    logger.info('Update downloaded and verified', { version: lastResult.latestVersion });
    return downloadState;
  } catch (err) {
    downloadState = { status: 'error', error: err.message };
    logger.error('Update download failed', { error: err.message });
    return downloadState;
  }
}

// Launches the verified installer and exits this process so the installer
// can overwrite the running app's files. Never called automatically — only
// in direct response to an explicit user confirmation from the client.
function installUpdate() {
  if (downloadState.status !== 'ready' || !downloadState.filePath || !fs.existsSync(downloadState.filePath)) {
    return { ok: false, error: 'Nessun aggiornamento verificato pronto per l\'installazione.' };
  }
  try {
    const child = spawn(downloadState.filePath, [], { detached: true, stdio: 'ignore' });
    child.unref();
    logger.info('Launching verified update installer', { path: downloadState.filePath });
    setTimeout(() => process.exit(0), 500);
    return { ok: true };
  } catch (err) {
    logger.error('Failed to launch update installer', { error: err.message });
    return { ok: false, error: err.message };
  }
}

async function checkForUpdates() {
  const gistId = config.get('updates.gistId');
  if (!gistId) {
    lastResult = { status: 'no_gist', message: 'Nessun Gist configurato' };
    lastCheck = Date.now();
    return lastResult;
  }

  try {
    const gistData = await fetchGist(gistId);
    const manifest = parseManifest(gistData);
    if (!manifest || !manifest.version) {
      lastResult = { status: 'invalid', message: 'Manifest non valido' };
      lastCheck = Date.now();
      return lastResult;
    }

    const currentVersion = config.get('branding.version') || '1.0.0';
    const currentChannel = config.get('updates.channel') || 'stable';

    if (manifest.channel && manifest.channel !== currentChannel) {
      lastResult = { status: 'channel_mismatch', message: `Canale diverso: ${manifest.channel}`, manifest };
      lastCheck = Date.now();
      return lastResult;
    }

    const cmp = compareVersions(manifest.version, currentVersion);

    if (manifest.minimumVersion && compareVersions(currentVersion, manifest.minimumVersion) < 0) {
      lastResult = {
        status: 'critical',
        message: `Aggiornamento critico richiesto: v${manifest.version}`,
        currentVersion,
        latestVersion: manifest.version,
        minimumVersion: manifest.minimumVersion,
        releaseNotes: manifest.releaseNotes || null,
        packageUrl: manifest.packageUrl || null,
        sha256: manifest.sha256 || null,
        publishedAt: manifest.publishedAt || null
      };
    } else if (cmp > 0) {
      lastResult = {
        status: 'available',
        message: `Aggiornamento disponibile: v${manifest.version}`,
        currentVersion,
        latestVersion: manifest.version,
        releaseNotes: manifest.releaseNotes || null,
        packageUrl: manifest.packageUrl || null,
        sha256: manifest.sha256 || null,
        publishedAt: manifest.publishedAt || null
      };
    } else {
      lastResult = {
        status: 'up_to_date',
        message: 'Sei aggiornato',
        currentVersion,
        latestVersion: manifest.version
      };
    }

    lastCheck = Date.now();
    logger.info(`Update check: ${lastResult.status} (current=${currentVersion}, latest=${manifest.version})`);
    return lastResult;

  } catch (err) {
    lastResult = { status: 'error', message: `Errore controllo: ${err.message}` };
    lastCheck = Date.now();
    logger.error('Update check failed', { error: err.message });
    return lastResult;
  }
}

function health() {
  return { lastCheck, lastStatus: lastResult?.status || null };
}

function wsHandlers() {
  return {
    checkUpdates: async () => {
      const result = await checkForUpdates();
      return { ...result, lastCheck };
    },
    getUpdateStatus: () => {
      return {
        ...(lastResult || { status: 'unknown', message: 'Nessun controllo effettuato' }),
        lastCheck,
        currentVersion: config.get('branding.version') || '1.0.0',
        channel: config.get('updates.channel') || 'stable',
        gistConfigured: !!config.get('updates.gistId')
      };
    },
    downloadUpdate: async () => downloadUpdate(),
    getDownloadStatus: () => downloadState,
    installUpdate: () => installUpdate()
  };
}

module.exports = { initialize, start, stop, health, wsHandlers, checkForUpdates, compareVersions, verifySha256, downloadUpdate, installUpdate };
