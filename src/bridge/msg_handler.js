/**
 * Simplified typed message support with async waiting for replies.  Assumes
 * use of the webext [runtime.Port](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/Port)
 * API where content script pages cannot directly communicate but instead must
 * route all messages through the background page/script where the background
 * script is responsible for establishing any pairwise connections.
 *
 * This started out assuming BroadcastChannel and then was simplified,
 * justifying any and all weirdness.
 */
export class MessageHandler {
  #nextId;
  #awaitingReplyPromises;
  #awaitingPortQueue;
  #cacheHelper;

  constructor(roleType, { cacheHelper }) {
    this.roleType = roleType;
    this.#nextId = 1;
    this.#awaitingReplyPromises = new Map();
    this.#awaitingPortQueue = [];
    this.#cacheHelper = cacheHelper;

    this.port = null;
  }

  setPort(port) {
    this.port = port;

    let queue = this.#awaitingPortQueue;
    this.#awaitingPortQueue = null;

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
    if (!this.port) {
      console.log("queueing sendMessage", type, payload);
      this.#awaitingPortQueue.push({ type, payload, replyId: null });
      return;
    }

    const msgId = `msg${this.#nextId++}`;

    this._postMessage({
      type,
      msgId,
      payload
    });
  }

  async sendMessageAwaitingReply(type, payload) {
    if (this.#cacheHelper) {
      const maybeResult = await this.#cacheHelper.lookup(this, type, payload);
      if (maybeResult) {
        console.log("using cached result", maybeResult);
        return maybeResult;
      } else if (maybeResult === undefined) {
        console.log("query was not cacheable");
      } else if (maybeResult === null) {
        console.log("query cache miss");
      }
    }

    const replyId = `reply${this.#nextId++}`;

    let resolve, reject;
    let promise = new Promise((_resolve, _reject) => {
      resolve = _resolve;
      reject = _reject;
    });

    this.#awaitingReplyPromises.set(replyId, { resolve, reject });
    this._sendMessageAwaitingReply(type, payload, replyId);

    const [result, extra] = await promise;
    if (this.#cacheHelper) {
      // We await this to allow the cacheHelper to have the flexibility to delay
      // things if it has a really good reason, but ideally it shouldn't.
      const stored = await this.#cacheHelper.store(this, type, payload, result, extra);
      console.log("result of trying to cache the result:", stored);
    }
    return result;
  }

  // This is a hook to allow for normalization of PML responses, in particular,
  // matching up "parent"-having items with "containerId" mount-points.
  _normalizeReceivedPayload(payload) {
    return payload;
  }

  _sendMessageAwaitingReply(type, payload, replyId) {
    if (!this.port) {
      this.#awaitingPortQueue.push({ type, payload, replyId });
      return;
    }

    const msgId = `msg${this.#nextId++}`;

    this._postMessage({
      type,
      msgId,
      replyId,
      payload
    });
  }

  _onMessage(msg) {
    console.log("received message", msg);

    if (msg?.type === 'reply') {
      if (!this.#awaitingReplyPromises.has(msg.msgId)) {
        return;
      }
      const { resolve } = this.#awaitingReplyPromises.get(msg.msgId);

      resolve([this._normalizeReceivedPayload(msg.payload), msg.extra]);
      this.#awaitingReplyPromises.delete(msg.msgId);
      return;
    }

    const lookupName = `onMsg_${msg.type}`;

    let replyFunc;
    if ('replyId' in msg) {
      const replyId = msg.replyId;
      replyFunc = (payload, extra) => {
        this._postMessage({
          type: 'reply',
          msgId: replyId,
          payload,
          extra,
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
 * MessageHandler that waits for a connection.
 */
export class RuntimeConnectListeningHandler extends MessageHandler {
  constructor(roleType, options) {
    super(roleType, options);

    browser.runtime.onConnect.addListener(this.#onConnect.bind(this))
  }

  #onConnect(port) {
    console.log("Port connection received.");
    this.setPort(port);
    port.onMessage.addListener(this._onMessage.bind(this));

    if ("onConnect" in this) {
      this.onConnect();
    }
  }

  _postMessage(msg) {
    console.log("posting", msg);
    this.port.postMessage(msg);
  }
}

/**
 * MessageHandler that initiates a connection to the background page.
 */
export class RuntimeConnectIssuingHandler extends MessageHandler {
  constructor(roleType, name, options) {
    super(roleType, options);

    console.log("Opening port with name:", name);
    const port = browser.runtime.connect({ name });
    this.setPort(port);
    port.onMessage.addListener(this._onMessage.bind(this));

    if ("onConnect" in this) {
      this.onConnect();
    }
  }

  _postMessage(msg) {
    console.log("posting", msg);
    this.port.postMessage(msg);
  }
}
