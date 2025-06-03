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

  // Pernosco URLs look like: https://pernos.co/debug/ps0J9-pJ2TxCDiz5XJu-2g/index.html#HASH
  let pernoscoUrl = new URL(pernoscoTab.url);
  let traceName = pernoscoUrl.pathname.split("/")[2];
  console.log("Opening tab for: Trace name", traceName, "Session name", sessionName);

  let uiUrlParams = new URLSearchParams();
  uiUrlParams.append("sess", sessionName);
  uiUrlParams.append("trace", traceName);

  const uiUrl = `/simple.html?${uiUrlParams.toString()}`;
  console.log("Opening UI URL", uiUrl);
  let uiTab = await browser.tabs.create({
    active: true,
    // XXX the intent here is to enable TreeStyleTab to group the new tab with
    // the pernosco tab, not sure if this works...
    openerTabId: pernoscoTab.id,
    url: uiUrl,
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

async function searchfoxContextMenuClicked(info, tab) {
  // ## Standards Specs Processing
  //
  // Info potentially contains { linkText, linkUrl, pageUrl, targetElementId },
  // with the links only being available in the "link" context, but the others
  // always being available.  If we were running in a content script we could
  // also use `menus.getTargetElement()` but we currently only run as a
  // background script because we are currently trying to avoid injecting
  // content scripts unless needed.
  //
  // The situations are generally going to be:
  // - A def/dfn: We will only have an id and it will be the id of the dfn in
  //   the spec.  But we also will have the pageUrl and combining those two
  //   gives us a full usable absolute URL.
  // - A use that references a def/dfn elsewhere: We expect to have the linkUrl
  //   and we expect the id to look like "ref-for-{dfn id}{optional circled digits}".
  //   The {dfn id} of course could be for a definition in another document and
  //   whether it is will be clear from the actual link URL.  Currently the
  //   normal searchfox semantics don't actually care about the specific use
  //   we click on for the diagram options, so we don't currently need to do
  //   anything with these "ref-for" cases, we just need to process the link.
  //
  // 
  //
}

browser.contextMenus.create({
    id: "mozsearch-diagram-uses",
    title: "Uses diagram",
    contexts: ["link", "page"],
  });
  browser.contextMenus.create({
    id: "mozsearch-diagram-calls",
    title: "Calls diagram",
    contexts: ["link", "page"],
  });
browser.contextMenus.onClicked.addListener(searchfoxContextMenuClicked)
