const { exec } = require('child_process');

const MAX_CONCURRENT = 3;
let active = 0;
const queue = [];

function run(command, opts = {}) {
  return new Promise((resolve, reject) => {
    const task = () => {
      active++;
      const timeout = opts.timeout || 15000;
      const maxBuffer = opts.maxBuffer || 2 * 1024 * 1024;
      const ps = `powershell -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`;
      const child = exec(ps, { maxBuffer, timeout }, (err, stdout, stderr) => {
        active--;
        processQueue();
        if (err) {
          if (err.killed) return reject(new Error('Command timed out'));
          return reject(new Error(stderr?.trim() || err.message));
        }
        resolve(stdout.trim());
      });
    };

    if (active < MAX_CONCURRENT) {
      task();
    } else {
      queue.push(task);
    }
  });
}

function processQueue() {
  while (queue.length > 0 && active < MAX_CONCURRENT) {
    const task = queue.shift();
    task();
  }
}

function runRaw(command, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeout = opts.timeout || 15000;
    const child = exec(command, { maxBuffer: 2 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout.trim());
    });
  });
}

module.exports = { run, runRaw };
