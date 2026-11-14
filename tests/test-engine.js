'use strict';

const assert = require('assert');
const AI = require('../src/engine.js');

const S = AI.SIZE;

function boardFrom(rows) {
  const b = new Uint8Array(S * S);
  rows.forEach((row, y) => {
    for (let x = 0; x < S; x++) {
      const ch = row[x];
      if (ch === 'X' || ch === 'x') b[y * S + x] = 1;
      else if (ch === 'O' || ch === 'o') b[y * S + x] = 2;
    }
  });
  return b;
}

function emptyBoard() {
  return new Uint8Array(S * S);
}

function place(b, x, y, p) {
  b[y * S + x] = p;
}

function xy(cell) {
  return [cell % S, (cell / S) | 0];
}

function isOneOf(cell, list) {
  return list.some(([x, y]) => cell === y * S + x);
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (err) {
    console.error('FAIL  ' + name);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }
}

console.log('Rules');

test('horizontal five wins', () => {
  const b = emptyBoard();
  for (let x = 3; x <= 7; x++) place(b, x, 7, 1);
  const win = AI.checkWin(b, 7 * S + 7, 1);
  assert(win && win.cells.length >= 5);
});

test('vertical five wins', () => {
  const b = emptyBoard();
  for (let y = 2; y <= 6; y++) place(b, 8, y, 2);
  const win = AI.checkWin(b, 6 * S + 8, 2);
  assert(win && win.cells.length >= 5);
});

test('diagonal five wins', () => {
  const b = emptyBoard();
  for (let i = 0; i < 5; i++) place(b, 4 + i, 4 + i, 1);
  assert(AI.checkWin(b, 8 * S + 8, 1));
});

test('anti-diagonal five wins', () => {
  const b = emptyBoard();
  for (let i = 0; i < 5; i++) place(b, 10 - i, 3 + i, 2);
  assert(AI.checkWin(b, 7 * S + 6, 2));
});

test('overline counts as a win', () => {
  const b = emptyBoard();
  for (let x = 2; x <= 7; x++) place(b, x, 9, 1);
  const win = AI.checkWin(b, 9 * S + 5, 1);
  assert(win && win.cells.length === 6);
});

test('four is not a win', () => {
  const b = emptyBoard();
  for (let x = 3; x <= 6; x++) place(b, x, 5, 1);
  assert.strictEqual(AI.checkWin(b, 5 * S + 6, 1), null);
});

test('wrong player is not a win', () => {
  const b = emptyBoard();
  for (let x = 3; x <= 7; x++) place(b, x, 5, 1);
  assert.strictEqual(AI.checkWin(b, 5 * S + 7, 2), null);
});

test('full board is detected', () => {
  const b = new Uint8Array(S * S).fill(1);
  assert.strictEqual(AI.isFull(b), true);
  b[42] = 0;
  assert.strictEqual(AI.isFull(b), false);
});

console.log('Search tactics');

test('AI takes an immediate win', () => {
  const b = emptyBoard();
  for (let x = 4; x <= 7; x++) place(b, x, 7, 1);
  place(b, 7, 8, 2);
  place(b, 6, 8, 2);
  const ai = new AI();
  const r = ai.search(b, 1, { timeLimit: 800, maxDepth: 4 });
  assert(isOneOf(r.move, [[3, 7], [8, 7]]), 'expected winning move, got ' + xy(r.move));
});

test('AI blocks an immediate loss', () => {
  const b = emptyBoard();
  for (let x = 4; x <= 7; x++) place(b, x, 7, 1);
  place(b, 5, 5, 2);
  place(b, 6, 6, 2);
  const ai = new AI();
  const r = ai.search(b, 2, { timeLimit: 800, maxDepth: 4 });
  assert(isOneOf(r.move, [[3, 7], [8, 7]]), 'expected block, got ' + xy(r.move));
});

test('AI opens in the centre', () => {
  const b = emptyBoard();
  const ai = new AI();
  const r = ai.search(b, 1, { timeLimit: 300, maxDepth: 2 });
  assert.strictEqual(r.move, 7 * S + 7);
});

test('AI does not mutate the input board', () => {
  const b = emptyBoard();
  place(b, 7, 7, 1);
  place(b, 8, 8, 2);
  const before = Array.from(b);
  const ai = new AI();
  ai.search(b, 1, { timeLimit: 400, maxDepth: 4 });
  assert.deepStrictEqual(Array.from(b), before);
});

test('edge contexts do not fabricate wins', () => {
  const b = emptyBoard();
  place(b, 7, 7, 1);
  place(b, 7, 8, 1);
  place(b, 6, 7, 1);
  place(b, 3, 14, 1);
  place(b, 6, 6, 2);
  place(b, 7, 10, 2);
  place(b, 5, 12, 2);
  const ai = new AI();
  const point = ai.debugPoint(b, 14 * S + 1, 2);
  assert.strictEqual(point.result.ownWin, false);
  assert.strictEqual(point.result.oppWin, false);
  const r = ai.search(b, 2, { timeLimit: 300, maxDepth: 4 });
  assert.notStrictEqual(r.reason, 'win-now');
});

test('white can win along the bottom edge', () => {
  const b = emptyBoard();
  for (let x = 0; x < 4; x++) place(b, x, 14, 2);
  place(b, 5, 14, 1);
  const ai = new AI();
  const r = ai.search(b, 2, { timeLimit: 800, maxDepth: 4 });
  assert.strictEqual(r.move, 14 * S + 4);
});

test('AI finds a four and wins on the following move', () => {
  const b = boardFrom([
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '......X........',
    '.....X.O.......',
    '....X..O.......',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............'
  ]);
  // Black can play (7,9) to make four; white cannot stop both ends? This is
  // primarily a smoke test that a forcing move is preferred.
  const ai = new AI();
  const r = ai.search(b, 1, { timeLimit: 1200, maxDepth: 4 });
  assert(r.move >= 0);
  assert.strictEqual(b[r.move], 0);
});

test('midgame search stays within its time budget', () => {
  const b = boardFrom([
    '...............',
    '...............',
    '...............',
    '.......O.......',
    '......XO.......',
    '.....XOX.......',
    '......XO.......',
    '.......X.......',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............'
  ]);
  const ai = new AI();
  const t = Date.now();
  const r = ai.search(b, 1, { timeLimit: 1000, maxDepth: 8 });
  const elapsed = Date.now() - t;
  assert(r.move >= 0);
  assert(elapsed < 1900, 'search took too long: ' + elapsed);
  console.log('       depth=' + r.depth + ' nodes=' + r.nodes + ' time=' + Math.round(r.time) + 'ms score=' + Math.round(r.score));
});

console.log('\n' + passed + ' tests passed');
