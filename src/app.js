(function () {
  'use strict';

  /* The engine is embedded as text so the final HTML is a single file. */
  var engineText = document.getElementById('engine-source').textContent;
  var workerSource = document.getElementById('worker-source').textContent;
  var rapfiWorkerSource = document.getElementById('rapfi-worker-source').textContent;
  var engineScript = document.createElement('script');
  engineScript.textContent = engineText;
  document.head.appendChild(engineScript);

  var AI = window.GomokuAI;
  if (!AI) {
    document.body.innerHTML = '<p style="padding:40px;font-family:sans-serif">引擎加载失败，请刷新页面。</p>';
    return;
  }

  var SIZE = AI.SIZE;
  var N = AI.N;
  var EMPTY = AI.EMPTY;
  var BLACK = AI.BLACK;
  var WHITE = AI.WHITE;
  var COLS = 'ABCDEFGHIJKLMNO';
  var CENTER = 7 * SIZE + 7;

  var DIFFICULTIES = {
    easy: { label: '入门', timeLabel: '单步 < 1 秒', timeLimit: 350, maxDepth: 2, randomness: 28000 },
    normal: { label: '普通', timeLabel: '单步约 1 秒', timeLimit: 900, maxDepth: 4, randomness: 0 },
    strong: { label: '较强', timeLabel: '单步约 3 秒', timeLimit: 2600, maxDepth: 6, randomness: 0 },
    master: { label: '大师', timeLabel: '单步约 6 秒', timeLimit: 6000, maxDepth: 10, randomness: 0 },
    nightmare: {
      label: '噩梦',
      timeLabel: 'Rapfi · 约 7 秒',
      timeLimit: 7000,
      maxDepth: 0,
      randomness: 0,
      engine: 'Rapfi'
    }
  };

  var SAVE_KEY = 'gomoku.save.v1';
  var SETTINGS_KEY = 'gomoku.settings.v1';
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var state = {
    board: new Uint8Array(N),
    history: [],
    turn: BLACK,
    humanColor: BLACK,
    aiColor: WHITE,
    difficulty: 'master',
    status: 'playing',
    winner: 0,
    winLine: null,
    winAt: 0,
    hintCell: -1,
    hintLoading: false,
    gameId: 0,
    aiRequestId: 0,
    currentAIRequest: null,
    currentHintRequest: null,
    aiProgress: null,
    aiContext: null,
    lastAI: null,
    anim: new Map(),
    keyboardCell: CENTER,
    hoverCell: -1,
    resultSoundPlayed: false,
    compatNotified: false,
    engineOffline: false,
    nightmareWorker: null,
    nightmareWorkerPromise: null,
    nightmareWorkerUrl: null,
    nightmareEpoch: 0,
    nightmareToken: null,
    nightmareTimer: 0,
    engineRecovery: null,
    settings: {
      sound: true,
      animation: !reduceMotion,
      coordinates: true,
      numbers: false
    }
  };

  var els = {
    board: document.getElementById('board'),
    boardWrap: document.getElementById('board-wrap'),
    turnPill: document.getElementById('turn-pill'),
    turnStone: document.getElementById('turn-stone'),
    turnText: document.getElementById('turn-text'),
    moveCount: document.getElementById('move-count'),
    sideLabel: document.getElementById('side-label'),
    legendTurn: document.getElementById('legend-turn'),
    statusOrb: document.getElementById('status-orb'),
    statusTitle: document.getElementById('status-title'),
    statusSub: document.getElementById('status-sub'),
    aiProgress: document.getElementById('ai-progress'),
    aiProgressText: document.getElementById('ai-progress-text'),
    aiStats: document.getElementById('ai-stats'),
    btnNew: document.getElementById('btn-new'),
    btnUndo: document.getElementById('btn-undo'),
    btnHint: document.getElementById('btn-hint'),
    btnResign: document.getElementById('btn-resign'),
    btnSettings: document.getElementById('btn-settings'),
    btnAgain: document.getElementById('btn-again'),
    difficultyName: document.getElementById('difficulty-name'),
    difficultyTime: document.getElementById('difficulty-time'),
    difficultyGroup: document.getElementById('difficulty-group'),
    historyList: document.getElementById('history-list'),
    historyCount: document.getElementById('history-count'),
    resultBanner: document.getElementById('result-banner'),
    resultIcon: document.getElementById('result-icon'),
    resultTitle: document.getElementById('result-title'),
    resultSub: document.getElementById('result-sub'),
    newDialog: document.getElementById('new-dialog'),
    newForm: document.getElementById('new-form'),
    colorChoice: document.getElementById('color-choice'),
    newDifficulty: document.getElementById('new-difficulty'),
    btnStart: document.getElementById('btn-start'),
    settingsDialog: document.getElementById('settings-dialog'),
    setSound: document.getElementById('set-sound'),
    setAnimation: document.getElementById('set-animation'),
    setCoordinates: document.getElementById('set-coordinates'),
    setNumbers: document.getElementById('set-numbers'),
    btnResetSave: document.getElementById('btn-reset-save'),
    engineDialog: document.getElementById('engine-dialog'),
    engineTitle: document.getElementById('engine-title'),
    engineMessage: document.getElementById('engine-message'),
    btnEngineRetry: document.getElementById('btn-engine-retry'),
    btnEngineFallback: document.getElementById('btn-engine-fallback'),
    toast: document.getElementById('toast'),
    brandHome: document.getElementById('brand-home')
  };

  var ctx = els.board.getContext('2d');
  var view = { w: 0, h: 0, dpr: 1, pad: 36, grid: 0, cell: 0, r: 0 };
  var bgCanvas = document.createElement('canvas');
  var rafId = 0;
  var toastTimer = 0;
  var newColor = BLACK;
  var newDifficulty = 'master';
  var audioCtx = null;
  var localAI = new AI();

  /* Workers ----------------------------------------------------------------- */
  var worker = null;
  var workerPromise = null;
  var workerUrl = null;
  var workerUnavailable = false;
  var workerEpoch = 0;

  function resetWorker() {
    var unavailable = workerUnavailable;
    workerEpoch++;
    if (worker) {
      try { worker.terminate(); } catch (err) { /* ignore */ }
    }
    if (workerUrl) {
      try { URL.revokeObjectURL(workerUrl); } catch (err) { /* ignore */ }
    }
    worker = null;
    workerPromise = null;
    workerUrl = null;
    workerUnavailable = unavailable;
  }

  function ensureWorker() {
    if (workerPromise) return workerPromise;
    if (workerUnavailable) return Promise.reject(new Error('worker unavailable'));

    var epoch = workerEpoch;
    workerPromise = new Promise(function (resolve, reject) {
      var w;
      try {
        var code = engineText + '\n' + workerSource;
        var blob = new Blob([code], { type: 'application/javascript' });
        workerUrl = URL.createObjectURL(blob);
        w = new Worker(workerUrl);
      } catch (err) {
        workerUnavailable = true;
        reject(err);
        return;
      }

      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        workerUnavailable = true;
        try { w.terminate(); } catch (err) { /* ignore */ }
        reject(new Error('worker startup timed out'));
      }, 4200);

      w.onmessage = function (event) {
        var data = event.data || {};
        if (data.type === 'ready') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (epoch !== workerEpoch) {
            try { w.terminate(); } catch (err) { /* ignore */ }
            reject(new Error('worker was reset'));
            return;
          }
          worker = w;
          resolve(w);
          return;
        }
        handleWorkerMessage(data);
      };

      w.onerror = function (event) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          workerUnavailable = true;
          try { w.terminate(); } catch (err) { /* ignore */ }
          reject(new Error(event.message || 'worker error'));
        } else {
          workerUnavailable = true;
          handleWorkerCrash(event.message || 'worker error');
        }
      };
    });

    return workerPromise;
  }

  function handleWorkerMessage(data) {
    if (data.type === 'progress') {
      if (data.id === state.currentAIRequest) {
        state.aiProgress = data;
        updateProgressUI();
      }
      return;
    }

    if (data.type === 'result') {
      if (data.id === state.currentAIRequest) {
        handleAIResult(data.result, data.id, state.gameId);
      } else if (data.id === state.currentHintRequest) {
        handleHintResult(data.result, data.id);
      }
      return;
    }

    if (data.type === 'error') {
      if (data.id === state.currentAIRequest) {
        handleWorkerCrash(data.message || 'AI 计算异常');
      } else if (data.id === state.currentHintRequest) {
        state.hintLoading = false;
        state.currentHintRequest = null;
        showToast('提示计算失败，请再试一次');
        updateUI();
      }
    }
  }

  function handleWorkerCrash(message) {
    workerUnavailable = true;
    worker = null;
    workerPromise = null;
    if (!state.compatNotified) {
      state.compatNotified = true;
      showToast('后台计算不可用，已切换兼容模式');
    }
    if (state.currentAIRequest && state.aiContext && !state.aiContext.fallbackStarted) {
      state.aiContext.fallbackStarted = true;
      runFallbackAI(state.aiContext);
    } else if (state.currentHintRequest && state.hintLoading) {
      runFallbackHint();
    }
  }

  function runFallbackAI(context) {
    if (!context || context.token !== state.currentAIRequest) return;
    if (context.fallbackQueued) return;
    context.fallbackStarted = true;
    context.fallbackQueued = true;
    workerUnavailable = true;
    if (!state.compatNotified) {
      state.compatNotified = true;
      showToast('后台计算不可用，已切换兼容模式');
    }

    var options = {
      timeLimit: Math.min(context.options.timeLimit || 2000, 1800),
      maxDepth: Math.min(context.options.maxDepth || 6, 6),
      randomness: context.options.randomness || 0
    };

    setTimeout(function () {
      if (context.token !== state.currentAIRequest || state.status !== 'thinking') return;
      try {
        var result = localAI.search(context.board, context.player, options);
        handleAIResult(result, context.token, context.gameId);
      } catch (err) {
        if (context.token === state.currentAIRequest) {
          state.status = 'playing';
          state.currentAIRequest = null;
          state.aiContext = null;
          showToast('AI 计算失败，请重试');
          updateUI();
        }
      }
    }, 80);
  }

  function runFallbackHint() {
    var token = state.currentHintRequest;
    if (!token || !state.hintLoading) return;
    var board = Array.from(state.board);
    var human = state.humanColor;

    setTimeout(function () {
      if (token !== state.currentHintRequest) return;
      try {
        var result = localAI.search(board, human, { timeLimit: 900, maxDepth: 4 });
        handleHintResult(result, token);
      } catch (err) {
        state.hintLoading = false;
        state.currentHintRequest = null;
        showToast('提示计算失败，请再试一次');
        updateUI();
      }
    }, 60);
  }

  /* Nightmare engine (Rapfi WebAssembly) ----------------------------------- */
  function clearNightmareTimer() {
    if (state.nightmareTimer) {
      clearTimeout(state.nightmareTimer);
      state.nightmareTimer = 0;
    }
  }

  function resetNightmareWorker() {
    state.nightmareEpoch++;
    clearNightmareTimer();
    if (state.nightmareWorker) {
      try { state.nightmareWorker.terminate(); } catch (err) { /* ignore */ }
    }
    if (state.nightmareWorkerUrl) {
      try { URL.revokeObjectURL(state.nightmareWorkerUrl); } catch (err) { /* ignore */ }
    }
    state.nightmareWorker = null;
    state.nightmareWorkerPromise = null;
    state.nightmareWorkerUrl = null;
  }

  function nightmareSupported() {
    return typeof Worker !== 'undefined' &&
      typeof Blob !== 'undefined' &&
      typeof URL !== 'undefined' &&
      typeof WebAssembly !== 'undefined';
  }

  function ensureNightmareWorker() {
    if (state.nightmareWorkerPromise) return state.nightmareWorkerPromise;
    if (!nightmareSupported()) {
      return Promise.reject(new Error('当前浏览器不支持 WebAssembly Web Worker。'));
    }

    var epoch = state.nightmareEpoch;
    state.nightmareWorkerPromise = new Promise(function (resolve, reject) {
      var w;
      try {
        var blob = new Blob([rapfiWorkerSource], { type: 'application/javascript' });
        state.nightmareWorkerUrl = URL.createObjectURL(blob);
        w = new Worker(state.nightmareWorkerUrl);
      } catch (err) {
        reject(err);
        return;
      }

      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { w.terminate(); } catch (err) { /* ignore */ }
        reject(new Error('Rapfi 工作线程启动超时。'));
      }, 12000);

      w.onmessage = function (event) {
        var data = event.data || {};
        if (data.type === 'ready') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (epoch !== state.nightmareEpoch) {
            try { w.terminate(); } catch (err) { /* ignore */ }
            reject(new Error('Rapfi 工作线程已被重置。'));
            return;
          }
          state.nightmareWorker = w;
          resolve(w);
          return;
        }
        handleNightmareMessage(data);
      };

      w.onerror = function (event) {
        var message = event && event.message ? event.message : 'Rapfi 工作线程异常。';
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { w.terminate(); } catch (err) { /* ignore */ }
          reject(new Error(message));
        } else {
          handleNightmareCrash(message);
        }
      };
    });

    return state.nightmareWorkerPromise;
  }

  function handleNightmareMessage(data) {
    if (data.type === 'progress') {
      if (data.id === state.currentAIRequest) {
        state.aiProgress = {
          engine: 'Rapfi',
          depth: data.depth || 0,
          nodes: data.nodes || 0,
          time: data.time || 0,
          score: data.score,
          message: data.message || (state.aiProgress ? state.aiProgress.message : null)
        };
        updateProgressUI();
      }
      return;
    }

    if (data.type === 'result') {
      if (data.id !== state.currentAIRequest || state.status !== 'thinking') return;
      clearNightmareTimer();
      if (!data.result || !Number.isInteger(data.result.move) ||
          data.result.move < 0 || data.result.move >= N ||
          state.board[data.result.move] !== EMPTY) {
        recoverNightmare(data.id, 'Rapfi 没有返回有效落点，请重试本手。');
        return;
      }
      state.nightmareToken = null;
      state.engineOffline = false;
      handleAIResult(data.result, data.id, state.gameId);
      return;
    }

    if (data.type === 'error') {
      if (data.id !== state.currentAIRequest) return;
      recoverNightmare(data.id, data.message || 'Rapfi 计算失败，请重试本手。');
    }
  }

  function handleNightmareCrash(message) {
    if (!state.currentAIRequest || state.status !== 'thinking') return;
    recoverNightmare(state.currentAIRequest, message || 'Rapfi 工作线程异常。');
  }

  function scheduleNightmareMove(token, context, delay) {
    function begin() {
      if (state.currentAIRequest !== token || state.gameId !== context.gameId || state.status !== 'thinking') {
        return;
      }

      state.nightmareToken = token;
      state.engineOffline = false;
      state.aiProgress = { engine: 'Rapfi', depth: 0, nodes: 0, message: '正在加载 Rapfi 引擎' };
      updateProgressUI();

      ensureNightmareWorker().then(function (w) {
        if (state.currentAIRequest !== token || state.gameId !== context.gameId || state.status !== 'thinking') {
          return;
        }
        w.postMessage({
          type: 'search',
          id: token,
          board: context.board,
          player: context.player,
          timeLimit: context.options.timeLimit
        });
      }).catch(function (err) {
        if (state.currentAIRequest !== token) return;
        recoverNightmare(token, err && err.message ? err.message : 'Rapfi 引擎启动失败。');
      });

      clearNightmareTimer();
      state.nightmareTimer = setTimeout(function () {
        if (state.currentAIRequest !== token || state.status !== 'thinking') return;
        resetNightmareWorker();
        recoverNightmare(token, 'Rapfi 计算超时，请重试本手。');
      }, 24000);
    }

    if (delay && delay > 0) {
      setTimeout(begin, delay);
    } else {
      begin();
    }
  }

  function showEngineHelp(title, message, recovery) {
    state.engineRecovery = recovery ? {
      retry: !!recovery.retry,
      fallback: !!recovery.fallback,
      gameId: state.gameId
    } : null;
    els.engineTitle.textContent = title || 'Rapfi 引擎未就绪';
    els.engineMessage.textContent = message || '';
    els.btnEngineRetry.hidden = !(recovery && recovery.retry);
    els.btnEngineFallback.hidden = !(recovery && recovery.fallback);

    if (!els.engineDialog.open) {
      els.engineDialog.showModal();
    }
    var focusTarget = !els.btnEngineRetry.hidden ? els.btnEngineRetry :
      (!els.btnEngineFallback.hidden ? els.btnEngineFallback :
        els.engineDialog.querySelector('[data-close].btn'));
    if (focusTarget) focusTarget.focus();
  }

  function recoverNightmare(token, message) {
    if (token !== state.currentAIRequest) return;
    clearNightmareTimer();
    resetNightmareWorker();
    state.currentAIRequest = null;
    state.nightmareToken = null;
    state.aiContext = null;
    state.aiProgress = null;
    state.status = 'playing';
    state.engineOffline = true;
    updateUI();
    render();
    showEngineHelp('Rapfi 引擎未就绪', message, { retry: true, fallback: true });
  }

  /* Persistence ------------------------------------------------------------- */
  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (err) { return null; }
  }

  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (err) { /* ignore */ }
  }

  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch (err) { /* ignore */ }
  }

  function loadSettings() {
    var raw = storageGet(SETTINGS_KEY);
    if (raw) {
      try {
        var saved = JSON.parse(raw);
        if (typeof saved.sound === 'boolean') state.settings.sound = saved.sound;
        if (typeof saved.animation === 'boolean') state.settings.animation = saved.animation;
        if (typeof saved.coordinates === 'boolean') state.settings.coordinates = saved.coordinates;
        if (typeof saved.numbers === 'boolean') state.settings.numbers = saved.numbers;
        if (DIFFICULTIES[saved.difficulty]) state.difficulty = saved.difficulty;
        if (saved.humanColor === BLACK || saved.humanColor === WHITE) state.humanColor = saved.humanColor;
      } catch (err) { /* ignore bad settings */ }
    }
    state.aiColor = 3 - state.humanColor;
    if (reduceMotion) state.settings.animation = false;
  }

  function saveSettings() {
    storageSet(SETTINGS_KEY, JSON.stringify({
      sound: state.settings.sound,
      animation: state.settings.animation,
      coordinates: state.settings.coordinates,
      numbers: state.settings.numbers,
      difficulty: state.difficulty,
      humanColor: state.humanColor
    }));
  }

  function saveGame() {
    var data = {
      v: 1,
      board: Array.from(state.board),
      history: state.history.map(function (move) {
        return { cell: move.cell, player: move.player };
      }),
      turn: state.turn,
      humanColor: state.humanColor,
      aiColor: state.aiColor,
      difficulty: state.difficulty,
      status: state.status === 'thinking' ? 'playing' : state.status,
      winner: state.winner,
      winLine: state.winLine ? state.winLine.slice() : null,
      lastAI: state.lastAI,
      savedAt: Date.now()
    };
    storageSet(SAVE_KEY, JSON.stringify(data));
  }

  function loadGame() {
    var raw = storageGet(SAVE_KEY);
    if (!raw) return false;

    var data;
    try { data = JSON.parse(raw); } catch (err) { return false; }
    if (!data || data.v !== 1 || !Array.isArray(data.board) || data.board.length !== N) return false;

    var board = new Uint8Array(N);
    for (var i = 0; i < N; i++) {
      var v = data.board[i];
      if (v !== EMPTY && v !== BLACK && v !== WHITE) return false;
      board[i] = v;
    }

    var history = [];
    var rebuilt = new Uint8Array(N);
    if (!Array.isArray(data.history)) return false;
    for (var h = 0; h < data.history.length; h++) {
      var move = data.history[h];
      if (!move || !Number.isInteger(move.cell) || move.cell < 0 || move.cell >= N) return false;
      if (move.player !== BLACK && move.player !== WHITE) return false;
      if (rebuilt[move.cell] !== EMPTY) return false;
      rebuilt[move.cell] = move.player;
      history.push({ cell: move.cell, player: move.player });
    }
    for (i = 0; i < N; i++) {
      if (board[i] !== rebuilt[i]) return false;
    }

    if (data.humanColor !== BLACK && data.humanColor !== WHITE) return false;
    var difficulty = DIFFICULTIES[data.difficulty] ? data.difficulty : 'master';
    var turn = history.length % 2 === 0 ? BLACK : WHITE;
    var status = data.status;
    if (status !== 'playing' && status !== 'won' && status !== 'draw' && status !== 'resigned') {
      status = 'playing';
    }

    var winner = 0;
    var winLine = null;
    if (status === 'won') {
      if (!history.length) return false;
      var last = history[history.length - 1];
      var win = AI.checkWin(board, last.cell, last.player);
      if (!win) return false;
      winner = last.player;
      winLine = win.cells;
    } else if (status === 'draw') {
      if (!AI.isFull(board)) return false;
      winner = 0;
    } else if (status === 'resigned') {
      winner = 3 - data.humanColor;
    } else {
      winner = 0;
    }

    state.board = board;
    state.history = history;
    state.humanColor = data.humanColor;
    state.aiColor = 3 - data.humanColor;
    state.difficulty = difficulty;
    state.turn = turn;
    state.status = status;
    state.winner = winner;
    state.winLine = winLine;
    state.winAt = status === 'won' ? performance.now() : 0;
    state.lastAI = data.lastAI && typeof data.lastAI === 'object' ? data.lastAI : null;
    if (state.lastAI && state.lastAI.engine === 'VibeFive') state.lastAI = null;
    state.hintCell = -1;
    state.hintLoading = false;
    state.currentAIRequest = null;
    state.currentHintRequest = null;
    state.aiProgress = null;
    state.aiContext = null;
    state.engineOffline = false;
    state.nightmareToken = null;
    state.engineRecovery = null;
    state.anim.clear();
    state.keyboardCell = CENTER;
    state.hoverCell = -1;
    state.resultSoundPlayed = status !== 'playing';
    state.gameId++;
    saveSettings();
    return true;
  }

  /* Game flow --------------------------------------------------------------- */
  function startNewGame(humanColor, difficulty) {
    cancelAI(true);
    state.gameId++;
    state.humanColor = humanColor === WHITE ? WHITE : BLACK;
    state.aiColor = 3 - state.humanColor;
    state.difficulty = DIFFICULTIES[difficulty] ? difficulty : 'master';
    state.board = new Uint8Array(N);
    state.history = [];
    state.turn = BLACK;
    state.status = 'playing';
    state.winner = 0;
    state.winLine = null;
    state.winAt = 0;
    state.hintCell = -1;
    state.hintLoading = false;
    state.currentAIRequest = null;
    state.currentHintRequest = null;
    state.aiProgress = null;
    state.aiContext = null;
    state.lastAI = null;
    state.engineOffline = false;
    state.nightmareToken = null;
    state.engineRecovery = null;
    state.anim.clear();
    state.keyboardCell = CENTER;
    state.hoverCell = -1;
    state.resultSoundPlayed = false;
    newColor = state.humanColor;
    newDifficulty = state.difficulty;

    saveSettings();
    saveGame();
    updateUI();
    render();

    if (state.turn === state.aiColor) {
      scheduleAIMove(420);
    }
  }

  function cancelAI(terminateWorker) {
    var nightmareRunning = !!state.nightmareToken;
    clearNightmareTimer();
    state.nightmareToken = null;
    if (terminateWorker || nightmareRunning) resetNightmareWorker();
    state.aiRequestId++;
    state.currentAIRequest = null;
    state.currentHintRequest = null;
    state.aiContext = null;
    state.aiProgress = null;
    state.engineOffline = false;
    if (state.status === 'thinking') state.status = 'playing';
    if (terminateWorker) resetWorker();
  }

  function scheduleAIMove(delay) {
    if (state.status !== 'playing' || state.turn !== state.aiColor) return;

    var gameId = state.gameId;
    var token = 'ai-' + gameId + '-' + (++state.aiRequestId);
    state.currentAIRequest = token;
    state.status = 'thinking';
    state.aiProgress = null;
    updateUI();
    render();

    var board = Array.from(state.board);
    var def = DIFFICULTIES[state.difficulty] || DIFFICULTIES.master;
    var options = {
      timeLimit: def.timeLimit,
      maxDepth: def.maxDepth,
      randomness: def.randomness
    };
    var context = {
      token: token,
      board: board,
      player: state.aiColor,
      gameId: gameId,
      options: options
    };
    state.aiContext = context;
    state.engineOffline = false;

    if (def.engine) {
      scheduleNightmareMove(token, context, delay);
      return;
    }

    function begin() {
      if (state.currentAIRequest !== token || state.gameId !== gameId || state.status !== 'thinking') return;
      ensureWorker().then(function (w) {
        if (state.currentAIRequest !== token || state.gameId !== gameId || state.status !== 'thinking') return;
        w.postMessage({
          type: 'search',
          id: token,
          board: board,
          player: context.player,
          options: options
        });
      }).catch(function () {
        runFallbackAI(context);
      });
    }

    if (delay && delay > 0) {
      setTimeout(begin, delay);
    } else {
      begin();
    }
  }

  function handleAIResult(result, token, gameId) {
    if (token !== state.currentAIRequest || gameId !== state.gameId || state.status !== 'thinking') return;
    state.currentAIRequest = null;
    state.aiContext = null;
    state.aiProgress = null;

    if (!result || !Number.isInteger(result.move) || result.move < 0) {
      state.status = 'playing';
      if (AI.isFull(state.board)) {
        state.status = 'draw';
      }
      updateUI();
      render();
      return;
    }

    state.lastAI = result;
    state.status = 'playing';
    state.engineOffline = false;
    if (!placeMove(result.move, state.aiColor, 'ai')) {
      state.status = 'playing';
      state.currentAIRequest = null;
      showToast('AI 落子异常，请点击“新对局”重新开始');
      updateUI();
      render();
    }
  }

  function requestHint() {
    if (!canHumanPlay() || state.hintLoading) return;

    var gameId = state.gameId;
    var token = 'hint-' + gameId + '-' + Date.now();
    state.currentHintRequest = token;
    state.hintLoading = true;
    state.hintCell = -1;
    updateUI();
    render();

    var board = Array.from(state.board);
    var human = state.humanColor;
    var options = { timeLimit: 1000, maxDepth: 4, randomness: 0 };

    ensureWorker().then(function (w) {
      if (state.currentHintRequest !== token || state.gameId !== gameId || !state.hintLoading) return;
      w.postMessage({
        type: 'search',
        id: token,
        board: board,
        player: human,
        options: options
      });
    }).catch(function () {
      runFallbackHint();
    });
  }

  function handleHintResult(result, token) {
    if (token !== state.currentHintRequest || !state.hintLoading) return;
    state.hintLoading = false;
    state.currentHintRequest = null;

    if (result && Number.isInteger(result.move) && result.move >= 0 &&
        state.board[result.move] === EMPTY &&
        state.status === 'playing' && state.turn === state.humanColor) {
      state.hintCell = result.move;
      showToast('建议落在 ' + coord(result.move));
      playHintSound();
    } else {
      showToast('暂时没有找到合适的建议');
    }
    updateUI();
    render();
  }

  function placeMove(cell, player, source) {
    if (state.status !== 'playing' || state.turn !== player) return false;
    if (!Number.isInteger(cell) || cell < 0 || cell >= N || state.board[cell] !== EMPTY) return false;

    state.hintCell = -1;
    state.hintLoading = false;
    state.currentHintRequest = null;
    state.hoverCell = -1;

    state.board[cell] = player;
    state.history.push({ cell: cell, player: player });
    if (state.settings.animation) {
      state.anim.set(cell, { start: performance.now() });
    } else {
      state.anim.delete(cell);
    }
    state.turn = 3 - player;
    state.aiProgress = null;

    var win = AI.checkWin(state.board, cell, player);
    if (win) {
      state.status = 'won';
      state.winner = player;
      state.winLine = win.cells;
      state.winAt = performance.now();
      state.turn = 3 - player;
    } else if (AI.isFull(state.board)) {
      state.status = 'draw';
      state.winner = 0;
      state.winLine = null;
    } else {
      state.status = 'playing';
    }

    playStoneSound(player);
    saveGame();
    updateUI();
    render();

    if (state.status === 'won' && !state.resultSoundPlayed) {
      state.resultSoundPlayed = true;
      playEndSound(player === state.humanColor);
    } else if (state.status === 'draw' && !state.resultSoundPlayed) {
      state.resultSoundPlayed = true;
      playDrawSound();
    }

    if (state.status === 'playing' && state.turn === state.aiColor) {
      scheduleAIMove(180);
    }
    return true;
  }

  function undo() {
    if (state.status === 'thinking' || state.hintLoading) return;
    var humanMoves = 0;
    for (var h = 0; h < state.history.length; h++) {
      if (state.history[h].player === state.humanColor) humanMoves++;
    }
    if (humanMoves === 0) return;

    cancelAI(false);
    var guard = 0;
    do {
      var last = state.history[state.history.length - 1];
      if (!last) break;
      state.board[last.cell] = EMPTY;
      state.history.pop();
      guard++;
      var nextTurn = state.history.length % 2 === 0 ? BLACK : WHITE;
      if (nextTurn === state.humanColor) break;
    } while (state.history.length > 0 && guard < 4);

    state.turn = state.history.length % 2 === 0 ? BLACK : WHITE;
    state.status = 'playing';
    state.winner = 0;
    state.winLine = null;
    state.winAt = 0;
    state.hintCell = -1;
    state.hintLoading = false;
    state.currentHintRequest = null;
    state.aiProgress = null;
    state.aiContext = null;
    state.lastAI = null;
    state.anim.clear();
    state.resultSoundPlayed = false;
    state.hoverCell = -1;

    saveGame();
    updateUI();
    render();

    if (state.turn === state.aiColor) {
      scheduleAIMove(200);
    }
  }

  function resign() {
    if (state.status !== 'playing' && state.status !== 'thinking') return;
    cancelAI(true);
    state.status = 'resigned';
    state.winner = state.aiColor;
    state.winLine = null;
    state.winAt = 0;
    state.resultSoundPlayed = true;
    state.hintCell = -1;
    state.hintLoading = false;
    saveGame();
    updateUI();
    render();
    playEndSound(false);
  }

  function canHumanPlay() {
    return state.status === 'playing' &&
      state.turn === state.humanColor &&
      !state.hintLoading;
  }

  function humanPlay(cell) {
    if (!canHumanPlay()) return;
    placeMove(cell, state.humanColor, 'human');
  }

  /* UI ---------------------------------------------------------------------- */
  function updateUI() {
    var thinking = state.status === 'thinking';
    var ended = state.status === 'won' || state.status === 'draw' || state.status === 'resigned';
    var displayPlayer = state.status === 'won' ? state.winner :
      (state.status === 'resigned' ? state.aiColor : state.turn);
    var humanName = state.humanColor === BLACK ? '黑棋' : '白棋';
    var colorName = displayPlayer === BLACK ? '黑棋' : '白棋';

    var turnLabel;
    if (thinking) turnLabel = 'AI 正在思考';
    else if (state.status === 'won') turnLabel = state.winner === state.humanColor ? '你赢了' : 'AI 获胜';
    else if (state.status === 'draw') turnLabel = '和棋';
    else if (state.status === 'resigned') turnLabel = '你已认输';
    else if (state.engineOffline) turnLabel = 'Rapfi 引擎未就绪';
    else turnLabel = state.turn === state.humanColor ? '轮到你落子' : '轮到 AI';

    els.turnPill.classList.toggle('thinking', thinking);
    els.turnText.textContent = turnLabel;
    els.turnStone.className = 'stone ' + (displayPlayer === WHITE ? 'white' : 'black');
    els.turnStone.style.opacity = state.status === 'draw' ? '0.35' : '1';

    els.moveCount.textContent = ended ? '共 ' + state.history.length + ' 手' : '第 ' + (state.history.length + 1) + ' 手';
    els.sideLabel.textContent = '你执' + (state.humanColor === BLACK ? '黑' : '白') + ' · ' + (state.humanColor === BLACK ? '先手' : '后手');
    els.legendTurn.textContent = thinking ? '电脑思考中' :
      (state.engineOffline ? '等待引擎' : (ended ? '对局结束' : (state.turn === state.humanColor ? '你的回合' : '电脑回合')));

    els.statusTitle.textContent = turnLabel;
    if (thinking) {
      els.statusSub.textContent = 'AI 执' + (state.aiColor === BLACK ? '黑' : '白') + ' · 正在计算';
    } else if (state.status === 'won') {
      els.statusSub.textContent = (state.winner === BLACK ? '黑棋' : '白棋') + '五连 · 共 ' + state.history.length + ' 手';
    } else if (state.status === 'draw') {
      els.statusSub.textContent = '棋盘已满 · 共 ' + state.history.length + ' 手';
    } else if (state.status === 'resigned') {
      els.statusSub.textContent = '已认输 · 共 ' + state.history.length + ' 手';
    } else if (state.engineOffline) {
      els.statusSub.textContent = '请重试本手，或切换到其他难度继续';
    } else {
      els.statusSub.textContent = '执' + (state.humanColor === BLACK ? '黑' : '白') + ' · ' +
        (DIFFICULTIES[state.difficulty] ? DIFFICULTIES[state.difficulty].label : '大师') + '难度';
    }

    els.statusOrb.className = 'status-orb';
    if (state.status === 'won') {
      els.statusOrb.classList.add(state.winner === state.humanColor ? 'win' : 'lose');
    } else if (state.status === 'resigned') {
      els.statusOrb.classList.add('lose');
    } else if (state.status === 'draw') {
      els.statusOrb.classList.add('draw');
    } else {
      els.statusOrb.classList.add(displayPlayer === WHITE ? 'white' : 'black');
    }

    if (thinking) {
      els.aiProgress.hidden = false;
      els.aiProgressText.textContent = progressText(state.aiProgress);
    } else {
      els.aiProgress.hidden = true;
    }

    if (state.lastAI && !thinking) {
      els.aiStats.hidden = false;
      var ai = state.lastAI;
      var stats = (ai.engine ? ai.engine + ' · ' : '') + '深度 ' + (ai.depth || 0);
      if (ai.nodes > 0) stats += ' · ' + formatNodes(ai.nodes) + ' 节点';
      stats += ' · ' + formatTime(ai.time || 0);
      els.aiStats.textContent = stats;
    } else {
      els.aiStats.hidden = true;
    }

    var humanMoves = 0;
    for (var i = 0; i < state.history.length; i++) {
      if (state.history[i].player === state.humanColor) humanMoves++;
    }
    els.btnUndo.disabled = thinking || humanMoves === 0 || state.hintLoading;
    els.btnHint.disabled = !canHumanPlay() || state.hintLoading;
    els.btnHint.textContent = state.hintLoading ? '寻找中…' : '提示';
    els.btnResign.disabled = state.status !== 'playing' && state.status !== 'thinking';
    els.btnNew.disabled = false;

    updateDifficultyUI();
    updateResultUI();
    renderHistory();

    els.board.classList.toggle('can-play', canHumanPlay());
    els.board.setAttribute('aria-label', state.status === 'playing' ?
      '五子棋棋盘，' + (state.turn === state.humanColor ? '轮到你落子' :
        (state.engineOffline ? '等待 Rapfi 引擎' : '电脑思考中')) :
      '五子棋棋盘，' + turnLabel);
    document.title = thinking ? 'AI 思考中 · 五子棋' :
      (state.engineOffline ? 'Rapfi 引擎未就绪 · 五子棋' :
        (ended ? turnLabel + ' · 五子棋' : '五子棋 · 人机对战'));

    if (state.status === 'won' && state.winAt) {
      requestRender();
    }
  }

  function progressText(progress) {
    if (progress && progress.depth) {
      var text = (progress.engine ? progress.engine + ' · ' : '') +
        '深度 ' + progress.depth;
      if (progress.nodes > 0) text += ' · ' + formatNodes(progress.nodes) + ' 节点';
      return text;
    }
    if (progress && progress.message) return progress.message;
    return '正在计算局面';
  }

  function updateProgressUI() {
    if (state.status !== 'thinking') {
      els.aiProgress.hidden = true;
      return;
    }
    els.aiProgress.hidden = false;
    els.aiProgressText.textContent = progressText(state.aiProgress);
  }

  function updateDifficultyUI() {
    var def = DIFFICULTIES[state.difficulty] || DIFFICULTIES.master;
    els.difficultyName.textContent = def.label;
    els.difficultyTime.textContent = def.timeLabel;
    var buttons = els.difficultyGroup.querySelectorAll('[data-difficulty]');
    for (var i = 0; i < buttons.length; i++) {
      var active = buttons[i].getAttribute('data-difficulty') === state.difficulty;
      buttons[i].classList.toggle('active', active);
      buttons[i].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function updateResultUI() {
    var ended = state.status === 'won' || state.status === 'draw' || state.status === 'resigned';
    if (!ended) {
      els.resultBanner.hidden = true;
      return;
    }

    els.resultBanner.hidden = false;
    els.resultIcon.className = 'result-icon';
    if (state.status === 'won' && state.winner === state.humanColor) {
      els.resultIcon.textContent = '✓';
      els.resultTitle.textContent = '你赢了';
      els.resultSub.textContent = (state.humanColor === BLACK ? '黑棋' : '白棋') + '五连 · 共 ' + state.history.length + ' 手';
    } else if (state.status === 'won') {
      els.resultIcon.textContent = '×';
      els.resultIcon.classList.add('lose');
      els.resultTitle.textContent = 'AI 获胜';
      els.resultSub.textContent = '再试一局，或悔棋复盘';
    } else if (state.status === 'draw') {
      els.resultIcon.textContent = '—';
      els.resultIcon.classList.add('draw');
      els.resultTitle.textContent = '和棋';
      els.resultSub.textContent = '棋盘已满 · 共 ' + state.history.length + ' 手';
    } else {
      els.resultIcon.textContent = '×';
      els.resultIcon.classList.add('lose');
      els.resultTitle.textContent = '你已认输';
      els.resultSub.textContent = '共 ' + state.history.length + ' 手';
    }
  }

  function renderHistory() {
    var list = els.historyList;
    els.historyCount.textContent = state.history.length + ' 手';
    if (!state.history.length) {
      list.innerHTML = '<div class="history-empty">落子后，棋谱会显示在这里。</div>';
      return;
    }

    var fragment = document.createDocumentFragment();
    for (var i = 0; i < state.history.length; i++) {
      var move = state.history[i];
      var row = document.createElement('div');
      row.className = 'move-row' + (i === state.history.length - 1 ? ' latest' : '');

      var idx = document.createElement('span');
      idx.className = 'move-index';
      idx.textContent = String(i + 1).padStart(2, '0');

      var stone = document.createElement('i');
      stone.className = 'stone ' + (move.player === BLACK ? 'black' : 'white');

      var coordEl = document.createElement('span');
      coordEl.className = 'move-coord';
      coordEl.textContent = coord(move.cell);

      var tag = document.createElement('span');
      tag.className = 'move-tag';
      tag.textContent = move.player === state.humanColor ? '你' : '电脑';

      row.appendChild(idx);
      row.appendChild(stone);
      row.appendChild(coordEl);
      row.appendChild(tag);
      fragment.appendChild(row);
    }
    list.innerHTML = '';
    list.appendChild(fragment);
    list.scrollTop = list.scrollHeight;
  }

  function coord(cell) {
    var x = cell % SIZE;
    var y = (cell / SIZE) | 0;
    return COLS.charAt(x) + (y + 1);
  }

  function formatNodes(n) {
    var value = Math.max(0, Math.round(Number(n) || 0));
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatTime(ms) {
    if (!ms) return '0ms';
    if (ms < 1000) return Math.round(ms) + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.classList.remove('show');
    }, 2400);
  }

  /* Audio ------------------------------------------------------------------- */
  function ensureAudio() {
    if (!state.settings.sound) return null;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch (err) {
      return null;
    }
  }

  function tone(frequency, duration, type, volume, delay) {
    var ac = ensureAudio();
    if (!ac) return;
    try {
      var start = ac.currentTime + (delay || 0);
      var osc = ac.createOscillator();
      var gain = ac.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume || 0.035, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(start);
      osc.stop(start + duration + 0.02);
    } catch (err) { /* ignore audio errors */ }
  }

  function playStoneSound(player) {
    if (!state.settings.sound) return;
    tone(player === BLACK ? 190 : 230, 0.08, 'sine', 0.032, 0);
    tone(player === BLACK ? 95 : 115, 0.11, 'triangle', 0.018, 0.008);
  }

  function playHintSound() {
    if (!state.settings.sound) return;
    tone(620, 0.09, 'sine', 0.018, 0);
  }

  function playEndSound(won) {
    if (!state.settings.sound) return;
    if (won) {
      tone(523.25, 0.18, 'sine', 0.035, 0);
      tone(659.25, 0.2, 'sine', 0.03, 0.12);
      tone(783.99, 0.32, 'sine', 0.03, 0.24);
    } else {
      tone(220, 0.24, 'sine', 0.028, 0);
      tone(164.81, 0.36, 'sine', 0.024, 0.14);
    }
  }

  function playDrawSound() {
    if (!state.settings.sound) return;
    tone(392, 0.16, 'sine', 0.025, 0);
    tone(329.63, 0.22, 'sine', 0.022, 0.12);
  }

  /* Board rendering --------------------------------------------------------- */
  function resizeBoard() {
    var width = els.boardWrap.clientWidth;
    if (!width) return;
    var height = els.boardWrap.clientHeight || width;
    var size = Math.min(width, height);
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);

    els.board.width = Math.round(size * dpr);
    els.board.height = Math.round(size * dpr);
    view.w = size;
    view.h = size;
    view.dpr = dpr;
    view.pad = size < 430 ? 24 : (size < 620 ? 30 : 38);
    view.grid = size - view.pad * 2;
    view.cell = view.grid / (SIZE - 1);
    view.r = view.cell * 0.425;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildBackground(size);
    render();
  }

  function buildBackground(size) {
    var dpr = view.dpr;
    bgCanvas.width = Math.round(size * dpr);
    bgCanvas.height = Math.round(size * dpr);
    var g = bgCanvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);

    var wood = g.createLinearGradient(0, 0, size, size);
    wood.addColorStop(0, '#ecd2ae');
    wood.addColorStop(0.45, '#e0bb8b');
    wood.addColorStop(1, '#d3a56f');
    g.fillStyle = wood;
    g.fillRect(0, 0, size, size);

    var wash = g.createRadialGradient(size * 0.28, size * 0.18, size * 0.05, size * 0.5, size * 0.5, size * 0.8);
    wash.addColorStop(0, 'rgba(255, 250, 236, 0.34)');
    wash.addColorStop(0.55, 'rgba(255, 247, 229, 0.06)');
    wash.addColorStop(1, 'rgba(112, 68, 31, 0.08)');
    g.fillStyle = wash;
    g.fillRect(0, 0, size, size);

    for (var i = 0; i < 34; i++) {
      var y = (i + 0.5) * (size / 34) + Math.sin(i * 1.7) * size * 0.006;
      g.beginPath();
      for (var x = -10; x <= size + 10; x += Math.max(8, size / 18)) {
        var yy = y + Math.sin((x / size) * Math.PI * 2.2 + i * 1.3) * size * 0.0035;
        if (x === -10) g.moveTo(x, yy);
        else g.lineTo(x, yy);
      }
      g.strokeStyle = i % 5 === 0 ? 'rgba(102, 65, 31, 0.075)' : 'rgba(102, 65, 31, 0.038)';
      g.lineWidth = i % 5 === 0 ? 1.1 : 0.6;
      g.stroke();
    }

    var topLight = g.createLinearGradient(0, 0, 0, size);
    topLight.addColorStop(0, 'rgba(255, 255, 255, 0.16)');
    topLight.addColorStop(0.28, 'rgba(255, 255, 255, 0)');
    topLight.addColorStop(0.82, 'rgba(90, 54, 24, 0)');
    topLight.addColorStop(1, 'rgba(90, 54, 24, 0.1)');
    g.fillStyle = topLight;
    g.fillRect(0, 0, size, size);

    drawGrid(g, size);
  }

  function drawGrid(g, size) {
    var pad = view.pad;
    var cell = view.cell;
    var end = size - pad;

    g.save();
    g.strokeStyle = 'rgba(78, 51, 26, 0.52)';
    g.lineWidth = 1;
    g.beginPath();
    for (var i = 0; i < SIZE; i++) {
      var p = pad + i * cell;
      g.moveTo(pad, p);
      g.lineTo(end, p);
      g.moveTo(p, pad);
      g.lineTo(p, end);
    }
    g.stroke();

    g.strokeStyle = 'rgba(66, 41, 20, 0.72)';
    g.lineWidth = 1.5;
    g.strokeRect(pad - 0.5, pad - 0.5, view.grid + 1, view.grid + 1);

    var stars = [
      [3, 3], [11, 3], [3, 11], [11, 11], [7, 7]
    ];
    g.fillStyle = 'rgba(63, 38, 18, 0.76)';
    for (i = 0; i < stars.length; i++) {
      g.beginPath();
      g.arc(pad + stars[i][0] * cell, pad + stars[i][1] * cell, Math.max(2, cell * 0.07), 0, Math.PI * 2);
      g.fill();
    }

    if (state.settings.coordinates) {
      var labelSize = Math.max(9, Math.min(12, size * 0.017));
      g.font = '600 ' + labelSize + 'px "Segoe UI", "PingFang SC", sans-serif';
      g.fillStyle = 'rgba(74, 48, 25, 0.58)';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (i = 0; i < SIZE; i++) {
        g.fillText(COLS.charAt(i), pad + i * cell, pad * 0.48);
        g.fillText(String(i + 1), pad * 0.46, pad + i * cell);
      }
    }
    g.restore();
  }

  function drawStone(g, x, y, color, radius, options) {
    options = options || {};
    var scale = options.scale == null ? 1 : options.scale;
    var alpha = options.alpha == null ? 1 : options.alpha;
    var number = options.number;
    var shadow = options.shadow !== false;

    g.save();
    g.globalAlpha = alpha;
    g.translate(x, y);
    g.scale(scale, scale);

    if (shadow) {
      g.shadowColor = 'rgba(58, 35, 18, 0.38)';
      g.shadowBlur = radius * 0.6;
      g.shadowOffsetY = radius * 0.18;
    }

    g.beginPath();
    g.arc(0, 0, radius, 0, Math.PI * 2);
    var grad;
    if (color === BLACK) {
      grad = g.createRadialGradient(-radius * 0.34, -radius * 0.4, radius * 0.06, 0, 0, radius * 1.08);
      grad.addColorStop(0, '#6f675d');
      grad.addColorStop(0.32, '#3a3530');
      grad.addColorStop(0.72, '#1b1917');
      grad.addColorStop(1, '#0d0d0c');
    } else {
      grad = g.createRadialGradient(-radius * 0.34, -radius * 0.4, radius * 0.05, 0, 0, radius * 1.08);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.38, '#fbf6ea');
      grad.addColorStop(0.78, '#e7ddcc');
      grad.addColorStop(1, '#cbbda6');
    }
    g.fillStyle = grad;
    g.fill();
    g.shadowColor = 'transparent';
    g.shadowBlur = 0;
    g.shadowOffsetY = 0;

    g.strokeStyle = color === BLACK ? 'rgba(0, 0, 0, 0.32)' : 'rgba(98, 76, 50, 0.26)';
    g.lineWidth = Math.max(0.5, radius * 0.035);
    g.stroke();

    if (number != null && number !== '') {
      g.fillStyle = color === BLACK ? 'rgba(255, 248, 235, 0.88)' : 'rgba(72, 55, 36, 0.74)';
      g.font = '600 ' + Math.max(6, radius * 0.72) + 'px "SFMono-Regular", Consolas, monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(number), 0, 0.5);
    }
    g.restore();
  }

  function winSegment(cells) {
    if (!cells || cells.length < 5) return null;
    var points = cells.map(function (cell) {
      return [cell % SIZE, (cell / SIZE) | 0];
    }).sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var dx = points[1][0] - points[0][0];
    var dy = points[1][1] - points[0][1];
    if (!(dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy))) return null;
    for (var i = 2; i < points.length; i++) {
      if (points[i][0] - points[i - 1][0] !== dx || points[i][1] - points[i - 1][1] !== dy) {
        return null;
      }
    }
    return [points[0], points[points.length - 1]];
  }

  function render(timestamp) {
    if (!view.w) return;
    var now = timestamp || performance.now();
    var g = ctx;
    g.clearRect(0, 0, view.w, view.h);
    g.drawImage(bgCanvas, 0, 0, view.w, view.h);

    var lastMove = state.history.length ? state.history[state.history.length - 1] : null;
    var lastCell = lastMove ? lastMove.cell : -1;

    for (var i = 0; i < N; i++) {
      var player = state.board[i];
      if (player === EMPTY) continue;
      var x = view.pad + (i % SIZE) * view.cell;
      var y = view.pad + (((i / SIZE) | 0)) * view.cell;
      var scale = 1;
      var anim = state.anim.get(i);
      if (anim) {
        var t = Math.min(1, (now - anim.start) / 210);
        if (t >= 1) {
          state.anim.delete(i);
        } else {
          var eased = 1 - Math.pow(1 - t, 3);
          scale = 0.58 + 0.42 * eased;
        }
      }
      drawStone(g, x, y, player, view.r, {
        scale: scale,
        number: state.settings.numbers ? moveNumberAt(i) : null
      });
    }

    if (lastCell >= 0 && state.board[lastCell] !== EMPTY && state.status !== 'draw') {
      var lx = view.pad + (lastCell % SIZE) * view.cell;
      var ly = view.pad + (((lastCell / SIZE) | 0)) * view.cell;
      g.save();
      if (state.settings.numbers) {
        g.beginPath();
        g.arc(lx, ly, view.r * 0.76, 0, Math.PI * 2);
        g.strokeStyle = 'rgba(167, 95, 63, 0.9)';
        g.lineWidth = Math.max(1.2, view.r * 0.07);
        g.stroke();
      } else {
        g.beginPath();
        g.arc(lx, ly, Math.max(2, view.r * 0.14), 0, Math.PI * 2);
        g.fillStyle = '#b46443';
        g.shadowColor = 'rgba(255, 248, 235, 0.8)';
        g.shadowBlur = 2;
        g.fill();
      }
      g.restore();
    }

    if (state.status === 'won' && state.winLine) {
      drawWinHighlight(g, now);
    }

    if (state.hintCell >= 0 && state.board[state.hintCell] === EMPTY) {
      drawHint(g, state.hintCell);
    }

    if (canHumanPlay() && state.hoverCell >= 0 && state.board[state.hoverCell] === EMPTY &&
        state.hoverCell !== state.hintCell) {
      var hx = view.pad + (state.hoverCell % SIZE) * view.cell;
      var hy = view.pad + (((state.hoverCell / SIZE) | 0)) * view.cell;
      drawStone(g, hx, hy, state.humanColor, view.r, { alpha: 0.22, shadow: false });
    }

    if (document.activeElement === els.board) {
      var kx = view.pad + (state.keyboardCell % SIZE) * view.cell;
      var ky = view.pad + (((state.keyboardCell / SIZE) | 0)) * view.cell;
      g.save();
      g.strokeStyle = 'rgba(63, 107, 90, 0.72)';
      g.lineWidth = 1.6;
      g.setLineDash([4, 3]);
      g.beginPath();
      g.arc(kx, ky, view.r * 1.16, 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }

    if (state.anim.size > 0) requestRender();
    if (state.status === 'won' && state.winAt && now - state.winAt < 2300) requestRender();
  }

  function moveNumberAt(cell) {
    for (var i = 0; i < state.history.length; i++) {
      if (state.history[i].cell === cell) return i + 1;
    }
    return null;
  }

  function drawWinHighlight(g, now) {
    var segment = winSegment(state.winLine);
    var pulse = 0.5 + 0.5 * Math.sin((now - state.winAt) / 280);
    g.save();
    if (segment) {
      var x1 = view.pad + segment[0][0] * view.cell;
      var y1 = view.pad + segment[0][1] * view.cell;
      var x2 = view.pad + segment[1][0] * view.cell;
      var y2 = view.pad + segment[1][1] * view.cell;
      g.strokeStyle = 'rgba(63, 107, 90, 0.42)';
      g.lineWidth = Math.max(4, view.r * 0.48);
      g.lineCap = 'round';
      g.shadowColor = 'rgba(63, 107, 90, 0.7)';
      g.shadowBlur = view.r * 1.3;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    }

    for (var i = 0; i < state.winLine.length; i++) {
      var cell = state.winLine[i];
      var x = view.pad + (cell % SIZE) * view.cell;
      var y = view.pad + (((cell / SIZE) | 0)) * view.cell;
      g.beginPath();
      g.arc(x, y, view.r * 1.04, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(78, 132, 108, ' + (0.82 + 0.16 * pulse) + ')';
      g.lineWidth = Math.max(2, view.r * 0.11);
      g.shadowColor = 'rgba(63, 107, 90, 0.8)';
      g.shadowBlur = view.r * 0.9;
      g.stroke();
      g.beginPath();
      g.arc(x, y, view.r * 0.9, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(255, 250, 240, ' + (0.3 + 0.18 * pulse) + ')';
      g.lineWidth = 1;
      g.shadowBlur = 0;
      g.stroke();
    }
    g.restore();
  }

  function drawHint(g, cell) {
    var x = view.pad + (cell % SIZE) * view.cell;
    var y = view.pad + (((cell / SIZE) | 0)) * view.cell;
    g.save();
    g.strokeStyle = 'rgba(167, 95, 63, 0.9)';
    g.lineWidth = Math.max(1.5, view.r * 0.09);
    g.setLineDash([4, 3]);
    g.shadowColor = 'rgba(167, 95, 63, 0.4)';
    g.shadowBlur = 7;
    g.beginPath();
    g.arc(x, y, view.r * 1.14, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    g.beginPath();
    g.arc(x, y, Math.max(2, view.r * 0.16), 0, Math.PI * 2);
    g.fillStyle = 'rgba(167, 95, 63, 0.92)';
    g.fill();
    g.restore();
  }

  function requestRender() {
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  function frame(timestamp) {
    rafId = 0;
    var active = false;
    state.anim.forEach(function (anim, cell) {
      if (timestamp - anim.start > 240) state.anim.delete(cell);
      else active = true;
    });
    render(timestamp);
    if (active || (state.status === 'won' && state.winAt && timestamp - state.winAt < 2300)) {
      requestRender();
    }
  }

  /* Canvas input ------------------------------------------------------------ */
  function cellAtEvent(event) {
    var rect = els.board.getBoundingClientRect();
    if (!rect.width || !rect.height) return -1;
    var x = (event.clientX - rect.left) * (view.w / rect.width);
    var y = (event.clientY - rect.top) * (view.h / rect.height);
    var gx = (x - view.pad) / view.cell;
    var gy = (y - view.pad) / view.cell;
    var ix = Math.round(gx);
    var iy = Math.round(gy);
    if (ix < 0 || ix >= SIZE || iy < 0 || iy >= SIZE) return -1;
    if (Math.abs(gx - ix) > 0.52 || Math.abs(gy - iy) > 0.52) return -1;
    return iy * SIZE + ix;
  }

  function updateHover(cell) {
    if (state.hoverCell === cell) return;
    state.hoverCell = cell;
    els.board.classList.toggle('can-play', canHumanPlay() && cell >= 0);
    requestRender();
  }

  var touchStart = null;

  function handlePointerMove(event) {
    if (event.pointerType === 'touch') return;
    if (!canHumanPlay()) {
      updateHover(-1);
      return;
    }
    var cell = cellAtEvent(event);
    if (cell >= 0 && state.board[cell] !== EMPTY) cell = -1;
    updateHover(cell);
  }

  function handlePointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    ensureAudio();
    if (!canHumanPlay()) return;

    if (event.pointerType === 'touch') {
      // Wait for pointerup so a swipe can scroll the page without placing.
      touchStart = {
        x: event.clientX,
        y: event.clientY,
        cell: cellAtEvent(event)
      };
      return;
    }

    var cell = cellAtEvent(event);
    if (cell < 0 || state.board[cell] !== EMPTY) return;
    event.preventDefault();
    humanPlay(cell);
  }

  function handlePointerUp(event) {
    if (event.pointerType !== 'touch' || !touchStart) return;
    var start = touchStart;
    touchStart = null;
    var dx = event.clientX - start.x;
    var dy = event.clientY - start.y;
    if (dx * dx + dy * dy > 144) return;
    var cell = start.cell;
    if (cell < 0 || state.board[cell] !== EMPTY) return;
    humanPlay(cell);
  }

  function handleCanvasKeyDown(event) {
    var key = event.key;
    var x = state.keyboardCell % SIZE;
    var y = (state.keyboardCell / SIZE) | 0;
    var moved = false;
    if (key === 'ArrowLeft') { x = Math.max(0, x - 1); moved = true; }
    else if (key === 'ArrowRight') { x = Math.min(SIZE - 1, x + 1); moved = true; }
    else if (key === 'ArrowUp') { y = Math.max(0, y - 1); moved = true; }
    else if (key === 'ArrowDown') { y = Math.min(SIZE - 1, y + 1); moved = true; }
    else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      humanPlay(state.keyboardCell);
      return;
    } else if (key === 'Home') {
      x = 7; y = 7; moved = true;
    }
    if (moved) {
      event.preventDefault();
      state.keyboardCell = y * SIZE + x;
      state.hoverCell = state.keyboardCell;
      requestRender();
    }
  }

  /* Dialogs and controls ---------------------------------------------------- */
  function openNewDialog() {
    newColor = state.humanColor;
    newDifficulty = state.difficulty;
    var colors = els.colorChoice.querySelectorAll('[data-color]');
    for (var i = 0; i < colors.length; i++) {
      var colorActive = Number(colors[i].getAttribute('data-color')) === newColor;
      colors[i].classList.toggle('selected', colorActive);
      colors[i].setAttribute('aria-pressed', colorActive ? 'true' : 'false');
    }
    var diffs = els.newDifficulty.querySelectorAll('[data-difficulty]');
    for (i = 0; i < diffs.length; i++) {
      var diffActive = diffs[i].getAttribute('data-difficulty') === newDifficulty;
      diffs[i].classList.toggle('selected', diffActive);
      diffs[i].setAttribute('aria-pressed', diffActive ? 'true' : 'false');
    }
    els.newDialog.showModal();
    els.btnStart.focus();
  }

  function openSettings() {
    els.setSound.checked = state.settings.sound;
    els.setAnimation.checked = state.settings.animation;
    els.setCoordinates.checked = state.settings.coordinates;
    els.setNumbers.checked = state.settings.numbers;
    els.settingsDialog.showModal();
    var done = els.settingsDialog.querySelector('button[type="submit"]');
    if (done) done.focus();
  }

  function closeDialog(dialog) {
    if (dialog && dialog.open) dialog.close();
  }

  function activateDifficulty(value) {
    if (!DIFFICULTIES[value]) return;
    if (state.status === 'thinking') {
      cancelAI(true);
    }
    state.difficulty = value;
    state.engineOffline = false;
    state.engineRecovery = null;
    saveSettings();
    saveGame();
    updateUI();
    showToast('难度已切换为「' + DIFFICULTIES[value].label + '」');
    if (state.status === 'playing' && state.turn === state.aiColor) {
      scheduleAIMove(120);
    }
  }

  function bindEvents() {
    els.btnNew.addEventListener('click', openNewDialog);
    els.btnSettings.addEventListener('click', openSettings);
    els.btnAgain.addEventListener('click', function () {
      startNewGame(state.humanColor, state.difficulty);
    });
    els.btnUndo.addEventListener('click', undo);
    els.btnHint.addEventListener('click', requestHint);
    els.btnResign.addEventListener('click', resign);

    els.brandHome.addEventListener('click', function (event) {
      event.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    els.colorChoice.addEventListener('click', function (event) {
      var btn = event.target.closest('[data-color]');
      if (!btn) return;
      newColor = Number(btn.getAttribute('data-color'));
      var colors = els.colorChoice.querySelectorAll('[data-color]');
      for (var i = 0; i < colors.length; i++) {
        var active = Number(colors[i].getAttribute('data-color')) === newColor;
        colors[i].classList.toggle('selected', active);
        colors[i].setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    });

    els.newDifficulty.addEventListener('click', function (event) {
      var btn = event.target.closest('[data-difficulty]');
      if (!btn) return;
      newDifficulty = btn.getAttribute('data-difficulty');
      var diffs = els.newDifficulty.querySelectorAll('[data-difficulty]');
      for (var i = 0; i < diffs.length; i++) {
        var active = diffs[i].getAttribute('data-difficulty') === newDifficulty;
        diffs[i].classList.toggle('selected', active);
        diffs[i].setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    });

    els.newForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (newDifficulty === 'nightmare' && !nightmareSupported()) {
        els.newDialog.close();
        showEngineHelp('浏览器不支持噩梦模式',
          '当前浏览器不支持 WebAssembly Worker。请使用新版 Chrome、Edge、Firefox 或 Safari，或选择其他难度。');
        return;
      }
      startNewGame(newColor, newDifficulty);
      els.newDialog.close();
    });

    els.difficultyGroup.addEventListener('click', function (event) {
      var btn = event.target.closest('[data-difficulty]');
      if (!btn) return;
      var value = btn.getAttribute('data-difficulty');
      if (!DIFFICULTIES[value] || value === state.difficulty) return;
      if (value === 'nightmare' && !nightmareSupported()) {
        showEngineHelp('浏览器不支持噩梦模式',
          '当前浏览器不支持 WebAssembly Worker。请使用新版 Chrome、Edge、Firefox 或 Safari，或选择其他难度。');
        return;
      }
      activateDifficulty(value);
    });

    var closeButtons = document.querySelectorAll('[data-close]');
    for (var c = 0; c < closeButtons.length; c++) {
      closeButtons[c].addEventListener('click', function (event) {
        var dialog = event.target.closest('dialog');
        closeDialog(dialog);
      });
    }

    [els.newDialog, els.settingsDialog, els.engineDialog].forEach(function (dialog) {
      dialog.addEventListener('click', function (event) {
        if (event.target === dialog) dialog.close();
      });
    });

    els.engineDialog.addEventListener('close', function () {
      state.engineRecovery = null;
    });

    els.btnEngineRetry.addEventListener('click', function () {
      var recovery = state.engineRecovery;
      els.engineDialog.close();
      if (!recovery || recovery.gameId !== state.gameId) return;
      if (state.status === 'playing' && state.turn === state.aiColor) {
        state.engineOffline = false;
        updateUI();
        scheduleAIMove(100);
      }
    });

    els.btnEngineFallback.addEventListener('click', function () {
      var recovery = state.engineRecovery;
      els.engineDialog.close();
      if (!recovery || recovery.gameId !== state.gameId) return;
      if (state.status === 'playing' && state.turn === state.aiColor) {
        state.difficulty = 'master';
        state.engineOffline = false;
        saveSettings();
        saveGame();
        updateUI();
        showToast('已改用大师 AI 完成本局');
        scheduleAIMove(100);
      }
    });

    els.setSound.addEventListener('change', function () {
      state.settings.sound = els.setSound.checked;
      saveSettings();
      if (state.settings.sound) playStoneSound(BLACK);
    });
    els.setAnimation.addEventListener('change', function () {
      state.settings.animation = els.setAnimation.checked;
      if (!state.settings.animation) state.anim.clear();
      saveSettings();
      render();
    });
    els.setCoordinates.addEventListener('change', function () {
      state.settings.coordinates = els.setCoordinates.checked;
      saveSettings();
      buildBackground(view.w);
      render();
    });
    els.setNumbers.addEventListener('change', function () {
      state.settings.numbers = els.setNumbers.checked;
      saveSettings();
      render();
    });

    els.btnResetSave.addEventListener('click', function () {
      storageRemove(SAVE_KEY);
      showToast('本地对局已清除');
    });

    els.board.addEventListener('pointermove', handlePointerMove);
    els.board.addEventListener('pointerleave', function () { updateHover(-1); });
    els.board.addEventListener('pointerdown', handlePointerDown);
    els.board.addEventListener('pointerup', handlePointerUp);
    els.board.addEventListener('pointercancel', function () { touchStart = null; });
    els.board.addEventListener('keydown', handleCanvasKeyDown);
    els.board.addEventListener('focus', function () { requestRender(); });
    els.board.addEventListener('blur', function () { requestRender(); });

    document.addEventListener('keydown', function (event) {
      if (event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA')) return;
      if (document.querySelector('dialog[open]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undo();
      }
    });

    window.addEventListener('resize', resizeBoard);
    window.addEventListener('beforeunload', function () {
      if (state.nightmareWorker) {
        try { state.nightmareWorker.terminate(); } catch (err) { /* ignore */ }
      }
      saveGame();
    });
    if (window.ResizeObserver) {
      var observer = new ResizeObserver(function () {
        resizeBoard();
      });
      observer.observe(els.boardWrap);
    }
  }

  /* A small read-only hook used by the local UI smoke tests. */
  window.__gomokuDebug = {
    state: state,
    view: view,
    coord: coord,
    cellPoint: function (cell) {
      return {
        x: view.pad + (cell % SIZE) * view.cell,
        y: view.pad + (((cell / SIZE) | 0)) * view.cell
      };
    },
    startNewGame: startNewGame,
    undo: undo,
    requestHint: requestHint,
    updateUI: updateUI,
    render: render,
    nightmareSupported: nightmareSupported,
    nightmareEngine: 'Rapfi'
  };

  /* Boot -------------------------------------------------------------------- */
  function boot() {
    loadSettings();
    els.setSound.checked = state.settings.sound;
    els.setAnimation.checked = state.settings.animation;
    els.setCoordinates.checked = state.settings.coordinates;
    els.setNumbers.checked = state.settings.numbers;

    bindEvents();
    resizeBoard();
    updateUI();

    var restored = loadGame();
    if (!restored) {
      startNewGame(state.humanColor, state.difficulty);
    } else {
      updateUI();
      render();
      if (state.status === 'playing' && state.turn === state.aiColor) {
        scheduleAIMove(420);
      }
    }

    // Warm the worker in the background so the first AI move feels immediate.
    setTimeout(function () {
      ensureWorker().catch(function () { /* compatibility mode takes over */ });
    }, 1200);
  }

  boot();
})();
