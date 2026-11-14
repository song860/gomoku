'use strict';

/*
 * Local headless-Chrome smoke test. No npm dependencies: it talks to Chrome
 * through the DevTools protocol using Node's built-in WebSocket client.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const PROFILE = path.join(ROOT, '.ui-profile');
const PAGE_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJson(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (err) { /* not ready yet */ }
    await sleep(120);
  }
  throw new Error('Timed out waiting for ' + url);
}

async function main() {
  if (fs.existsSync(PROFILE)) {
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  }

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--hide-scrollbars',
    '--window-size=1440,1100',
    '--force-device-scale-factor=1',
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

    const initial = await evaluate(`(() => {
      const d = window.__gomokuDebug;
      const r = document.getElementById('board').getBoundingClientRect();
      return {
        state: { status: d.state.status, turn: d.state.turn, history: d.state.history.length, difficulty: d.state.difficulty },
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        progressHidden: document.getElementById('ai-progress').hidden,
        buttons: document.querySelectorAll('#difficulty-group [data-difficulty]').length,
        title: document.title
      };
    })()`);
    console.log('initial', JSON.stringify(initial));
    if (initial.state.status !== 'playing' || initial.state.history !== 0) throw new Error('Unexpected initial state');
    if (initial.buttons !== 5) throw new Error('Expected five difficulty levels');
    if (!initial.progressHidden) throw new Error('AI progress should be hidden on human turn');

    const clickX = initial.rect.x + initial.rect.width / 2;
    const clickY = initial.rect.y + initial.rect.height / 2;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
    await sleep(500);

    const afterHuman = await evaluate(`(() => {
      const s = window.__gomokuDebug.state;
      return { history: s.history.length, turn: s.turn, status: s.status, move: s.history[0] && s.history[0].cell };
    })()`);
    console.log('after human', JSON.stringify(afterHuman));
    if (afterHuman.history !== 1) throw new Error('Human move was not placed');
    if (afterHuman.status !== 'thinking') throw new Error('AI should be thinking after human move');

    let finalState = null;
    for (let i = 0; i < 60; i++) {
      finalState = await evaluate(`(() => {
        const s = window.__gomokuDebug.state;
        return {
          history: s.history.length,
          turn: s.turn,
          status: s.status,
          compat: s.compatNotified,
          lastAI: s.lastAI && { depth: s.lastAI.depth, nodes: s.lastAI.nodes, time: s.lastAI.time },
          moves: s.history.map(function (m) { return m.cell; })
        };
      })()`);
      if (finalState.history >= 2 || finalState.status === 'won' || finalState.status === 'draw') break;
      await sleep(250);
    }
    console.log('after AI', JSON.stringify(finalState));
    if (!finalState || finalState.history < 2) throw new Error('AI did not answer in time');

    const saved = await evaluate(`(() => {
      try { return JSON.parse(localStorage.getItem('gomoku.save.v1')).history.length; }
      catch (err) { return -1; }
    })()`);
    console.log('saved history length', saved);
    if (saved !== 2) throw new Error('Game was not persisted locally');

    await evaluate(`document.getElementById('btn-undo').click()`);
    await sleep(500);
    const afterUndo = await evaluate(`(() => {
      const s = window.__gomokuDebug.state;
      return { history: s.history.length, turn: s.turn, status: s.status };
    })()`);
    console.log('after undo', JSON.stringify(afterUndo));
    if (afterUndo.history !== 0 || afterUndo.status !== 'playing') throw new Error('Undo did not restore the empty board');

    const dialog = await evaluate(`(() => {
      document.getElementById('btn-new').click();
      return {
        open: document.getElementById('new-dialog').open,
        color: document.querySelector('#color-choice .selected').getAttribute('data-color'),
        difficulties: document.querySelectorAll('#new-difficulty [data-difficulty]').length
      };
    })()`);
    console.log('new dialog', JSON.stringify(dialog));
    if (!dialog.open) throw new Error('New-game dialog did not open');
    if (dialog.difficulties !== 5) throw new Error('New-game dialog is missing nightmare');

    await evaluate(`(() => {
      document.querySelector('#color-choice [data-color="2"]').click();
      document.querySelector('#new-difficulty [data-difficulty="strong"]').click();
      document.getElementById('new-form').requestSubmit();
    })()`);
    await sleep(250);
    const afterNew = await evaluate(`(() => {
      const s = window.__gomokuDebug.state;
      return { status: s.status, turn: s.turn, humanColor: s.humanColor, difficulty: s.difficulty, history: s.history.length };
    })()`);
    console.log('after new as white', JSON.stringify(afterNew));
    if (afterNew.humanColor !== 2 || afterNew.difficulty !== 'strong') throw new Error('New game options were not applied');
    if (afterNew.status !== 'thinking' && afterNew.history === 0) throw new Error('AI should open when the human takes white');

    let opened = null;
    for (let i = 0; i < 40; i++) {
      opened = await evaluate(`(() => {
        const s = window.__gomokuDebug.state;
        return { history: s.history.length, status: s.status, turn: s.turn };
      })()`);
      if (opened.history >= 1 && opened.status === 'playing' && opened.turn === 2) break;
      await sleep(200);
    }
    console.log('AI opening', JSON.stringify(opened));
    if (!opened || opened.history < 1) throw new Error('AI did not open the game');
    if (opened.turn !== 2) throw new Error('Turn did not return to the human after the AI opening');

    await evaluate(`document.getElementById('btn-hint').click()`);
    let hintState = null;
    for (let i = 0; i < 30; i++) {
      hintState = await evaluate(`(() => {
        const s = window.__gomokuDebug.state;
        return { hint: s.hintCell, loading: s.hintLoading, status: s.status, toast: document.getElementById('toast').textContent };
      })()`);
      if (!hintState.loading && hintState.hint >= 0) break;
      await sleep(200);
    }
    console.log('hint', JSON.stringify(hintState));
    if (!hintState || hintState.hint < 0) throw new Error('Hint did not produce a suggestion');

    await evaluate(`(() => {
      document.getElementById('btn-settings').click();
      document.getElementById('set-numbers').click();
    })()`);
    await sleep(200);
    const settingsState = await evaluate(`(() => ({
      open: document.getElementById('settings-dialog').open,
      numbers: window.__gomokuDebug.state.settings.numbers,
      checked: document.getElementById('set-numbers').checked
    }))()`);
    console.log('settings', JSON.stringify(settingsState));
    if (!settingsState.open || !settingsState.numbers || !settingsState.checked) throw new Error('Settings toggle did not apply');
    await evaluate(`document.querySelector('#settings-dialog [data-close]').click()`);

    await evaluate(`(() => {
      const d = window.__gomokuDebug;
      const s = d.state;
      s.humanColor = 1;
      s.aiColor = 2;
      s.board = new Uint8Array(225);
      s.history = [];
      const cells = [[3,7],[4,7],[5,7],[6,7],[7,7]];
      for (const [x,y] of cells) {
        const cell = y * 15 + x;
        s.board[cell] = 1;
        s.history.push({ cell, player: 1 });
      }
      s.winner = 1;
      s.status = 'won';
      s.turn = 2;
      s.hintCell = -1;
      s.hintLoading = false;
      s.winLine = cells.map(([x,y]) => y * 15 + x);
      s.winAt = performance.now();
      s.lastAI = null;
      s.anim.clear();
      d.updateUI();
      d.render();
    })()`);
    await sleep(350);
    const resultInfo = await evaluate(`(() => ({
      hidden: document.getElementById('result-banner').hidden,
      title: document.getElementById('result-title').textContent,
      sub: document.getElementById('result-sub').textContent,
      status: window.__gomokuDebug.state.status
    }))()`);
    console.log('result banner', JSON.stringify(resultInfo));
    if (resultInfo.hidden || resultInfo.title !== '你赢了') throw new Error('Win banner did not render');

    await evaluate(`document.getElementById('btn-again').click()`);
    await sleep(600);
    const again = await evaluate(`(() => {
      const s = window.__gomokuDebug.state;
      return { history: s.history.length, status: s.status, humanColor: s.humanColor };
    })()`);
    console.log('after again', JSON.stringify(again));
    if (again.history !== 0 || again.humanColor !== 1) throw new Error('Play again did not start a clean game');

    if (errors.length) {
      throw new Error('Browser console errors:\n' + errors.join('\n'));
    }

    console.log('UI smoke test passed');
    await send('Browser.close').catch(() => {});
    await sleep(300);
  } finally {
    if (ws) {
      try { ws.close(); } catch (err) { /* ignore */ }
    }
    try { chrome.kill(); } catch (err) { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
