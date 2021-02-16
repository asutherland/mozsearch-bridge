/**
 * This is the bit of JS that gets injected via a bookmarklet and creates an
 * iframe communication bridge.  The iframe is currently just a way to bounce
 * messages across to a BroadcastChannel in the iframe's origin.
 */

import { BridgeServer } from './bridge/server.js';

// XXX figure out our port from scraping our bookmarklet script tag.
const PORT = 3333;
const ORIGIN = `http://localhost:${PORT}`


/**
 * Build an "executions of" query centered around the UI's current position in
 * the trace.  The query will be limited to `limit` results in events occurring
 * before and after the current position.
 */
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

/**
 * Build a query defaulting to being evaluated at the current position in the
 * trace.
 */
function buildSimpleQuery(mixArgs) {
  const queryFocus = Object.assign({}, window.client.focus);
  return Object.assign({
    focus: queryFocus,
  }, mixArgs);
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
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });

    this.results = [];
  }

  onData(id, data) {
    this.results.push(data);
  }

  onClose(id, hasNoMore, noResults) {
    this._resolve(this.results);
  }

  /**
   * Invoked when a disconnection occurs.  This allows queries to be reissued
   * when a reconnection occurs.  If we wanted that, we could have the handler
   * latch the query creation values and have it reset its results herein and
   * reissue the query with this self-same handler.
   *
   * However, everything is a big hack right now, and I'd rather avoid
   * generating accidental load against the pernosco servers, so let's just
   * reject in the case a disconnection occurs.
   */
  onDisconnected(id) {
    this._reject('disconnected');
  }
}

/**
 * Singleton view registered into the Client's list of views so that the bridge
 * can receive "status report" updates that reflect the current focus and source
 * line.
 *
 * Note that this does not subclass the `View` prototype and this is likely to
 * lead to breakage in the future versus subclassing where changes would
 * silently fail.  The current rationale is that it's better to realize
 * something changed and update the code rather than experience more subtle
 * breakage.
 */
class BridgeHelperView {
  constructor({ pclient, bridge }) {
    this.queryName = 'pernosco-bridge-helper';

    this.pclient = pclient;
    this.bridge = bridge;

    this._register();
  }

  _register() {
    // Unregister any previously existing view.
    const oldView = this.pclient.getViewByName(this.queryName);
    // There's a removeView but it assumes layout is involved.
    this.pclient.views.delete(oldView);
    // But this currently doesn't involve layout.
    this.pclient.addView(this);
  }

  /**
   * updates is an array of objects of one of the two following forms:
   * - { create: { key: String, created: timeMillis, creator: { name }, value }}
   * - { deleted: { key: String }}
   *
   * Keys may be of the following forms:
   * - "notebook/" prefix, followed by a very long random integer number
   *   created via Math.round(Math.random() * 10^15).
   *   - Value contains:
   *     - focus: Standard { data, frame, moment: {event, instr}, node, tuid }
   *       rep where the moment is the primary key for ordering purposes and the
   *       "ordering" below is 2nd.  Note that the "moment" is itself composite.
   *     - ordering: Floating point number that seems to be relative positioning
   *       inside a given stack.  (It's possible to have separate comments on
   *       different frames in the same stack at the same focus moment.)  The
   *       displacements here are partially random, which seems to be a means of
   *       avoiding collisions from multiple sessions.
   *     - pml (optional): This will be a rendering of the description of the
   *       stack frame or what have you.  For executions, the "a" should have an
   *       "itemShorthand".
   *     - text (optional): When present, this is the human authored description
   *       which will be in its own key/value distinct from the stack/context.
   */
  updateStorage(updates) {
    // TODO: Support live-updating notebook use-cases.  For now the presumption
    // is we'll just do it on demand.
  }

  /**
   * Focus-setting is async and this is part of the process to ensure there's
   * only one active effort to set the focus.  This notifies the current king of
   * the hill.
   */
  onOtherViewWillSetFocus(focusSettingView) {
    // NOP
  }

  /**
   * Notification that the focus has now changed, with the new/current focus
   * being available on `window.client.focus` and `window.client.source`, with
   * the old values in `oldFocus` and `oldSource`.
   *
   * Options may include "annotation" which will be propagated to
   * `client.lastAnnotation`, which in combination with `updateFocusAnnotation`
   * seems to be part of a side-channel to allow information to be provided to
   * the notebook for the tentative annotations it generates based on the
   * current location despite views in the pernosco UI inherently being async.
   * (That is, thanks to the history mechanism it's very possible for a query
   * container view to not yet have the PML that describes the current moment;
   * but when that information arrives the notebook wants to have it.)
   *
   * Note that `client.lastAnnotation` will not have the value of
   * `options.annotation` until after this call is received.
   */
  onFocusChange(oldFocus, oldSource, settingView, options) {
    this.bridge.sendStatusReport(options);
  }

  /**
   * A mechanism for the view that set the current focus to asynchronously
   * provide an update on the annotation for the current moment.  The annotation
   * may not have been available at the moment the focus changed, but now it is
   * (thanks to ContainerView.onData finally getting the data).
   *
   * Note that `client.lastAnnotation` will not have the value of `annotation`
   * until after this call is received.
   */
  updateFocusAnnotation(annotation) {
    this.bridge.sendStatusReport({ annotation });
  }

  /**
   * Called by `doUserHighlightChange` where a highlight is defined as
   * { moment, color } and is null under addition/deletion.  These are exposed
   * in pernosco's UX by clicking on the color box that appears in the notebook
   * on the right side on hover and is labled as "Display this event in other
   * views".
   */
  onUserHighlightChange(before, after) {
    // NOP
  }

  /**
   * Notification that the websocket connection was lost.  This is distinct from
   * `onDisconnected` which is invoked on existing queries that tells them their
   * query is being cleared without resolution and they'll need to reissue the
   * query (which they can do synchronously and where it will be queued for
   * delivery upon reconnect).  Nothing seems to use this right now and there's
   * no corresponding notification of connection re-establishment.
   */
  onDisconnect() {
    // NOP
  }
}

class POCServer extends BridgeServer {
  constructor(iframe) {
    super({
      roleType: 'server',
      win: window,
      iframe,
      pclient: window.client,
    });

    this.bridgeHelperView = new BridgeHelperView({
      pclient: this.pclient,
      bridge: this,
    });
  }

  generateStatusReportPayload(options) {
    const pclient = this.pclient;
    let annotation = options ? options.annotation : pclient.lastAnnotation;
    return {
      focus: pclient.focus,
      source: pclient.source,
      annotation,
    };
  }

  /**
   * Simple wrapper around Client.openQuery to make sure we pass `{ api: 1 }` in
   * the options dictionary so that it's possible to distinguish calls via this
   * hack from queries generated by the pernosco UI itself.
   */
  _openQuery(name, req, handler) {
    return this.pclient.openQuery(name, req, handler, { api: 1 });
  }

  /**
   * Generate and send a status report for the UI.  If `options` is provided,
   * it's assumed to be the options from `View.onFocusChange` that includes an
   * `annotation` argument which will then supersede the
   * `Client.lastAnnotation`.
   */
  sendStatusReport(options) {
    this.broadcastMessage('statusReport', this.generateStatusReportPayload(options));
  }

  /**
   * A means of requiring that current status be generated on-demand, but in
   * general
   */
  onMsg_statusReport({}, reply) {
    reply(this.generateStatusReportPayload());
  }

  /**
   *
   */
  onMsg_storageDump({}, reply) {
    reply(this.pclient.storageData);
  }

  async onMsg_simpleQuery({ name, mixArgs }, reply) {
    console.log('poc: processing simple query for', name);
    let queryId;
    try {
      const req = buildSimpleQuery(mixArgs);
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
      beforeQueryId = this._openQuery('execution', beforeReq, beforeHandler);

      const afterHandler = new BatchHandler();
      afterQueryId = this._openQuery('execution', afterReq, afterHandler);

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
