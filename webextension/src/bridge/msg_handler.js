import { generateId } from './idgen.js'

const BROADCAST_CHANNEL_NAME = 'poc-bridge';

/**
 * Common message-related logic for the BroadcastChannel faking of a more
 * MessageChannel style idiom.
 */
export class MessageHandler {
  constructor(roleType) {
    this.bridgeId = generateId(roleType);

    this._awaitingReplyPromises = new Map();

    this.targetBridgeId = null;
    this.targetQueue = [];
  }

  broadcastMessage(type, payload) {
    const msgId = generateId('msg', this.bridgeId);

    this._postMessage({
      type,
      msgId,
      senderBridgeId: this.bridgeId,
      targetBridgeId: 'broadcast',
      payload
    });
  }

  setTargetBridgeId(targetBridgeId) {
    this.targetBridgeId = targetBridgeId;

    let queue = this.targetQueue;
    this.targetQueue = null;

    // queue may be null if this is not the first server we've heard of.  If
    // we were fancier, we might listen for a server to say it's going away
    // and then restore the queue.  And/or allow for unreliable delivery.
    if (queue) {
      for (let { type, payload, replyId } of queue) {
        if (replyId) {
          this._sendMessageAwaitingReply(type, payload, replyId);
        } else {
          this.sendMessage(type, payload);
        }
      }
    }
  }

  sendMessage(type, payload) {
    if (!this.targetBridgeId) {
      this.targetQueue.push({ type, payload, replyId: null });
      return;
    }

    const msgId = generateId('msg', this.bridgeId);

    this._postMessage({
      type,
      msgId,
      senderBridgeId: this.bridgeId,
      targetBridgeId: this.targetBridgeId,
      payload
    });
  }

  sendMessageAwaitingReply(type, payload) {
    const replyId = generateId('reply', this.bridgeId);

    let resolve, reject;
    let promise = new Promise((_resolve, _reject) => {
      resolve = _resolve;
      reject = _reject;
    });

    this._awaitingReplyPromises.set(replyId, { resolve, reject });

    this._sendMessageAwaitingReply(type, payload, replyId);

    return promise;
  }

  _sendMessageAwaitingReply(type, payload, replyId) {
    if (!this.targetBridgeId) {
      this.targetQueue.push({ type, payload, replyId });
      return;
    }

    const msgId = generateId('msg', this.bridgeId);

    this._postMessage({
      type,
      senderBridgeId: this.bridgeId,
      targetBridgeId: this.targetBridgeId,
      msgId,
      replyId,
      payload
    });
  }

  _onMessage(evt) {
    const msg = evt.data;

    if (msg.type === 'reply') {
      if (!this._awaitingReplyPromises.has(msg.msgId)) {
        return;
      }
      const { resolve } = this._awaitingReplyPromises.get(msg.msgId);
      resolve(msg.payload);
      this._awaitingReplyPromises.delete(msg.msgId);
      return;
    }

    const lookupName = `onMsg_${msg.type}`;

    let replyFunc;
    if ('replyId' in msg) {
      const replyId = msg.replyId;
      replyFunc = (payload) => {
        this._postMessage({
          type: 'reply',
          targetBridgeId: msg.senderBridgeId,
          senderBridgeId: this.bridgeId,
          msgId: replyId,
          payload,
        });
      };
    }

    if (lookupName in this) {
      let result;
      try {
        result = this[lookupName](msg.payload, replyFunc, msg);
      } catch (ex) {
        console.error('Error processing message', msg, ex);
      }

      // We don't care about the error right now, but if the thing was an
      // async function, we do want to add a catch handler to report an async
      // failure.
      if (result && result.then) {
        result.catch((ex) => {
          console.error('Async error processing message', msg, ex);
        });
      }
    }
  }
}

/**
 * MessageHandler that directly uses BroadcastChannel for comms.
 */
export class BroadcastChannelMessageHandler extends MessageHandler {
  constructor(roleType) {
    super(roleType);

    this.bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    this.bc.onmessage = this._onMessage.bind(this);
  }

  _postMessage(msg) {
    this.bc.postMessage(msg);
  }
}

/**
 * MessageHandler that relays to a BroadcastChannel indirectly via iframe.  The
 * presumed counterpart to this is the InsideIframeBroadcastChannelBridge.
 */
export class OutsideIframeMessageHandler extends MessageHandler {
  constructor({ roleType, win, iframe }) {
    super(roleType);

    this.win = win;
    this.iframe = iframe;
    const url = new URL(iframe.src);
    this.origin = url.origin;

    // we defer messages until the iframe is ready for us.
    this.pendingQueue = [];

    this._boundIframeLoaded = this._iframeLoaded.bind(this);
    this.iframe.addEventListener('load', this._boundIframeLoaded);
    console.log('oimh: waiting for load of', url, 'with origin', this.origin);

    this._boundWindowMessage = this._onWindowMessage.bind(this);
    this.win.addEventListener('message', this._boundWindowMessage);
  }

  _iframeLoaded() {
    console.log('oimh: iframe loaded');
    this.iframe.removeEventListener('load', this._boundIframeLoaded);

    let queue = this.pendingQueue;
    this.pendingQueue = null;

    for (let msg of queue) {
      this._postMessage(msg);
    }
  }

  cleanup() {
    this.win.removeEventListener('message', this._boundWindowMessage);
  }

  _postMessage(msg) {
    if (this.pendingQueue) {
      this.pendingQueue.push(msg);
      return;
    }

    console.log('oimh: postMessage:', msg);
    this.iframe.contentWindow.postMessage(msg, this.origin);
  }

  /**
   * Process messages that come from our iframe bridge.  We need to filter out
   * any other messsages pernosco might be receiving;
   */
  _onWindowMessage(evt) {
    if (this.origin && evt.origin !== this.origin) {
      return;
    }
    evt.stopPropagation();
    evt.preventDefault();

    console.log('oimh: receive:', evt.data);
    this._onMessage(evt);
  }
}

/**
 * Lives inside an iframe and relays messages received from outside the iframe
 * sent by OutsideIframeMessageHandler over BroadcastChannel.  This is not a
 * MessageHandler but a naive relay.
 *
 * Message flow is therefore:
 * - In from BroadcastChannel => out to parent window
 * - In from own window => out to BroadcastChannel
 */
export class InsideIframeBroadcastChannelBridge {
  constructor({ win }) {
    this.win = win;
    this.parentWin = win.parent;

    this.win.addEventListener('message', this._onWindowMessage.bind(this));

    this.bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    this.bc.onmessage = this._onBCMessage.bind(this);
  }

  _onBCMessage(evt) {
    // Our parent can only be the pernosco window we were created in, '*' is
    // fine.
    this.parentWin.postMessage(evt.data, '*');
  }

  _onWindowMessage(evt) {
    this.bc.postMessage(evt.data);
  }
}
