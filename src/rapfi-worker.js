/*
 * Rapfi WebAssembly worker.
 *
 * build.js prepends the Emscripten glue (converted from an ES module to a
 * classic worker) and replaces the two base64 placeholders with the engine
 * binary and its preloaded config/classical-model package. Keeping both files
 * inside the worker means the final index.html stays self-contained and can be
 * opened directly from disk.
 */
'use strict';

/*__RAPFI_GLUE__*/

var RAPFI_WASM_BASE64 = '__RAPFI_WASM_B64__';
var RAPFI_DATA_BASE64 = '__RAPFI_DATA_B64__';

var SIZE = 15;
var N = SIZE * SIZE;
var EMPTY = 0;
var BLACK = 1;
var WHITE = 2;

/* A smaller hash table than the 64 MB default keeps mobile browsers happy. */
var CONFIG_TOML = [
  '[general]',
  'reload_config_each_move = false',
  'clear_hash_after_config_loaded = false',
  'default_thread_num = 1',
  'message_mode = "normal"',
  'coord_conversion_mode = "none"',
  'default_candidate_range = "square3_line4"',
  'memory_reserved_mb = 0',
  'default_tt_size_kb = 32768',
  '',
  '[model]',
  'binary_file = "model210901.bin"',
  '',
  '[search]',
  'aspiration_window = true',
  'num_iteration_after_mate = 24',
  'num_iteration_after_singular_root = 24',
  'max_search_depth = 99'
].join('\n') + '\n';

var enginePromise = null;
var active = null;
var lastProgressAt = 0;

function decodeBase64(text) {
  var binary = atob(text);
  var length = binary.length;
  var bytes = new Uint8Array(length);
  for (var i = 0; i < length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function post(message) {
  self.postMessage(message);
}

function toCoord(cell) {
  return (cell % SIZE) + ',' + ((cell / SIZE) | 0);
}

function boardToLines(board, aiColor) {
  if (!board || board.length !== N) {
    throw new Error('棋盘数据不完整。');
  }
  if (aiColor !== BLACK && aiColor !== WHITE) {
    throw new Error('电脑棋色无效。');
  }

  var black = [];
  var white = [];
  for (var i = 0; i < N; i++) {
    var value = Number(board[i]);
    if (value === BLACK) black.push(i);
    else if (value === WHITE) white.push(i);
    else if (value !== EMPTY) throw new Error('棋盘包含未知棋子。');
  }
  if (white.length > black.length || black.length - white.length > 1) {
    throw new Error('棋盘手数顺序不一致。');
  }

  var selfField = aiColor === BLACK ? 1 : 2;
  var opponentField = 3 - selfField;
  var lines = [];
  for (var j = 0; j < black.length; j++) {
    lines.push(toCoord(black[j]) + ',' + (aiColor === BLACK ? selfField : opponentField));
    if (j < white.length) {
      lines.push(toCoord(white[j]) + ',' + (aiColor === WHITE ? selfField : opponentField));
    }
  }
  return lines;
}

function suffixMultiplier(suffix) {
  if (!suffix) return 1;
  switch (suffix.toUpperCase()) {
    case 'K': return 1000;
    case 'M': return 1000000;
    case 'G': return 1000000000;
    default: return 1;
  }
}

function parseMessage(message) {
  if (!active || !message) return;

  var depth = /Depth\s+(\d+)(?:\s*-\s*(\d+))?/i.exec(message);
  if (depth) {
    active.depth = Number(depth[2] || depth[1]) || 0;
  }

  var nodes = /Node\s+([\d.]+)\s*([KMG]?)/i.exec(message);
  if (nodes) {
    active.nodes = Math.round(parseFloat(nodes[1]) * suffixMultiplier(nodes[2]));
  }

  var time = /Time\s+(\d+)\s*ms/i.exec(message);
  if (time) {
    active.time = Number(time[1]) || 0;
  }

  var score = /Eval\s+(-?\d+)/i.exec(message);
  if (score) {
    active.score = Number(score[1]);
  }

  if (depth || nodes) {
    emitProgress(false);
  }
}

function emitProgress(force) {
  if (!active) return;
  var timestamp = Date.now();
  if (!force && timestamp - lastProgressAt < 140) return;
  lastProgressAt = timestamp;
  post({
    type: 'progress',
    id: active.id,
    engine: 'Rapfi',
    depth: active.depth || 0,
    nodes: active.nodes || 0,
    time: active.time || 0,
    score: active.score
  });
}

function handleStdout(line) {
  if (!active) return;
  var text = String(line == null ? '' : line).trim();
  if (!text) return;

  if (active.lines.length < 40) active.lines.push(text);

  if (/^\d+\s*,\s*\d+$/.test(text)) {
    var parts = text.split(',');
    var x = Number(parts[0]);
    var y = Number(parts[1]);
    if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) {
      active.move = y * SIZE + x;
      active.rawMove = text;
    }
    return;
  }

  if (text.indexOf('ERROR') === 0) {
    active.error = text.replace(/^ERROR\s*:?\s*/, '');
    return;
  }

  if (text.indexOf('MESSAGE') === 0) {
    parseMessage(text.slice(7).trim());
  }
}

function createEngine() {
  if (enginePromise) return enginePromise;

  enginePromise = new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      fail(new Error('Rapfi 引擎加载超时。'));
    }, 30000);

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      enginePromise = null;
      reject(error);
    }

    var wasmBytes;
    var dataBytes;
    try {
      wasmBytes = decodeBase64(RAPFI_WASM_BASE64);
      dataBytes = decodeBase64(RAPFI_DATA_BASE64);
    } catch (error) {
      fail(new Error('无法解码 Rapfi 引擎文件。'));
      return;
    }

    Rapfi({
      locateFile: function (file) { return file; },
      getPreloadedPackage: function () { return dataBytes.buffer; },
      instantiateWasm: function (imports, success) {
        try {
          WebAssembly.instantiate(wasmBytes, imports).then(function (result) {
            success(result.instance);
          }, function (error) {
            fail(error);
          });
        } catch (error) {
          fail(error);
        }
        return {};
      },
      onReceiveStdout: handleStdout,
      onReceiveStderr: function (line) {
        if (active && line && active.stderr.length < 20) {
          active.stderr.push(String(line));
        }
      },
      print: function () { /* engine output goes through onReceiveStdout */ },
      printErr: function (line) {
        if (line) console.warn('[Rapfi]', line);
      },
      onExit: function (code) {
        if (active) active.exitCode = code;
      }
    }).then(function (module) {
      if (settled) return;
      try {
        module.FS.writeFile('/config.toml', CONFIG_TOML);
        module.sendCommand('RELOADCONFIG /config.toml');
      } catch (error) {
        /* The preloaded default config is a safe fallback. */
      }
      settled = true;
      clearTimeout(timer);
      resolve(module);
    }).catch(fail);
  });

  return enginePromise;
}

function finishError(message) {
  var id = active ? active.id : 0;
  active = null;
  post({ type: 'error', id: id, message: message || 'Rapfi 计算失败。' });
}

function search(data) {
  if (active) {
    post({ type: 'error', id: data.id, message: 'Rapfi 正忙，请稍后重试。' });
    return;
  }

  active = {
    id: data.id,
    depth: 0,
    nodes: 0,
    time: 0,
    score: null,
    move: -1,
    error: '',
    lines: [],
    stderr: [],
    exitCode: null,
    rawMove: ''
  };

  createEngine().then(function (module) {
    if (!active || active.id !== data.id) return;

    var lines;
    try {
      lines = boardToLines(data.board, data.player);
    } catch (error) {
      finishError(error.message);
      return;
    }

    var timeLimit = Number(data.timeLimit) || 7000;
    timeLimit = Math.max(200, Math.min(15000, timeLimit));

    post({
      type: 'progress',
      id: active.id,
      engine: 'Rapfi',
      depth: 0,
      nodes: 0,
      time: 0,
      message: '正在分析局面'
    });

    var command = 'BOARD';
    if (lines.length) command += '\n' + lines.join('\n');
    command += '\nDONE';

    try {
      module.sendCommand('START 15');
      module.sendCommand('INFO timeout_turn ' + timeLimit);
      module.sendCommand('INFO timeout_match 0');
      module.sendCommand('INFO max_memory 0');
      module.sendCommand('INFO rule 0');
      module.sendCommand(command);
    } catch (error) {
      finishError('Rapfi 计算中断：' + (error && error.message ? error.message : error));
      return;
    }

    if (!active) return;
    if (active.error) {
      finishError(active.error);
      return;
    }
    if (!Number.isInteger(active.move) || active.move < 0 || active.move >= N) {
      finishError('Rapfi 没有返回有效落点。');
      return;
    }

    var id = active.id;
    var result = {
      move: active.move,
      depth: active.depth || 0,
      nodes: active.nodes || 0,
      time: active.time || 0,
      score: active.score,
      engine: 'Rapfi'
    };
    active = null;
    post({ type: 'result', id: id, result: result });
  }).catch(function (error) {
    finishError('Rapfi 引擎加载失败：' + (error && error.message ? error.message : error));
  });
}

self.onmessage = function (event) {
  var data = event.data || {};
  if (data.type === 'search') search(data);
};

post({ type: 'ready' });
