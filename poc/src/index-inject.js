/**
 * This is the bit of JS that gets injected via a bookmarklet and creates an
 * iframe communication bridge.  The iframe is currently just a way to bounce
 * messages across to a BroadcastChannel in the iframe's origin.  I had hoped to
 *
 */

import { BridgeServer } from './bridge/server.js';

// XXX figure out our port from scraping our bookmarklet script tag.
const PORT = 3333;
const ORIGIN = `http://localhost:${PORT}`

function buildExecutionQuery({ symbol, print }, limit=50) {
  const queryFocus = Object.assign({}, window.client.focus);
  const focusMoment = queryFocus.moment;
  return [
    {
      focus: queryFocus,
      params: {
        symbol,
        print
      },
      limits: {
        startMoment: {
          event: 0,
          instr: 0,
        },
        startOffset: 0,
        endMoment: focusMoment,
        endOffset: 1125899906842624,
        direction: 'backward',
        lines: limit
      },
    },
    {
      focus: queryFocus,
      params: {
        symbol,
        print
      },
      limits: {
        startMoment: focusMoment,
        startOffset: 1125899906842624,
        endMoment: {
          event: 1125899906842624,
          instr: 1125899906842624,
        },
        endOffset: 1125899906842624,
        direction: 'forward',
        lines: limit
      },
    },
  ];
}

function buildSimpleQuery(params) {
  const queryFocus = Object.assign({}, window.client.focus);
  return {
    focus: queryFocus,
    params
  };
}

/**
 * Handler that just waits for all the results to come in, then resolves its
 * promise.
 *
 * Things done/not done:
 * - activeQueryCount - Not present, avoiding element manipulation.
 */
class BatchHandler {
  constructor() {
    this.promise = new Promise((resolve) => {
      this._resolve = resolve;
    });

    this.results = [];
  }

  onData(id, data) {
    this.results.push(data);
  }

  onClose(id, hasNoMore, noResults) {
    this._resolve(this.results);
  }
}

class POCServer extends BridgeServer {
  constructor(iframe) {
    super({ roleType: 'server', win: window, iframe });

    this.pclient = window.client;
  }

  async onMsg_simpleQuery({ name, params }, reply) {
    console.log('poc: processing simple query for', name);
    let queryId;
    try {
      const req = buildSimpleQuery(params);
      const handler = new BatchHandler();
      queryId = this.pclient.openQuery(name, req, handler);
      const results = await handler.promise;
      queryId = null;

      reply(results)
    } finally {
      if (queryId) {
        this.pclient.cancelQuery(queryId);
      }
    }
  }

  async onMsg_executionQuery({ symbol, print }, reply) {
    console.log('poc: processing execution query for', symbol);
    let beforeQueryId, afterQueryId;
    try {
      const [beforeReq, afterReq] = buildExecutionQuery({ symbol, print });
      const beforeHandler = new BatchHandler();
      beforeQueryId =
        this.pclient.openQuery('execution', beforeReq, beforeHandler);

      const afterHandler = new BatchHandler();
      afterQueryId =
        this.pclient.openQuery('execution', afterReq, afterHandler);

      const beforeResults = await beforeHandler.promise;
      beforeQueryId = null;
      const afterResults = await afterHandler.promise;
      afterQueryId = null;

      const results = [...beforeResults, ...afterResults];

      reply(results);
    } finally {
      // Ensure we always terminate the query on the way out if initialized and
      // we're not sure it closed.
      if (beforeQueryId) {
        this.pclient.cancelQuery(beforeQueryId);
      }
      if (afterQueryId) {
        this.pclient.cancelQuery(afterQueryId);
      }
    }
  }
}


// Sorta idempotently create the iframe.
let bridgeFrame = document.getElementById('pt-poc-bridge-frame');
if (!bridgeFrame) {
  bridgeFrame = document.createElement('iframe');
  bridgeFrame.setAttribute('id', 'pt-poc-bridge-frame');
  bridgeFrame.setAttribute('style', 'display: none;');
  bridgeFrame.setAttribute('src', `${ORIGIN}/bridge.html`);
  document.body.appendChild(bridgeFrame);
} else {
  bridgeFrame.bridge.cleanup();
  window.removeEventListener('message', bridgeFrame.msgHandler);
}

bridgeFrame.bridge = new POCServer(bridgeFrame);
