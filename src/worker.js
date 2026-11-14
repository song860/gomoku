/* Web Worker glue. The engine source is prepended by the build step. */
'use strict';

var engine = new GomokuAI();

self.onmessage = function (event) {
  var data = event.data || {};
  if (data.type !== 'search') return;

  try {
    var result = engine.search(data.board, data.player, {
      timeLimit: data.options && data.options.timeLimit,
      maxDepth: data.options && data.options.maxDepth,
      randomness: data.options && data.options.randomness,
      onProgress: function (progress) {
        self.postMessage({
          type: 'progress',
          id: data.id,
          depth: progress.depth,
          score: progress.score,
          nodes: progress.nodes,
          time: progress.time
        });
      }
    });
    self.postMessage({ type: 'result', id: data.id, result: result });
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: data.id,
      message: err && err.stack ? err.stack : String(err)
    });
  }
};

self.postMessage({ type: 'ready' });
