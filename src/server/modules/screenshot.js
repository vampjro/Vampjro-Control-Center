const ps = require('../utils/powershell');
const path = require('path');
const fs = require('fs');
const logger = require('../core/logger');

const SCREENSHOT_DIR = path.join(process.env.VAMPJRO_DATA_DIR || path.join(__dirname, '..', '..', '..', 'local-data'), 'screenshots');

function initialize() {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function take() {
  initialize();
  const filename = `screen_${Date.now()}.jpg`;
  const filepath = path.join(SCREENSHOT_DIR, filename);

  const old = fs.readdirSync(SCREENSHOT_DIR).filter(f => f.startsWith('screen_'));
  for (const f of old) {
    try { fs.unlinkSync(path.join(SCREENSHOT_DIR, f)); } catch {}
  }

  const escapedPath = filepath.replace(/\\/g, '\\\\');
  const cmd = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $enc=[System.Drawing.Imaging.Encoder]::Quality; $p=New-Object System.Drawing.Imaging.EncoderParameters(1); $p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter($enc,55L); $c=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object MimeType -eq 'image/jpeg'; $bmp.Save('${escapedPath}',$c,$p); $g.Dispose(); $bmp.Dispose(); Write-Output 'OK'`;

  await ps.run(cmd, { timeout: 15000 });
  logger.logAction('panel', 'screenshot', filename);

  const stat = fs.statSync(filepath);
  return {
    url: `/api/screenshot/${filename}`,
    filename,
    size: stat.size,
    ts: Date.now()
  };
}

function getFile(filename) {
  const safe = path.basename(filename);
  const filepath = path.join(SCREENSHOT_DIR, safe);
  if (!fs.existsSync(filepath)) return null;
  return filepath;
}

function wsHandlers() {
  return {
    screenshot: async () => await take()
  };
}

function routes() {
  return [{
    method: 'get',
    path: '/api/screenshot/:filename',
    handler: (req, res) => {
      const filepath = getFile(req.params.filename);
      if (!filepath) return res.status(404).send('Not found');
      res.sendFile(filepath);
    }
  }];
}

module.exports = { initialize, wsHandlers, routes };
