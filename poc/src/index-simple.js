// Foo

import { BridgeClient } from './bridge/client.js';

console.log('app js loaded');

let gNextReqId = 1;
let client = new BridgeClient();

async function queryExecutions(symName) {
  const eOutput = document.getElementById('output-content');
  // This is our brand for ensuring we still should be the one outputting there.
  const reqId = eOutput.reqId = gNextReqId++;

  const results = await client.sendMessageAwaitingReply(
    'executionQuery',
    { symbol: symName, print: undefined });

  if (eoutput.reqId === reqId) {
    eOutput.textContent = JSON.stringify(results, null, 2);
  }
}

async function queryCurrentTasks() {
  const eOutput = document.getElementById('output-content');
  // This is our brand for ensuring we still should be the one outputting there.
  const reqId = eOutput.reqId = gNextReqId++;

  const results = await client.sendMessageAwaitingReply(
    'simpleQuery',
    { name: 'current-tasks', params: {} });

  if (eOutput.reqId === reqId) {
    eOutput.textContent = JSON.stringify(results, null, 2);
  }
}

window.addEventListener('load', () => {
  document.getElementById('show-symbol').addEventListener('click', (evt) => {
    const eSymName = document.getElementById('symbol-name');
    const symName = eSymName.value;

    queryExecutions(symName);
  });

  document.getElementById('show-current-tasks').addEventListener('click', (evt) => {
    queryCurrentTasks();
  });
});
