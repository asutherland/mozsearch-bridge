/**
 * The communication and rendezvous logic that lives in the content script.
 *
 * When this was all bookmarklet-based, this used a BroadcastChannel for
 * expediency, now we just use `browser.runtime.sendMessage()` with effectively
 * identical semantics for expediency.  (Although `browser.runtime.connect()`
 * looks more like what we want, it's still just establishing a non-broadcast
 * connection to the background script, not a way to directly talk between
 * content scripts and extension page scripts.  And it does not appear to
 * surface transfer semantics so we can't actually route a real MessagePort.
 * That said, it would be more efficient if we had the background script play
 * router if someone opens up multiple pernosco sessions / UI sessions.)
 *
 * Specifically:
 * - Clients and servers all generate random-ish id's for themselves.
 * - Servers announce themselves when they show up and when a client broadcasts
 *   a "rollcall" message.
 * - Clients and servers both indicate the target id of their messages and
 *   ignore non-broadcast messages.
 * - Clients can pick which server to use, but initially just choose the most
 *   recent server they've heard about.
 */

import { RuntimeConnectListeningHandler } from './msg_handler.js';

export class BridgeServer extends RuntimeConnectListeningHandler {
  constructor(args) {
    super(args);

    if (args.pclient) {
      this.pclient = args.pclient;
    }
  }

  generateStatusReportPayload() {
    return {};
  }

  onConnect() {
    console.log("got connect notification, sending message");
    this.sendMessage(
      'helloThisIsServer',
      {
        // We provide the current status as part of the broadcast so that the
        // client can always have current status information that is updated as
        // things change in the pernosco session.
        status: this.generateStatusReportPayload(),
      });
  }
}
