/**
 * For code that wants to talk to a pernosco endpoint.
 *
 * The lazy API here is:
 * - The first request attempts to connect to the most recent pernosco session
 *   if not already connected to one.
 *   - In the future there would be an API to enumerate the known/live sessions
 *     so a combo-box can be used or whatever.
 * - Requests resolve when the entirety of the data is received.
 * - Nothing tracks focus right now.
 *
 * See `server.js` for docs on the rendezvous.
 **/

import { generateId } from './idgen.js'
import { BroadcastChannelMessageHandler } from './msg_handler.js';

export class BridgeClient extends BroadcastChannelMessageHandler {
  constructor() {
    super('client');

    this.lookForServers();
  }

  lookForServers() {
    this.broadcastMessage('rollcall', {});
  }

  onMsg_helloThisIsServer(_payload, _replyFunc, rawMsg) {
    // Automatically just use whatever pernosco session we most recently heard
    // from.
    this.setTargetBridgeId(rawMsg.senderBridgeId);
    console.log('Messages now target', rawMsg.senderBridgeId);
  }
}
