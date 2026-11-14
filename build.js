'use strict';

/*
 * Zero-dependency build step. It inlines the stylesheet, engine, worker glue,
 * Rapfi WebAssembly build and application code into one self-contained
 * index.html that can be opened directly from disk or served by a static host.
 */
const fs = require('fs');
const path = require('path');

const root = __dirname;

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function readBase64(file) {
  return fs.readFileSync(path.join(root, file)).toString('base64');
}

function escapeScript(text) {
  return text.replace(/<\/script/gi, '<\\/script');
}

let html = read('src/template.html');
const css = read('src/styles.css');
const engine = read('src/engine.js');
const worker = read('src/worker.js');
const app = read('src/app.js');

/*
 * Rapfi is shipped as an Emscripten ES module. Convert it to a classic worker
 * script so it can be loaded from a Blob URL under file:// as well.
 */
const rapfiGlue = read('vendor/rapfi/rapfi.js')
  .replace(/\bimport\.meta\.url\b/g, 'self.location.href')
  .replace(/export default Rapfi;\s*$/, '');
const rapfiWasm = readBase64('vendor/rapfi/rapfi.wasm');
const rapfiData = readBase64('vendor/rapfi/rapfi.data');
const rapfiWorker = read('src/rapfi-worker.js')
  .split('/*__RAPFI_GLUE__*/').join(rapfiGlue)
  .split('__RAPFI_WASM_B64__').join(rapfiWasm)
  .split('__RAPFI_DATA_B64__').join(rapfiData);

html = html
  .split('/*__CSS__*/').join(css)
  .split('/*__ENGINE__*/').join(escapeScript(engine))
  .split('/*__WORKER__*/').join(escapeScript(worker))
  .split('/*__RAPFI_WORKER__*/').join(escapeScript(rapfiWorker))
  .split('/*__APP__*/').join(escapeScript(app));

fs.writeFileSync(path.join(root, 'index.html'), html, 'utf8');

const bytes = Buffer.byteLength(html, 'utf8');
console.log('Built index.html (' + (bytes / 1024).toFixed(1) + ' KB)');
