'use strict';

/*
 * End-to-end test for the Rapfi WebAssembly "nightmare" engine. It uses
 * headless Chrome via the DevTools protocol, with no npm dependencies.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9342;
const PROFILE = path.join(ROOT, '.nightmare-wasm-profile');
const PAGE_URL = process.env.GOMOKU_PAGE_URL ||
  ('file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/'));
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
    PAGE_URL
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
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        errors.push(message.params.args.map((arg) => arg.value || arg.description || '').join(' '));
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
    await sleep(900);

    let ready = false;
    for (let i = 0; i < 30; i++) {
      ready = await evaluate('!!window.__gomokuDebug && document.readyState === "complete"');
      if (ready) break;
      await sleep(200);
    }
    if (!ready) throw new Error('App did not boot');

    const support = await evaluate('window.__gomokuDebug.nightmareSupported()');
    console.log('nightmare support', support);
    if (!support) throw new Error('Nightmare WASM is not supported in this browser');

    await evaluate(`document.querySelector('#difficulty-group [data-difficulty="nightmare"]').click()`);
    const selected = await evaluate(`(() => {
      const s = window.__gomokuDebug.state;
      return { difficulty: s.difficulty, status: s.status, turn: s.turn };
    })()`);
    console.log('selected', JSON.stringify(selected));
    if (selected.difficulty !== 'nightmare') throw new Error('Nightmare difficulty was not selected');

    const rect = await evaluate(`(() => {
      const r = document.getElementById('board').getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`);
    const clickX = rect.x + rect.width / 2;
    const clickY = rect.y + rect.height / 2;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });

    let afterHuman = null;
    for (let i = 0; i < 20; i++) {
      afterHuman = await evaluate(`(() => {
        const s = window.__gomokuDebug.state;
        return {
          history: s.history.length,
          status: s.status,
          progress: document.getElementById('ai-progress-text').textContent,
          progressHidden: document.getElementById('ai-progress').hidden
        };
      })()`);
      if (afterHuman.history >= 1) break;
      await sleep(200);
    }
    console.log('after human', JSON.stringify(afterHuman));
    if (!afterHuman || afterHuman.history !== 1) throw new Error('Human move was not placed');
    if (afterHuman.status !== 'thinking') throw new Error('Rapfi should be thinking');

    let afterAI = null;
    let progressLabels = [];
    for (let i = 0; i < 90; i++) {
      const snapshot = await evaluate(`(() => {
        const s = window.__gomokuDebug.state;
        return {
          history: s.history.length,
          status: s.status,
          turn: s.turn,
          engine: s.lastAI && s.lastAI.engine,
          depth: s.lastAI && s.lastAI.depth,
          nodes: s.lastAI && s.lastAI.nodes,
          time: s.lastAI && s.lastAI.time,
          lastMove: s.lastAI && s.lastAI.move,
          stats: document.getElementById('ai-stats').textContent,
          progress: document.getElementById('ai-progress-text').textContent,
          progressNodes: s.aiProgress && s.aiProgress.nodes
        };
      })()`);
      if (snapshot.progress && snapshot.progress.indexOf('节点') >= 0) {
        progressLabels.push(snapshot.progress);
      }
      if (/(?:^|· )0 节点/.test(snapshot.progress || '')) {
        throw new Error('Progress displayed zero nodes: ' + snapshot.progress);
      }
      afterAI = snapshot;
      if (afterAI.history >= 2 || afterAI.status === 'won' || afterAI.status === 'draw') break;
      await sleep(250);
    }
    console.log('after AI', JSON.stringify(afterAI));
    console.log('progress labels', JSON.stringify(progressLabels.slice(0, 6)));
    if (!afterAI || afterAI.history < 2) throw new Error('Rapfi did not answer in time');
    if (afterAI.engine !== 'Rapfi') throw new Error('AI result did not come from Rapfi');
    if (!afterAI.depth || !afterAI.nodes) throw new Error('Rapfi did not report depth/nodes');
    if (!/Rapfi/.test(afterAI.stats || '')) throw new Error('Rapfi stats were not shown in the UI');
    if (/(?:^|· )0 节点/.test(afterAI.stats || '')) throw new Error('Stats displayed zero nodes: ' + afterAI.stats);
    if (!/\d{1,3}(,\d{3})* 节点/.test(afterAI.stats || '')) {
      throw new Error('Stats did not show an exact node count: ' + afterAI.stats);
    }

    /* Play a second human move so the worker has to reset and reuse Rapfi. */
    const nextPoint = await evaluate(`window.__gomokuDebug.cellPoint(113)`);
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: rect.x + nextPoint.x,
      y: rect.y + nextPoint.y,
      button: 'left',
      clickCount: 1
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: rect.x + nextPoint.x,
      y: rect.y + nextPoint.y,
      button: 'left',
      clickCount: 1
    });

    let secondAI = null;
    for (let i = 0; i < 90; i++) {
      secondAI = await evaluate(`(() => {
        const s = window.__gomokuDebug.state;
        return {
          history: s.history.length,
          status: s.status,
          turn: s.turn,
          engine: s.lastAI && s.lastAI.engine,
          moves: s.history.map(function (m) { return m.cell; })
        };
      })()`);
      if (secondAI.history >= 4 || secondAI.status === 'won' || secondAI.status === 'draw') break;
      await sleep(250);
    }
    console.log('after second AI', JSON.stringify(secondAI));
    if (!secondAI || secondAI.history < 4) throw new Error('Rapfi did not answer the second move');
    if (secondAI.engine !== 'Rapfi') throw new Error('Second AI result did not come from Rapfi');
    if (new Set(secondAI.moves).size !== secondAI.moves.length) throw new Error('Rapfi returned an occupied cell');

    /* AI opens as black. */
    await evaluate(`window.__gomokuDebug.startNewGame(2, 'nightmare')`);
    let opening = null;
    for (let i = 0; i < 90; i++) {
      opening = await evaluate(`(() => {
        const s = window.__gomokuDebug.state;
        return {
          history: s.history.length,
          status: s.status,
          turn: s.turn,
          engine: s.lastAI && s.lastAI.engine,
          move: s.history.length ? s.history[0].cell : -1
        };
      })()`);
      if (opening.history >= 1 && opening.status === 'playing' && opening.turn === 2) break;
      await sleep(250);
    }
    console.log('opening', JSON.stringify(opening));
    if (!opening || opening.history < 1) throw new Error('Rapfi did not open as black');
    if (opening.turn !== 2) throw new Error('Turn did not return to white after the opening');
    if (opening.engine !== 'Rapfi') throw new Error('Opening did not come from Rapfi');

    if (errors.length) throw new Error('Browser errors: ' + errors.join(' | '));
    console.log('Rapfi WASM nightmare test passed');
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
