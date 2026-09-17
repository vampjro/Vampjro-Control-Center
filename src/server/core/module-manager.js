const config = require('./config');
const logger = require('./logger');

const modules = new Map();

function register(name, mod) {
  modules.set(name, {
    name,
    instance: mod,
    status: 'registered',
    error: null,
    startedAt: null
  });
}

async function startAll() {
  const enabled = config.get('modules') || {};
  for (const [name, entry] of modules) {
    if (enabled[name] === false) {
      entry.status = 'disabled';
      logger.info(`Module ${name}: disabled`);
      continue;
    }
    await startModule(name);
  }
}

async function startModule(name) {
  const entry = modules.get(name);
  if (!entry) return;
  try {
    if (entry.instance.initialize) await entry.instance.initialize();
    if (entry.instance.start) await entry.instance.start();
    entry.status = 'running';
    entry.startedAt = Date.now();
    entry.error = null;
    logger.info(`Module ${name}: started`);
  } catch (err) {
    entry.status = 'error';
    entry.error = err.message;
    logger.error(`Module ${name}: failed to start`, { error: err.message });
  }
}

async function stopAll() {
  for (const [name, entry] of modules) {
    if (entry.status !== 'running') continue;
    try {
      if (entry.instance.stop) await entry.instance.stop();
      entry.status = 'stopped';
      logger.info(`Module ${name}: stopped`);
    } catch (err) {
      logger.error(`Module ${name}: failed to stop`, { error: err.message });
    }
  }
}

function getHealth() {
  const result = {};
  for (const [name, entry] of modules) {
    result[name] = {
      status: entry.status,
      error: entry.error,
      uptime: entry.startedAt ? Date.now() - entry.startedAt : 0
    };
    if (entry.instance.health && entry.status === 'running') {
      try { Object.assign(result[name], entry.instance.health()); } catch {}
    }
  }
  return result;
}

function getModule(name) {
  return modules.get(name)?.instance;
}

function getRoutes() {
  const routes = [];
  for (const [, entry] of modules) {
    if (entry.status === 'running' && entry.instance.routes) {
      routes.push(...entry.instance.routes());
    }
  }
  return routes;
}

function getWsHandlers() {
  const handlers = {};
  for (const [name, entry] of modules) {
    if (entry.status === 'running' && entry.instance.wsHandlers) {
      Object.assign(handlers, entry.instance.wsHandlers());
    }
  }
  return handlers;
}

function getStatus() {
  const result = {};
  for (const [name, entry] of modules) {
    result[name] = entry.status;
  }
  return result;
}

module.exports = { register, startAll, stopAll, startModule, getHealth, getModule, getRoutes, getWsHandlers, getStatus };
