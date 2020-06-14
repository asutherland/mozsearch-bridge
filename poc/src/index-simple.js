// Foo

import { BridgeClient } from './bridge/client.js';

console.log('app js loaded');

let gNextReqId = 1;
let client = new BridgeClient();

function prettifyData(data, depth=0) {
  const dataElem = document.createElement('div');
  dataElem.setAttribute('class', 'pda-data');

  for (let [key, value] of Object.entries(data)) {
    const keyElem = document.createElement('div');
    keyElem.setAttribute('class', `pda-data-key pda-data-key-depth-${depth}`);
    keyElem.textContent = key;
    dataElem.appendChild(keyElem);

    let valueElem;
    if (typeof(value) === 'object') {
      valueElem = prettifyData(value, depth + 1);
    } else {
      valueElem = document.createElement('div');
      valueElem.textContent = JSON.stringify(value, null, 2);
    }
    valueElem.classList.add('pda-data-value');
    dataElem.appendChild(valueElem);
  }

  return dataElem;
}

/**
 * Create a somewhat dense HTML representation of raw PML that elides `focus`
 * structure details but does indicate their presence.  The goal is to be more
 * readable than `JSON.stringify()` and more dense than `stringify(,,2)`, not
 * to duplicate pernosco's `pmlToDom`.
 */
function prettifyPmlInto(node, into, depth=0) {
  if (typeof(node) === 'string') {
    const tn = document.createElement('span');
    tn.setAttribute('class', 'pd-str');
    tn.textContent = node;
    into.appendChild(tn);
    return;
  }

  const elem = document.createElement('div');
  elem.setAttribute('class', `pd pd${depth}`);

  if (node.t) {
    const tagElem = document.createElement('span');
    tagElem.setAttribute('class', 'pd-tag');
    tagElem.textContent = node.t;
    elem.appendChild(tagElem);
  }

  if (node.a) {
    const attrDictElem = document.createElement('div');
    attrDictElem.setAttribute('class', 'pda-container');
    for (let [key, value] of Object.entries(node.a)) {
      if (key === 'focus') {
        const focusElem = document.createElement('span');
        focusElem.setAttribute('class', 'pda-focus');
        focusElem.textContent = 'f';
        attrDictElem.appendChild(focusElem);
        continue;
      }

      if (key === 'data') {
        attrDictElem.appendChild(prettifyData(value));
        continue;
      }

      const pairElem = document.createElement('span');
      pairElem.setAttribute('class', 'pda-kv-pair');

      const keyElem = document.createElement('span');
      keyElem.setAttribute('class', 'pda-kv-key');
      keyElem.textContent = key;

      const equalsElem = document.createElement('span');
      equalsElem.setAttribute('class', 'pda-kv-equals');
      equalsElem.textContent = '=';

      const valueElem = document.createElement('span');
      valueElem.setAttribute('class', 'pda-kv-value');
      // for now just flatten instead of recursing.
      valueElem.textContent = JSON.stringify(value, null, 2);

      pairElem.appendChild(keyElem);
      pairElem.appendChild(equalsElem);
      pairElem.appendChild(valueElem);

      attrDictElem.appendChild(pairElem);
    }

    elem.appendChild(attrDictElem);
  }

  if (node.c) {
    for (const child of node.c) {
      prettifyPmlInto(child, elem, depth + 1);
    }
  }

  into.appendChild(elem);
}

function prettifyQueryResults(rowHandler, resultRows) {
  const frag = new DocumentFragment();

  for (const row of resultRows) {
    if ('items' in row) {
      for (const item of row.items) {
        if (item.pml) {
          rowHandler(item.pml, frag);
        }
      }
    }
  }

  return frag;
}

function renderRawJSON(resultRows) {
  const c = document.createElement('pre');
  c.textContent = JSON.stringify(resultRows, null, 2);
  return c;
}

function automagicQueryResults(resultRows, mode) {
  const frag = new DocumentFragment();



  return frag;
}

let gMostRecentResults = null;
let gRenderMode = "auto-magic";

function prettifyQueryResultsInto(resultRows, into, mode) {
  gMostRecentResults = { resultRows, into, mode };
  renderCurrentResults();
}

function renderCurrentResults() {
  if (!gMostRecentResults) {
    return;
  }

  let { resultRows, into, mode } = gMostRecentResults;
  into.innerHTML = '';

  let frag;
  switch (gRenderMode) {
    case "auto-magic": {
      frag = automagicQueryResults(resultRows, mode);
      break;
    }

    default:
    case "pretty-pml": {
      frag = prettifyQueryResults(prettifyPmlInto, resultRows);
      break;
    }

    case "raw": {
      frag = renderRawJSON(resultRows);
      break;
    }
  }

  into.appendChild(frag);
}

async function queryExecutions(symName) {
  const eOutput = document.getElementById('output-content');
  // This is our brand for ensuring we still should be the one outputting there.
  const reqId = eOutput.reqId = gNextReqId++;

  const results = await client.sendMessageAwaitingReply(
    'executionQuery',
    { symbol: symName, print: undefined });

  if (eOutput.reqId === reqId) {
    prettifyQueryResultsInto(results, eOutput, 'executions');
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
    prettifyQueryResultsInto(results, eOutput, 'current-tasks');
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

  document.getElementById('output-show-as-form').addEventListener('change', (evt) => {
    evt.preventDefault();

    gRenderMode = evt.target.value;
    console.log(`Display mode is now: ${evt.target.value}`);
    renderCurrentResults();
  });

  // Get the current "show-as" value, which may have been propagated from a
  // reload carrying prior form data forward.
  const showAsForm = document.forms['output-show-as-form'];
  const showAsFormData = new FormData(showAsForm);
  gRenderMode = showAsFormData.get('show-as');
});
