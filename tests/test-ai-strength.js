'use strict';

const AI = require('../src/engine.js');
const S = AI.SIZE;
const N = S * S;

function boardFrom(rows) {
  const b = new Uint8Array(N);
  rows.forEach((row, y) => {
    for (let x = 0; x < S; x++) {
      if (row[x] === 'X' || row[x] === 'x') b[y * S + x] = 1;
      if (row[x] === 'O' || row[x] === 'o') b[y * S + x] = 2;
    }
  });
  return b;
}

function coord(cell) {
  return String.fromCharCode(65 + (cell % S)) + (((cell / S) | 0) + 1);
}

function footprint(b) {
  const out = [];
  for (let y = 0; y < S; y++) {
    let row = '';
    for (let x = 0; x < S; x++) {
      const v = b[y * S + x];
      row += v === 1 ? 'X' : v === 2 ? 'O' : '.';
    }
    out.push(row);
  }
  return out.join('\n');
}

function nearMoves(b, radius) {
  const out = [];
  let stones = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (b[y * S + x]) stones++;
    }
  }
  if (!stones) return [7 * S + 7];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (b[y * S + x]) continue;
      let near = false;
      for (let dy = -radius; dy <= radius && !near; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < S && ny >= 0 && ny < S && b[ny * S + nx]) {
            near = true;
            break;
          }
        }
      }
      if (near) out.push(y * S + x);
    }
  }
  return out;
}

function greedyOpponent(b, p) {
  const opp = 3 - p;
  const cells = nearMoves(b, 2);
  for (const c of cells) {
    b[c] = p;
    const win = AI.wouldWin(b, c, p);
    b[c] = 0;
    if (win) return c;
  }
  for (const c of cells) {
    b[c] = opp;
    const win = AI.wouldWin(b, c, opp);
    b[c] = 0;
    if (win) return c;
  }
  return cells[Math.floor(Math.random() * cells.length)];
}

function playGame(aiColor, aiTime, maxDepth, opponent) {
  const b = new Uint8Array(N);
  const ai = new AI();
  const history = [];
  let turn = 1;
  for (let ply = 0; ply < N; ply++) {
    if (AI.isFull(b)) return { result: 'draw', history };
    let move;
    if (turn === aiColor) {
      const r = ai.search(b, turn, { timeLimit: aiTime, maxDepth });
      move = r.move;
      if (move < 0 || b[move] !== 0) throw new Error('illegal AI move ' + move);
      if (ply < 12 || ply % 10 === 0) {
        console.log('  ai ' + coord(move) + ' d=' + r.depth + ' n=' + r.nodes + ' t=' + Math.round(r.time));
      }
    } else {
      move = opponent(b, turn);
      if (move == null || b[move] !== 0) throw new Error('illegal opponent move ' + move);
    }
    b[move] = turn;
    history.push({ move, turn });
    if (AI.wouldWin(b, move, turn)) {
      return { result: turn === aiColor ? 'ai-win' : 'opponent-win', history };
    }
    turn = 3 - turn;
  }
  return { result: 'draw', history };
}

console.log('Tactical checks');

{
  const b = boardFrom([
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '......OOO......',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............'
  ]);
  const ai = new AI();
  const r = ai.search(b, 1, { timeLimit: 1200, maxDepth: 6 });
  console.log('  block open three ->', coord(r.move), 'd=' + r.depth, 'score=' + Math.round(r.score));
  const x = r.move % S;
  const y = (r.move / S) | 0;
  const ok = y === 7 && (x === 5 || x === 9);
  console.log('  ' + (ok ? 'ok' : 'NOTE') + ': expected one of F8/J8');
}

{
  const b = boardFrom([
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '......XXX......',
    '.......O.......',
    '.......O.......',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............'
  ]);
  const ai = new AI();
  const r = ai.search(b, 1, { timeLimit: 1200, maxDepth: 6 });
  console.log('  extend open three ->', coord(r.move), 'd=' + r.depth, 'score=' + Math.round(r.score));
  console.log('  ' + ((r.move % S === 5 || r.move % S === 9) && ((r.move / S) | 0) === 7 ? 'ok' : 'NOTE') + ': expected F8/J8');
}

console.log('\nSelf play (AI vs AI, 220ms/move)');
{
  const game = playGame(1, 220, 8, (b, p) => {
    // The "opponent" is a second engine search, but separate to vary TT.
    const other = new AI();
    const r = other.search(b, p, { timeLimit: 220, maxDepth: 8 });
    return r.move;
  });
  console.log('result:', game.result, 'moves:', game.history.length);
  console.log('last moves:', game.history.slice(-8).map((m) => coord(m.move) + (m.turn === 1 ? 'X' : 'O')).join(' '));
}

console.log('\nAI vs greedy opponent');
for (let i = 0; i < 3; i++) {
  const aiColor = i % 2 === 0 ? 1 : 2;
  const game = playGame(aiColor, 180, 8, greedyOpponent);
  console.log('game', i + 1, 'AI', aiColor === 1 ? 'black' : 'white', '=>', game.result, 'moves', game.history.length);
  console.log('last:', game.history.slice(-6).map((m) => coord(m.move) + (m.turn === 1 ? 'X' : 'O')).join(' '));
}
