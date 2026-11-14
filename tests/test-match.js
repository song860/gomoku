'use strict';

const AI = require('../src/engine.js');
const S = AI.SIZE;
const N = S * S;

function coord(cell) {
  return String.fromCharCode(65 + (cell % S)) + (((cell / S) | 0) + 1);
}

function play(strongColor) {
  const strong = new AI();
  const weak = new AI();
  const board = new Uint8Array(N);
  let turn = 1;
  let moves = 0;
  for (; moves < 100; moves++) {
    const isStrong = turn === strongColor;
    const engine = isStrong ? strong : weak;
    const r = engine.search(board, turn, isStrong ?
      { timeLimit: 650, maxDepth: 8 } :
      { timeLimit: 90, maxDepth: 6 });
    if (r.move < 0 || board[r.move] !== 0) throw new Error('illegal move');
    board[r.move] = turn;
    if (AI.wouldWin(board, r.move, turn)) {
      return { winner: turn, moves: moves + 1, last: coord(r.move) };
    }
    turn = 3 - turn;
  }
  return { winner: 0, moves, last: '' };
}

for (let i = 0; i < 2; i++) {
  const strongColor = i === 0 ? 1 : 2;
  const result = play(strongColor);
  console.log('strong=' + (strongColor === 1 ? 'black' : 'white') +
    ' winner=' + (result.winner === 0 ? 'draw' : (result.winner === 1 ? 'black' : 'white')) +
    ' moves=' + result.moves + ' last=' + result.last);
  if (result.winner !== strongColor && result.winner !== 0) {
    console.log('NOTE: stronger search lost this game');
  }
}
