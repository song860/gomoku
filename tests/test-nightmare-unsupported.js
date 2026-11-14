'use strict';

/*
 * Verifies the graceful fallback when Web Workers are unavailable: selecting
 * nightmare must show an explanation instead of leaving the board stuck.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9343;
const PROFILE = path.join(ROOT, '.nightmare-unsupported-profile');
const PAGE_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJson(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (err) { /* not ready */ }
    await sleep(150);
  }
  throw new Error('Timed out waiting for ' + url);
}

async function main() {
  if (fs.existsSync(PROFILE)) fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--disable-crash-reporter', '--disable-breakpad',
    '--window-size=1440,1100', '--force-device-scale-factor=1',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  try {
    await waitForJson('http://127.0.0.1:' + PORT + '/json/version', 12000);
    const pages = await waitForJson('http://127.0.0.1:' + PORT + '/json', 5000);
    const page = pages.find((item) => item.type === 'page');
    if (!page) throw new Error('No page target found');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    let nextId = 1;
    const pending = new Map();
    const errors = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        errors.push(details.text + (details.exception && details.exception.description ? ': ' + details.exception.description : ''));
      }
    });

    function send(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });
    }

    async function evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text + ': ' +
          (result.exceptionDetails.exception && result.exceptionDetails.exception.description));
      }
      return result.result.value;
    }

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'Object.defineProperty(window, "Worker", { value: undefined, configurable: true });'
    });
    await send('Page.navigate', { url: PAGE_URL });

    let ready = false;
    for (let i = 0; i < 40; i++) {
      ready = await evaluate('!!window.__gomokuDebug && document.readyState === "complete"');
      if (ready) break;
      await sleep(200);
    }
    if (!ready) throw new Error('App did not boot');

    const supported = await evaluate('window.__gomokuDebug.nightmareSupported()');
    if (supported) throw new Error('Worker stub was not applied');

    await evaluate(`document.querySelector('#difficulty-group [data-difficulty="nightmare"]').click()`);
    let dialog = null;
    for (let i = 0; i < 20; i++) {
      dialog = await evaluate(`(() => ({
        open: document.getElementById('engine-dialog').open,
        title: document.getElementById('engine-title').textContent,
        message: document.getElementById('engine-message').textContent,
        difficulty: window.__gomokuDebug.state.difficulty
      }))()`);
      if (dialog.open) break;
      await sleep(150);
    }
    console.log('unsupported dialog', JSON.stringify(dialog));
    if (!dialog || !dialog.open) throw new Error('Unsupported-browser dialog did not open');
    if (dialog.difficulty === 'nightmare') throw new Error('Nightmare should not activate without Worker');
    if (!dialog.title || dialog.title.indexOf('不支持') < 0) throw new Error('Dialog title does not explain the limitation');
    if (!dialog.message || dialog.message.indexOf('WebAssembly') < 0) throw new Error('Dialog message does not explain the limitation');

    if (errors.length) throw new Error('Browser errors: ' + errors.join(' | '));
    console.log('Nightmare unsupported-browser test passed');
  } finally {
    if (ws) {
      try { ws.close(); } catch (err) { /* ignore */ }
    }
    chrome.kill();
    await sleep(300);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
