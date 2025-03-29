/**
 * For code that wants to talk to a pernosco endpoint.
 **/

import { IDBCacheHelper } from '../analyzer/idb_cache_helper.js';
import { RuntimeConnectIssuingHandler } from './msg_handler.js';

export class BridgeClient extends RuntimeConnectIssuingHandler {
  constructor({ onStatusReport, normalizeReceivedPayload }) {
    // We tunnel the session id through the searchParams (previously via the
    // hash), but we probably should be trying to use a tab weakmap or
    // equivalent.  That would help with the reloads.
    const urlParams = new URLSearchParams(window.location.search);

    const traceName = urlParams.get("trace");
    const cacheHelper = new IDBCacheHelper({ traceName });

    super('client', urlParams.get("sess"), { cacheHelper });
    document.location.hash = "";

    this.statusReport = null;

    this.onStatusReport = onStatusReport;
    if (normalizeReceivedPayload) {
      this._normalizeReceivedPayload = normalizeReceivedPayload;
    }
  }

  setFocus(focus) {
    this.sendMessage('focus', { focus });
  }

  onMsg_helloThisIsServer(statusReport) {
    this.onMsg_statusReport(statusReport.status);
  }

  onMsg_statusReport(statusReport) {
    this.statusReport = statusReport;
    if (this.onStatusReport) {
      this.onStatusReport(statusReport);
    }
  }
}
