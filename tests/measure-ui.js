'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const PROFILE = path.join(ROOT, '.measure-profile');
const ARTIFACTS = path.join(__dirname, '.artifacts');
const PAGE_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
    } catch (err) { /* wait */ }
    await sleep(100);
  }
  throw new Error('timeout ' + url);
}

(async () => {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  if (fs.existsSync(PROFILE)) fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter',
    '--disable-breakpad', '--hide-scrollbars', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE, PAGE_URL
  ], { stdio: 'ignore' });
  let ws;
  try {
    await waitForHttp('http://127.0.0.1:' + PORT + '/json/version', 12000);
    const pages = await waitForHttp('http://127.0.0.1:' + PORT + '/json', 5000);
    const page = pages.find((p) => p.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(event.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
    const send = (method, params) => new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    };
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true
    });
    await sleep(1200);
    const info = await evaluate(`(() => {
      const rect = (sel) => { const e = document.querySelector(sel); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; };
      const css = (sel) => { const e=document.querySelector(sel); if(!e) return null; const c=getComputedStyle(e); return {width:c.width,minWidth:c.minWidth,maxWidth:c.maxWidth,display:c.display,grid:c.gridTemplateColumns}; };
      return {
        innerWidth: innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        app: rect('.app-shell'),
        appCss: css('.app-shell'),
        layout: rect('.layout'),
        layoutCss: css('.layout'),
        boardCard: rect('.board-card'),
        boardCardCss: css('.board-card'),
        boardWrap: rect('.board-wrap'),
        boardCss: css('#board'),
        sidebar: rect('.sidebar'),
        topbar: rect('.topbar'),
        gear: rect('#btn-settings')
      };
    })()`);
    console.log(JSON.stringify(info, null, 2));
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(ARTIFACTS, 'shot-mobile.png'), Buffer.from(shot.data, 'base64'));
  } finally {
    if (ws) { try { ws.close(); } catch (e) {} }
    try { chrome.kill(); } catch (e) {}
    await sleep(300);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  }
})().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
