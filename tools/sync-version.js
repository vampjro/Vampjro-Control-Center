'use strict';
// Propagates the root package.json version (the single authoritative source)
// into the other files that need to know it at build time. Exposed as a
// function (not top-level side effects) so long-running callers like the
// Owner release pipeline can invoke it fresh on every release, not just once
// per process thanks to require() caching.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function sync() {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

  function syncJson(file, setter) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    setter(data);
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  syncJson(path.join(ROOT, 'src', 'config', 'default.json'), cfg => {
    cfg.branding.version = version;
  });

  syncJson(path.join(ROOT, 'src', 'owner', 'package.json'), pkg => {
    pkg.version = version;
  });

  console.log(`Synced version ${version} into src/config/default.json and src/owner/package.json`);
  return version;
}

if (require.main === module) {
  sync();
}

module.exports = { sync };
