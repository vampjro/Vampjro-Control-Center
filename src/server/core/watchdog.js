const logger = require('./logger');

let interval = null;
const metrics = {
  startTime: Date.now(),
  peakRss: 0,
  peakHeapUsed: 0,
  errors: 0,
  wsClients: 0,
  eventLoopLag: 0
};

const resourceState = 'NORMAL'; // NORMAL, PRESSURE, LOW, CRITICAL
let currentState = 'NORMAL';

function start() {
  interval = setInterval(check, 15000);
  logger.info('Watchdog started');
}

function stop() {
  if (interval) { clearInterval(interval); interval = null; }
}

function check() {
  const mem = process.memoryUsage();
  metrics.peakRss = Math.max(metrics.peakRss, mem.rss);
  metrics.peakHeapUsed = Math.max(metrics.peakHeapUsed, mem.heapUsed);

  const now = Date.now();
  const before = process.hrtime.bigint();
  setImmediate(() => {
    const lag = Number(process.hrtime.bigint() - before) / 1e6;
    metrics.eventLoopLag = Math.round(lag * 10) / 10;
  });

  const rssMB = Math.round(mem.rss / 1024 / 1024);
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);

  let newState = 'NORMAL';
  if (rssMB > 200) newState = 'CRITICAL';
  else if (rssMB > 150) newState = 'LOW';
  else if (rssMB > 100) newState = 'PRESSURE';

  if (newState !== currentState) {
    logger.warn(`Resource state: ${currentState} → ${newState}`, { rssMB, heapMB });
    currentState = newState;
  }
}

function getMetrics() {
  const mem = process.memoryUsage();
  return {
    uptime: Math.round((Date.now() - metrics.startTime) / 1000),
    rss: Math.round(mem.rss / 1024 / 1024),
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    peakRss: Math.round(metrics.peakRss / 1024 / 1024),
    eventLoopLag: metrics.eventLoopLag,
    resourceState: currentState,
    wsClients: metrics.wsClients,
    errors: metrics.errors
  };
}

function setWsClients(n) { metrics.wsClients = n; }
function incrementErrors() { metrics.errors++; }
function getResourceState() { return currentState; }

module.exports = { start, stop, getMetrics, setWsClients, incrementErrors, getResourceState };
