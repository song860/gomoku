/*
 * Gomoku engine: rules helpers, pattern evaluation and alpha-beta search.
 * Freestyle rules: no forbidden moves, five or more in a row wins.
 *
 * The file is written as a tiny UMD module so it can run in a browser,
 * inside a Web Worker, or under Node for the test suite.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GomokuAI = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SIZE = 15;
  var N = SIZE * SIZE;
  var EMPTY = 0;
  var BLACK = 1;
  var WHITE = 2;

  var DIRS = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1]
  ];

  var WIN_SCORE = 1000000000;
  var MAX_EVAL = 300000000;

  // Scores for every five-cell window on a line. A window counts only if it
  // contains no opponent stone. Values are intentionally steep so that a
  // four is always more urgent than any number of threes.
  var WINDOW_SCORE = [0, 18, 280, 4800, 120000, 12000000];

  var FOUR_SCORE = 100000;
  var OPEN_FOUR_SCORE = 300000;
  var OPEN_THREE_SCORE = 15000;
  var THREE_SCORE = 4000;

  var OPEN_FOUR_BONUS = 180000;
  var OPEN_THREE_BONUS = 12000;
  var BROKEN_THREE_BONUS = 8000;

  var POW3 = [1, 3, 9, 27, 81, 243, 729, 2187, 6561];
  var LOCAL_STATES = 19683; // 3^9

  var ABORT = { aborted: true };

  function now() {
    if (typeof performance !== 'undefined' && performance.now) {
      return performance.now();
    }
    return Date.now();
  }

  function makeRng(seed) {
    var s = seed >>> 0;
    return function () {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s;
    };
  }

  function buildLines() {
    var lines = [];
    var cellLines = [];
    var i;
    for (i = 0; i < N; i++) cellLines.push([]);

    function addLine(cells) {
      if (cells.length < 5) return;
      var id = lines.length;
      lines.push(cells);
      for (var k = 0; k < cells.length; k++) cellLines[cells[k]].push(id);
    }

    var x, y, cells;
    for (y = 0; y < SIZE; y++) {
      cells = [];
      for (x = 0; x < SIZE; x++) cells.push(y * SIZE + x);
      addLine(cells);
    }
    for (x = 0; x < SIZE; x++) {
      cells = [];
      for (y = 0; y < SIZE; y++) cells.push(y * SIZE + x);
      addLine(cells);
    }

    var starts = [];
    for (x = 0; x < SIZE; x++) starts.push([x, 0, 1, 1]);
    for (y = 1; y < SIZE; y++) starts.push([0, y, 1, 1]);
    for (x = 0; x < SIZE; x++) starts.push([x, 0, -1, 1]);
    for (y = 1; y < SIZE; y++) starts.push([SIZE - 1, y, -1, 1]);

    for (var s = 0; s < starts.length; s++) {
      x = starts[s][0];
      y = starts[s][1];
      var dx = starts[s][2];
      var dy = starts[s][3];
      cells = [];
      while (x >= 0 && x < SIZE && y >= 0 && y < SIZE) {
        cells.push(y * SIZE + x);
        x += dx;
        y += dy;
      }
      addLine(cells);
    }

    return { lines: lines, cellLines: cellLines };
  }

  function buildLocalCells() {
    var result = [];
    for (var cell = 0; cell < N; cell++) {
      var x = cell % SIZE;
      var y = (cell / SIZE) | 0;
      var dirs = [];
      for (var d = 0; d < 4; d++) {
        var dx = DIRS[d][0];
        var dy = DIRS[d][1];
        var seq = [];
        for (var off = -4; off <= 4; off++) {
          var nx = x + dx * off;
          var ny = y + dy * off;
          if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE) {
            seq.push(ny * SIZE + nx);
          } else {
            seq.push(-1);
          }
        }
        dirs.push(seq);
      }
      result.push(dirs);
    }
    return result;
  }

  function countWindow(digits, start) {
    var own = 0;
    var opp = 0;
    for (var i = 0; i < 5; i++) {
      var v = digits[start + i];
      if (v === 1) own++;
      else if (v === 2) opp++;
    }
    return { own: own, opp: opp };
  }

  function buildLocalTable() {
    var scores = new Int32Array(LOCAL_STATES);
    var wins = new Uint8Array(LOCAL_STATES);
    var digits = new Array(9);

    for (var code = 0; code < LOCAL_STATES; code++) {
      var rest = code;
      for (var i = 8; i >= 0; i--) {
        digits[i] = rest % 3;
        rest = (rest / 3) | 0;
      }
      // The tables describe the value of putting *our* stone at the centre.
      digits[4] = 1;

      var score = 0;
      var win = 0;
      for (var start = 0; start <= 4; start++) {
        var w = countWindow(digits, start);
        if (w.opp === 0) {
          score += WINDOW_SCORE[w.own];
          if (w.own === 5) win = 1;
        }
      }

      // Extra shape bonuses, counted only when the centre belongs to the shape.
      var str = digits.join('');
      for (var s = 0; s <= 3; s++) {
        var six = str.slice(s, s + 6);
        if (six === '011110') score += OPEN_FOUR_BONUS;
        else if (six === '011100' || six === '001110') score += OPEN_THREE_BONUS;
        else if (six === '010110' || six === '011010') score += BROKEN_THREE_BONUS;
      }
      for (var t = 0; t <= 4; t++) {
        if (str.slice(t, t + 5) === '01110') score += OPEN_THREE_BONUS;
      }

      scores[code] = score;
      wins[code] = win;
    }

    return { scores: scores, wins: wins };
  }

  var builtLines = buildLines();
  var LINE_CELLS = builtLines.lines;
  var CELL_LINES = builtLines.cellLines;
  var LOCAL_CELLS = buildLocalCells();
  var localTables = buildLocalTable();
  var LOCAL_SCORE = localTables.scores;
  var LOCAL_WIN = localTables.wins;

  var rng = makeRng(0x51f15e1d);
  var Z1 = new Int32Array(N * 2);
  var Z2 = new Int32Array(N * 2);
  for (var zi = 0; zi < N * 2; zi++) {
    Z1[zi] = rng() | 0;
    Z2[zi] = rng() | 0;
  }

  function inBounds(x, y) {
    return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
  }

  function wouldWin(board, cell, player) {
    var x = cell % SIZE;
    var y = (cell / SIZE) | 0;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0];
      var dy = DIRS[d][1];
      var count = 1;
      var nx = x + dx;
      var ny = y + dy;
      while (inBounds(nx, ny) && board[ny * SIZE + nx] === player) {
        count++;
        nx += dx;
        ny += dy;
      }
      nx = x - dx;
      ny = y - dy;
      while (inBounds(nx, ny) && board[ny * SIZE + nx] === player) {
        count++;
        nx -= dx;
        ny -= dy;
      }
      if (count >= 5) return true;
    }
    return false;
  }

  function getWinningLine(board, cell, player) {
    var x = cell % SIZE;
    var y = (cell / SIZE) | 0;
    var all = [];
    var seen = Object.create(null);
    var found = false;

    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0];
      var dy = DIRS[d][1];
      var line = [cell];
      var nx = x + dx;
      var ny = y + dy;
      while (inBounds(nx, ny) && board[ny * SIZE + nx] === player) {
        line.push(ny * SIZE + nx);
        nx += dx;
        ny += dy;
      }
      nx = x - dx;
      ny = y - dy;
      while (inBounds(nx, ny) && board[ny * SIZE + nx] === player) {
        line.unshift(ny * SIZE + nx);
        nx -= dx;
        ny -= dy;
      }
      if (line.length >= 5) {
        found = true;
        for (var i = 0; i < line.length; i++) {
          if (!seen[line[i]]) {
            seen[line[i]] = true;
            all.push(line[i]);
          }
        }
      }
    }
    return found ? all : null;
  }

  function isFull(board) {
    for (var i = 0; i < N; i++) {
      if (board[i] === EMPTY) return false;
    }
    return true;
  }

  function GomokuAI() {
    this._pair = [0, 0];
    this._tt = [new Map(), new Map(), new Map()];
    this._nodes = 0;
    this._deadline = 0;
    this._killers = null;
    this._history = null;
    this._rootMoves = null;
  }

  GomokuAI.prototype._scoreLine = function (board, lineId) {
    var cells = LINE_CELLS[lineId];
    var len = cells.length;
    var s1 = 0;
    var s2 = 0;
    for (var i = 0; i <= len - 5; i++) {
      var c1 = 0;
      var c2 = 0;
      for (var j = 0; j < 5; j++) {
        var v = board[cells[i + j]];
        if (v === 1) c1++;
        else if (v === 2) c2++;
      }
      if (c2 === 0) s1 += WINDOW_SCORE[c1];
      if (c1 === 0) s2 += WINDOW_SCORE[c2];
    }
    this._pair[0] = s1;
    this._pair[1] = s2;
  };

  GomokuAI.prototype._createState = function (source) {
    var board = new Uint8Array(N);
    for (var i = 0; i < N; i++) board[i] = source[i] | 0;

    var line1 = new Float64Array(LINE_CELLS.length);
    var line2 = new Float64Array(LINE_CELLS.length);
    var total1 = 0;
    var total2 = 0;
    for (var l = 0; l < LINE_CELLS.length; l++) {
      this._scoreLine(board, l);
      line1[l] = this._pair[0];
      line2[l] = this._pair[1];
      total1 += this._pair[0];
      total2 += this._pair[1];
    }

    var neighbor = new Int16Array(N);
    var key1 = 0;
    var key2 = 0;
    var stones = 0;
    for (i = 0; i < N; i++) {
      var v = board[i];
      if (v === EMPTY) continue;
      stones++;
      key1 = (key1 ^ Z1[i * 2 + (v - 1)]) >>> 0;
      key2 = (key2 ^ Z2[i * 2 + (v - 1)]) >>> 0;
      var x = i % SIZE;
      var y = (i / SIZE) | 0;
      for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue;
          var nx = x + dx;
          var ny = y + dy;
          if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE) {
            neighbor[ny * SIZE + nx]++;
          }
        }
      }
    }

    return {
      board: board,
      line1: line1,
      line2: line2,
      total1: total1,
      total2: total2,
      neighbor: neighbor,
      key1: key1,
      key2: key2,
      stones: stones,
      stack: []
    };
  };

  GomokuAI.prototype._apply = function (state, cell, player) {
    var board = state.board;
    board[cell] = player;
    var ids = CELL_LINES[cell];
    for (var k = 0; k < ids.length; k++) {
      var id = ids[k];
      state.total1 -= state.line1[id];
      state.total2 -= state.line2[id];
      this._scoreLine(board, id);
      state.line1[id] = this._pair[0];
      state.line2[id] = this._pair[1];
      state.total1 += this._pair[0];
      state.total2 += this._pair[1];
    }

    var x = cell % SIZE;
    var y = (cell / SIZE) | 0;
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        var nx = x + dx;
        var ny = y + dy;
        if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE) {
          state.neighbor[ny * SIZE + nx]++;
        }
      }
    }

    state.key1 = (state.key1 ^ Z1[cell * 2 + (player - 1)]) >>> 0;
    state.key2 = (state.key2 ^ Z2[cell * 2 + (player - 1)]) >>> 0;
    state.stones++;
    state.stack.push(cell);
  };

  GomokuAI.prototype._undo = function (state) {
    var cell = state.stack.pop();
    var player = state.board[cell];
    if (player === EMPTY) return;
    state.board[cell] = EMPTY;

    var ids = CELL_LINES[cell];
    for (var k = 0; k < ids.length; k++) {
      var id = ids[k];
      state.total1 -= state.line1[id];
      state.total2 -= state.line2[id];
      this._scoreLine(state.board, id);
      state.line1[id] = this._pair[0];
      state.line2[id] = this._pair[1];
      state.total1 += this._pair[0];
      state.total2 += this._pair[1];
    }

    var x = cell % SIZE;
    var y = (cell / SIZE) | 0;
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        var nx = x + dx;
        var ny = y + dy;
        if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE) {
          state.neighbor[ny * SIZE + nx]--;
        }
      }
    }

    state.key1 = (state.key1 ^ Z1[cell * 2 + (player - 1)]) >>> 0;
    state.key2 = (state.key2 ^ Z2[cell * 2 + (player - 1)]) >>> 0;
    state.stones--;
  };

  GomokuAI.prototype._candidateCells = function (state) {
    var board = state.board;
    var out = [];
    for (var i = 0; i < N; i++) {
      if (board[i] === EMPTY && state.neighbor[i] > 0) out.push(i);
    }
    if (out.length === 0) {
      if (state.stones === 0) {
        var c = (SIZE * SIZE - 1) / 2;
        if (board[c] === EMPTY) out.push(c);
      } else {
        for (i = 0; i < N; i++) {
          if (board[i] === EMPTY) out.push(i);
        }
      }
    }
    return out;
  };

  GomokuAI.prototype._analyzePoint = function (state, cell, side) {
    var board = state.board;
    var ownScore = 0;
    var oppScore = 0;
    var ownWin = false;
    var oppWin = false;
    var ownFours = 0;
    var oppFours = 0;
    var ownThrees = 0;
    var oppThrees = 0;

    for (var d = 0; d < 4; d++) {
      var seq = LOCAL_CELLS[cell][d];
      var ownCodeBase = 0;
      var oppCodeBase = 0;
      for (var pos = 0; pos < 9; pos++) {
        var id = seq[pos];
        var ownDigit;
        var oppDigit;
        if (id < 0) {
          // Out of board blocks both players.
          ownDigit = 2;
          oppDigit = 2;
        } else {
          var v = board[id];
          if (v === 0) {
            ownDigit = 0;
            oppDigit = 0;
          } else if (v === side) {
            ownDigit = 1;
            oppDigit = 2;
          } else {
            ownDigit = 2;
            oppDigit = 1;
          }
        }
        var weight = POW3[8 - pos];
        ownCodeBase += ownDigit * weight;
        oppCodeBase += oppDigit * weight;
      }

      var ownCode = ownCodeBase + POW3[4];
      var oppCode = oppCodeBase + POW3[4];
      var os = LOCAL_SCORE[ownCode];
      var ps = LOCAL_SCORE[oppCode];

      ownScore += os;
      oppScore += ps;

      if (LOCAL_WIN[ownCode]) ownWin = true;
      if (LOCAL_WIN[oppCode]) oppWin = true;

      if (os >= OPEN_FOUR_SCORE) ownFours += 2;
      else if (os >= FOUR_SCORE) ownFours++;
      if (ps >= OPEN_FOUR_SCORE) oppFours += 2;
      else if (ps >= FOUR_SCORE) oppFours++;

      if (os >= OPEN_THREE_SCORE) ownThrees++;
      if (ps >= OPEN_THREE_SCORE) oppThrees++;
    }

    var ownBonus = 0;
    var oppBonus = 0;
    if (ownFours >= 2) ownBonus += 6000000;
    else if (ownFours >= 1 && ownThrees >= 1) ownBonus += 1200000;
    else if (ownThrees >= 2) ownBonus += 250000;

    if (oppFours >= 2) oppBonus += 6000000;
    else if (oppFours >= 1 && oppThrees >= 1) oppBonus += 1200000;
    else if (oppThrees >= 2) oppBonus += 250000;

    var x = cell % SIZE;
    var y = (cell / SIZE) | 0;
    var centerBonus = (14 - Math.abs(x - 7) - Math.abs(y - 7)) * 2;

    return {
      cell: cell,
      ownScore: ownScore + ownBonus,
      oppScore: oppScore + oppBonus,
      ownWin: ownWin,
      oppWin: oppWin,
      ownFours: ownFours,
      oppFours: oppFours,
      order: ownScore + ownBonus + (oppScore + oppBonus) * 1.12 + centerBonus
    };
  };

  GomokuAI.prototype._generateMoves = function (state, side, ply, depth, ttMove) {
    var cells = this._candidateCells(state);
    if (cells.length === 0) return [];

    var scored = new Array(cells.length);
    var i;
    var hasOwnWin = false;
    var hasOppWin = false;

    for (i = 0; i < cells.length; i++) {
      var a = this._analyzePoint(state, cells[i], side);
      scored[i] = a;
      if (a.ownWin) hasOwnWin = true;
      if (a.oppWin) hasOppWin = true;
    }

    if (hasOwnWin) {
      var winners = [];
      for (i = 0; i < scored.length; i++) {
        if (scored[i].ownWin) winners.push(scored[i]);
      }
      winners.sort(function (a, b) { return b.ownScore - a.ownScore; });
      return [{ cell: winners[0].cell, ownWin: true }];
    }

    if (hasOppWin) {
      var blocks = [];
      for (i = 0; i < scored.length; i++) {
        if (scored[i].oppWin) blocks.push(scored[i]);
      }
      blocks.sort(function (a, b) { return b.oppScore - a.oppScore; });
      return blocks.map(function (b) {
        return { cell: b.cell, ownWin: false };
      });
    }

    var killer = this._killers && ply < this._killers.length ? this._killers[ply] : null;
    var history = this._history;
    for (i = 0; i < scored.length; i++) {
      var m = scored[i];
      var order = m.order;
      if (m.cell === ttMove) order += 1e12;
      if (killer) {
        if (m.cell === killer[0]) order += 8000000;
        else if (m.cell === killer[1]) order += 4000000;
      }
      if (history) order += Math.min(history[m.cell], 2000000);
      m.order = order;
    }
    scored.sort(function (a, b) { return b.order - a.order; });

    var limit;
    if (ply === 0) limit = 22;
    else if (depth >= 6) limit = 14;
    else if (depth >= 4) limit = 12;
    else limit = 10;

    var result = new Array(Math.min(limit, scored.length));
    for (i = 0; i < result.length; i++) {
      result[i] = { cell: scored[i].cell, ownWin: false };
    }
    return result;
  };

  GomokuAI.prototype._evaluate = function (state, side) {
    var value;
    if (side === BLACK) {
      value = state.total1 - state.total2 * 1.04;
    } else {
      value = state.total2 - state.total1 * 1.04;
    }
    if (value > MAX_EVAL) value = MAX_EVAL;
    if (value < -MAX_EVAL) value = -MAX_EVAL;
    return value;
  };

  GomokuAI.prototype._ttKey = function (state) {
    return (state.key1 >>> 11) * 4294967296 + state.key2;
  };

  GomokuAI.prototype._checkTime = function () {
    if (now() > this._deadline) throw ABORT;
  };

  GomokuAI.prototype._negamax = function (state, depth, alpha, beta, side, ply) {
    this._nodes++;
    if ((this._nodes & 511) === 0) this._checkTime();

    if (depth <= 0) return this._evaluate(state, side);

    var ttKey = this._ttKey(state);
    var table = this._tt[side];
    var tt = table.get(ttKey);
    var ttMove = -1;
    if (tt) {
      ttMove = tt.move;
      if (tt.depth >= depth) {
        if (tt.flag === 0) return tt.score;
        if (tt.flag === 1 && tt.score >= beta) return tt.score;
        if (tt.flag === 2 && tt.score <= alpha) return tt.score;
      }
    }

    var moves = this._generateMoves(state, side, ply, depth, ttMove);
    if (moves.length === 0) return 0;

    var bestScore = -WIN_SCORE;
    var bestMove = moves[0].cell;
    var originalAlpha = alpha;
    var opp = 3 - side;

    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      this._apply(state, m.cell, side);
      var score;
      if (m.ownWin) {
        score = WIN_SCORE - ply - 1;
      } else if (i === 0) {
        score = -this._negamax(state, depth - 1, -beta, -alpha, opp, ply + 1);
      } else {
        score = -this._negamax(state, depth - 1, -alpha - 1, -alpha, opp, ply + 1);
        if (score > alpha && score < beta) {
          score = -this._negamax(state, depth - 1, -beta, -alpha, opp, ply + 1);
        }
      }
      this._undo(state);

      if (score > bestScore) {
        bestScore = score;
        bestMove = m.cell;
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        if (this._history) this._history[m.cell] += depth * depth;
        if (this._killers && ply < this._killers.length) {
          var k = this._killers[ply];
          if (k[0] !== m.cell) {
            k[1] = k[0];
            k[0] = m.cell;
          }
        }
        break;
      }
    }

    var flag = bestScore <= originalAlpha ? 2 : (bestScore >= beta ? 1 : 0);
    table.set(ttKey, { depth: depth, score: bestScore, flag: flag, move: bestMove });
    if (table.size > 260000) table.clear();
    return bestScore;
  };

  GomokuAI.prototype._searchRoot = function (state, side, depth, preferred) {
    var moves = this._generateMoves(state, side, 0, depth, preferred);
    if (moves.length === 0) {
      return { move: -1, score: 0, aborted: false, moves: [] };
    }

    var opp = 3 - side;
    var alpha = -WIN_SCORE;
    var beta = WIN_SCORE;
    var bestMove = moves[0].cell;
    var bestScore = -WIN_SCORE;
    var rootScores = [];

    for (var i = 0; i < moves.length; i++) {
      if ((i & 3) === 0) this._checkTime();
      var m = moves[i];
      this._apply(state, m.cell, side);
      var score;
      if (m.ownWin) {
        score = WIN_SCORE - 1;
      } else if (i === 0) {
        score = -this._negamax(state, depth - 1, -beta, -alpha, opp, 1);
      } else {
        score = -this._negamax(state, depth - 1, -alpha - 1, -alpha, opp, 1);
        if (score > alpha && score < beta) {
          score = -this._negamax(state, depth - 1, -beta, -alpha, opp, 1);
        }
      }
      this._undo(state);

      rootScores.push({ cell: m.cell, score: score });
      if (score > bestScore) {
        bestScore = score;
        bestMove = m.cell;
      }
      if (score > alpha) alpha = score;
    }

    return { move: bestMove, score: bestScore, aborted: false, moves: rootScores };
  };

  GomokuAI.prototype.search = function (board, side, options) {
    options = options || {};
    var timeLimit = Math.max(80, Math.min(options.timeLimit || 3000, 20000));
    var maxDepth = Math.max(1, Math.min(options.maxDepth || 8, 16));
    var start = now();
    this._deadline = start + timeLimit;
    this._nodes = 0;
    this._killers = [];
    for (var k = 0; k < 32; k++) this._killers.push([-1, -1]);
    this._history = new Int32Array(N);

    var state = this._createState(board);
    var rootMoves = this._generateMoves(state, side, 0, maxDepth, -1);
    if (rootMoves.length === 0) {
      return {
        move: -1, score: 0, depth: 0, nodes: 0,
        time: now() - start, reason: isFull(board) ? 'draw' : 'no-move'
      };
    }

    if (rootMoves[0].ownWin) {
      return {
        move: rootMoves[0].cell, score: WIN_SCORE, depth: 0,
        nodes: 0, time: now() - start, reason: 'win-now'
      };
    }

    var best = {
      move: rootMoves[0].cell,
      score: 0,
      depth: 0,
      nodes: 0,
      time: 0,
      reason: 'ordered'
    };
    var preferred = best.move;

    for (var depth = 2; depth <= maxDepth; depth += 2) {
      if (now() > this._deadline - 15) break;
      this._nodes = 0;
      var result;
      try {
        result = this._searchRoot(state, side, depth, preferred);
      } catch (err) {
        if (err !== ABORT) throw err;
        break;
      }
      if (result.move < 0) break;
      best = {
        move: result.move,
        score: result.score,
        depth: depth,
        nodes: this._nodes,
        time: now() - start,
        reason: 'search'
      };
      preferred = result.move;
      this._rootMoves = result.moves;
      if (options.onProgress) {
        options.onProgress({
          depth: depth,
          score: result.score,
          nodes: this._nodes,
          time: now() - start
        });
      }
      if (result.score >= WIN_SCORE / 2) break;
      if (now() > this._deadline - 20) break;
    }

    // Low difficulties can pick a near-best move to feel less machine-like.
    var randomness = options.randomness || 0;
    if (randomness > 0 && best.depth > 0 && this._rootMoves && this._rootMoves.length > 1) {
      var margin = randomness;
      var candidates = this._rootMoves.filter(function (m) {
        return m.score >= best.score - margin;
      });
      if (candidates.length > 1) {
        var pick = candidates[Math.floor(Math.random() * candidates.length)];
        best.move = pick.cell;
        best.score = pick.score;
      }
    }

    best.time = now() - start;
    best.nodes = best.nodes || this._nodes;
    return best;
  };

  GomokuAI.prototype.clearTables = function () {
    this._tt[1].clear();
    this._tt[2].clear();
  };

  GomokuAI.prototype.debugPoint = function (board, cell, side) {
    var state = this._createState(board);
    var result = this._analyzePoint(state, cell, side);
    var dirs = [];
    for (var d = 0; d < 4; d++) {
      var seq = LOCAL_CELLS[cell][d];
      var ownCodeBase = 0;
      var oppCodeBase = 0;
      for (var pos = 0; pos < 9; pos++) {
        var id = seq[pos];
        var ownDigit;
        var oppDigit;
        if (id < 0) {
          ownDigit = 2;
          oppDigit = 2;
        } else {
          var v = state.board[id];
          if (v === 0) {
            ownDigit = 0;
            oppDigit = 0;
          } else if (v === side) {
            ownDigit = 1;
            oppDigit = 2;
          } else {
            ownDigit = 2;
            oppDigit = 1;
          }
        }
        var weight = POW3[8 - pos];
        ownCodeBase += ownDigit * weight;
        oppCodeBase += oppDigit * weight;
      }
      var ownCode = ownCodeBase + POW3[4];
      var oppCode = oppCodeBase + POW3[4];
      dirs.push({
        ownCode: ownCode,
        oppCode: oppCode,
        ownScore: LOCAL_SCORE[ownCode],
        oppScore: LOCAL_SCORE[oppCode],
        ownWin: LOCAL_WIN[ownCode],
        oppWin: LOCAL_WIN[oppCode]
      });
    }
    return { result: result, dirs: dirs };
  };

  GomokuAI.SIZE = SIZE;
  GomokuAI.N = N;
  GomokuAI.EMPTY = EMPTY;
  GomokuAI.BLACK = BLACK;
  GomokuAI.WHITE = WHITE;
  GomokuAI.WIN_SCORE = WIN_SCORE;
  GomokuAI.DIRS = DIRS;
  GomokuAI.checkWin = function (board, cell, player) {
    var line = getWinningLine(board, cell, player);
    return line ? { win: true, cells: line } : null;
  };
  GomokuAI.getWinningLine = getWinningLine;
  GomokuAI.wouldWin = wouldWin;
  GomokuAI.isFull = isFull;
  GomokuAI.inBounds = inBounds;

  return GomokuAI;
});
