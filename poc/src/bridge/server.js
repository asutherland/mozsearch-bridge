/**
 * The communication and rendezvous logic that lives in the iframe that gets
 * injected into the pernosco tab.
 *
 * Right now a single BroadcastChannel is used for everything with every client
 * and server pretending it's a routed substrate.  Specifically:
 * - Clients and servers all generate random-ish id's for themselves.
 * - Servers announce themselves when they show up and when a client broadcasts
 *   a "rollcall" message.
 * - Clients and servers both indicate the target id of their messages and
 *   ignore non-broadcast messages.
 * - Clients can pick which server to use, but initially just choose the most
 *   recent server they've heard about.
 */

import { OutsideIframeMessageHandler } from './msg_handler.js';

export class BridgeServer extends OutsideIframeMessageHandler {
  constructor(args) {
    super(args);

    if (args.pclient) {
      this.pclient = args.pclient;
    }

    this.announce();
  }

  generateStatusReportPayload() {
    return {};
  }

  announce() {
    // This is a reference to the "hello, this is dog" meme.
    this.broadcastMessage(
      'helloThisIsServer',
      {
        // We provide the current status as part of the broadcast so that the
        // client can always have current status information that is updated as
        // things change in the pernosco session.
        status: this.generateStatusReportPayload(),
      });
  }

  onMsg_rollcall(msg) {
    this.announce();
  }
}
