/**
 * For code that wants to talk to a pernosco endpoint.
 **/

import { RuntimeConnectIssuingHandler } from './msg_handler.js';

export class BridgeClient extends RuntimeConnectIssuingHandler {
  constructor({ onStatusReport }) {
    // This is fairly hacky, but to start, we just tunnel the session id through
    // the hash, but we probably should be trying to use a tab weakmap or
    // equivalent.  That would help with the reloads.
    super('client', document.location.hash.slice(1));
    document.location.hash = "";

    this.statusReport = null;

    this.onStatusReport = onStatusReport;
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
