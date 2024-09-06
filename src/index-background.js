var gNextSessionId = 1;

var gPendingConnectionsByName = new Map();

function connectHandler(port) {
  let resolver = gPendingConnectionsByName.get(port.name);
  if (resolver) {
    console.log("Connecting named port:", port.name);
    gPendingConnectionsByName.delete(port.name);
    resolver(port);
  } else {
    console.log("Port connection request for unknown port:", port.name);
  }
}
browser.runtime.onConnect.addListener(connectHandler);
function waitForNamedPort(name) {
  const promise = new Promise(resolve => {
    gPendingConnectionsByName.set(name, resolve);
  });
  return promise;
}

// TODO: We probably actually want to be doing something like watch the tabs so
// that on reload of the UI we'd issue a new port, and for a pernosco reload we
// would re-executeScript and then send the fresh port, etc.
function gluePorts(pernoscoPort, uiPort) {
  pernoscoPort.onDisconnect.addListener(() => {
    console.log("Pernosco port disconnect, disconnecting UI port.");
    uiPort.disconnect();
  });
  pernoscoPort.onMessage.addListener(msg => {
    console.log("relaying from pernosco to ui", msg);
    uiPort.postMessage(msg);
  });

  uiPort.onDisconnect.addListener(() => {
    console.log("UI port disconnect, disconnecting pernosco port.");
    pernoscoPort.disconnect();
  });
  uiPort.onMessage.addListener(msg => {
    console.log("relaying from ui to pernosco", msg);
    pernoscoPort.postMessage(msg);
  })
}

async function showSimpleUI(pernoscoTab) {
  let sessionId = gNextSessionId++;
  let sessionName = `sess${sessionId}`;

  // We want to wait for the server to have registered itself.
  console.log("Waiting for content script to load.");
  await browser.tabs.executeScript(pernoscoTab.id, {
    file: "/inject.js"
  });
  console.log("Content script loaded.");

  let uiTab = await browser.tabs.create({
    active: true,
    // XXX the intent here is to enable TreeStyleTab to group the new tab with
    // the pernosco tab, not sure if this works...
    openerTabId: pernoscoTab.id,
    url: `/simple.html#${sessionName}`
  });

  let uiPort = await waitForNamedPort(sessionName);
  // Wait to establish the pernosco port until we've received the request so
  // that we can immediately glue them together; there is no startMessages
  // affordance that queues the messages until we're ready.
  let pernoscoPort = browser.tabs.connect(pernoscoTab.id, { name: sessionName });

  gluePorts(pernoscoPort, uiPort);
  console.log("ports glued");
}

browser.browserAction.onClicked.addListener(showSimpleUI);
