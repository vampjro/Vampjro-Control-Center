const fs = require('fs');
const path = require('path');

const CONFIG_DIR = process.env.VAMPJRO_DATA_DIR || path.join(__dirname, '..', '..', '..', 'local-data');
const USER_CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'default.json');

let config = null;

function load() {
  const defaults = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

  let user = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { user = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, 'utf8')); } catch {}
  }

  config = deepMerge(defaults, user);
  return config;
}

function get(keyPath) {
  if (!config) load();
  return keyPath.split('.').reduce((o, k) => o?.[k], config);
}

function set(keyPath, value) {
  if (!config) load();
  const keys = keyPath.split('.');
  let obj = config;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!obj[keys[i]] || typeof obj[keys[i]] !== 'object') obj[keys[i]] = {};
    obj = obj[keys[i]];
  }
  obj[keys[keys.length - 1]] = value;
  save();
}

function save() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function getAll() {
  if (!config) load();
  return config;
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
        target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

module.exports = { load, get, set, save, getAll };
