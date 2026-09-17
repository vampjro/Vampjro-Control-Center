const ps = require('../utils/powershell');
const logger = require('../core/logger');

const history = [];
const MAX_HISTORY = 20;

async function getClipboard() {
  try {
    const result = await ps.run('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()');
    return { text: result || '', ts: Date.now() };
  } catch {
    return { text: '', error: 'Clipboard unavailable', ts: Date.now() };
  }
}

async function setClipboard(text) {
  if (typeof text !== 'string') throw new Error('Invalid text');
  const safe = text.replace(/'/g, "''").substring(0, 50000);
  await ps.run(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText('${safe}')`);
  history.push({ text: text.substring(0, 200), ts: Date.now(), direction: 'phone→pc' });
  if (history.length > MAX_HISTORY) history.shift();
  logger.logAction('panel', 'setClipboard', `${text.length} chars`);
  return { success: true };
}

function getHistory() {
  return history.slice(-MAX_HISTORY);
}

function clearHistory() {
  history.length = 0;
  return { success: true };
}

function wsHandlers() {
  return {
    getClipboard: async () => await getClipboard(),
    setClipboard: async (msg) => await setClipboard(msg.text),
    getClipboardHistory: () => getHistory(),
    clearClipboardHistory: () => clearHistory()
  };
}

module.exports = { wsHandlers };
