import { BridgeClient } from './bridge/client.js';

import { Timeline } from "vis-timeline/peer";
import { DataSet } from "vis-data/peer";

import { loadAnalyzer } from './analyzer/analyzer.js';

import { grokPML, grokPMLRows, normalizePmlPayload } from './pmlgrok/grokker.js';

console.log('app js loaded');

let gMoment;

let gNextReqId = 1;
let client = new BridgeClient({
  normalizeReceivedPayload: normalizePmlPayload,
  onStatusReport(statusReport) {
    console.log("Got status report:", statusReport);
    const statusElem = document.getElementById('status-content');
    statusElem.innerHTML = "";
    //statusElem.appendChild(prettifyData(statusReport));
    /*
    if (statusReport.annotation) {
      prettifyPmlInto(statusReport.annotation, statusElem);
    }
    */
    if (statusReport.focus) {
      const moment = statusReport.focus.moment;
      statusElem.textContent = `Event: ${moment.event} Instr: ${moment.instr}`;

      gMoment = moment;

      if (gTimelineSeek) {
        gTimelineSeek(moment);
      }
    }
  },
});

/**
 * Normalize a tuid into a string so that we can use it for key purposes.
 */
function normTuid(tuid) {
  return `${tuid.serial}-${tuid.tid}`;
}

/**
 * Helper to flatten a hierarchical object structure to a single-depth table.
 * We know that the visual presentation will be one leaf node per row on the
 * right, with non-leaf nodes spanning multiple rows.
 */
class TableMaker {
  constructor() {
    /**
     * All the current non-leaf nodes.
     */
    this.curStack = [];
    this.maxDepth = 0;
    /**
     * All the leaf nodes, retained for fixup purposes.
     */
    this.leafNodes = [];

    this.curRow = null;
    this.root = document.createElement('table');
    this.root.setAttribute('class', 'pda-data');
  }

  _ensureRow() {
    if (!this.curRow) {
      this.curRow = document.createElement('tr');
      this.root.appendChild(this.curRow);
    }
  }

  _emitRow(node) {
    this._ensureRow();
    this.curRow.appendChild(node);
    this.curRow = null;
  }

  _bumpRowUses() {
    for (const info of this.curStack) {
      info.useCount += 1;
      info.elem.rowSpan = info.useCount;
    }
  }

  pushKey(key) {
    const depth = this.curStack.length;

    const keyElem = document.createElement('td');
    keyElem.setAttribute('class', `pda-data-key pda-data-key-depth-${depth}`);
    keyElem.textContent = key;

    this._ensureRow();
    this.curRow.appendChild(keyElem);

    this.curStack.push({
      elem: keyElem,
      // rowSpan starts at 1, but we want it to start at 0, so we maintain our
      // own separate useCount here.
      useCount: 0
    });
    this.maxDepth = Math.max(this.curStack.length, this.maxDepth);
  }

  popKey() {
    this.curStack.pop();
  }

  /**
   * Emit a leaf value, which means writing out the cell and finishing the row.
   * It's at this point that we adjust rowSpans.
   */
  emitLeaf(value) {
    const valueElem = document.createElement('td');
    valueElem.textContent = JSON.stringify(value, null, 2);
    valueElem.classList.add('pda-data-value')
    this.leafNodes.push({ depth: this.curStack.length, elem: valueElem });
    this._bumpRowUses();
    this._emitRow(valueElem);
  }

  finalize() {
    for (const leaf of this.leafNodes) {
      leaf.elem.colSpan = this.maxDepth - leaf.depth + 1;
    }

    return this.root;
  }
}

/**
 * Layout-friendly data prettifier.  (Layout-unfriendly version was removed but
 * lives on in https://bugzilla.mozilla.org/show_bug.cgi?id=1591366#c6.)
 */
function prettifyData(dataRoot) {
  const tableMaker = new TableMaker();

  function traverse(data) {
    if (!data) {
      tableMaker.emitLeaf(data);
      return;
    }

    let keyCount = 0;
    for (let [key, value] of Object.entries(data)) {
      keyCount++;

      tableMaker.pushKey(key);

      if (typeof(value) === 'object') {
        traverse(value);
      } else {
        tableMaker.emitLeaf(value);
      }

      tableMaker.popKey();
    }

    // This could have been an empty object, in which case we want to emit an
    // empty object.
    if (keyCount === 0) {
      tableMaker.emitLeaf(data);
    }
  }
  traverse(dataRoot);

  return tableMaker.finalize();
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
        // Save the focus value as an expando into the DOM for deref purposes.
        elem.usingFocus = value;

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

      if (key === "deref") {
        const btn = document.createElement('input');
        btn.type = 'button';
        btn.value = 'Deref';
        // Previously, the `value` was null and we wanted the sibling `data`
        // value, but now the value contains the request to use.  (Or maybe I
        // always had this wrong?)
        btn.derefData = value;
        btn.derefMoment = node.a.dataMoment;
        // The deref action will also need the `usingFocus` of the first
        // ancestor with a `usingFocus`, with the dataMoment clobbering the
        // focus's dataMoment.
        attrDictElem.appendChild(btn);
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

function grokAndPrettifyInto(node, into, depth=0, mode) {
  const result = grokPML(node, mode);

  into.appendChild(prettifyData(result));
}

function prettifyQueryResults(rowHandler, resultRows, mode) {
  const frag = new DocumentFragment();

  // Note: We used to normalize the lower level "evaluate" rep here, but we now
  // perform that normalization in the same places we perform the query.
  if (mode === 'analyzed') {
    for (const row of resultRows) {
      rowHandler(row, frag, 0, mode);
    }
  } else {
    for (const row of resultRows) {
      if ('items' in row) {
        for (const item of row.items) {
          if (item.pml) {
            rowHandler(item.pml, frag, 0, mode);
          }
        }
      }
    }
  }

  return frag;
}

/**
 * Prettify pernosco pml log view output with numbered rows on the left where
 * clicking on the row will seek to the focus associated with the log.
 */
function prettifyLogs(resultRows) {
  const fragment = new DocumentFragment();

  let index = 0;
  for (const row of resultRows) {
    const curIndex = index++;

    const ePre = document.createElement('pre');

    const ePrefix = document.createElement('span');
    ePrefix.setAttribute('class', 'pda-focus');
    ePrefix.textContent = curIndex.toString(10).padStart(8) + " ";
    ePre.appendChild(ePrefix);

    if (row.items) {
      for (const item of row.items) {
        if (item.focus) {
          ePre.usingFocus = item.focus;
        }
        const text = document.createTextNode(item?.pml?.c?.[0]?.c?.[0]);
        ePre.appendChild(text);
      }
    } else {
      ePre.appendChild(document.createTextNode("\n"));
    }

    fragment.appendChild(ePre);
  }

  return fragment;
}

function renderRawJSON(resultRows) {
  const c = document.createElement('pre');
  c.textContent = JSON.stringify(resultRows, null, 2);
  return c;
}

function shortSymbolName(name) {
  const parts = name.split('::');
  return parts.slice(-2).join('::');
}

/**
 * The timeline data currently accumulates.
 */
let gTimelineData;
let gTimelineGroups;
let gLastIngestedRows;
let gTimeline;
let gTimelineSeek;
let gTimelineDataGen = 0;

const EVENT_SCALE = 100;

// Given a bunch of trace results rows, render them into a timeline.  Compare
// with `renderTimelineFromAnalysis` which renders the derived hierarchical
// object lifetimes from `analyzer.js`.
function renderTimelineFromRows(rows, container, mode) {
  // Only process this data if we haven't already processed it.  (We don't want
  // switching between rendering modes to keep adding duplicate data.)
  if (gLastIngestedRows !== rows) {
    gLastIngestedRows = rows;

    if (!gTimelineData) {
      gTimelineGroups = new DataSet();
      gTimelineData = new DataSet();
    }

    const groups = gTimelineGroups;
    const data = gTimelineData;

    const results = grokPMLRows(rows);
    for (let call of results) {
      let printed = null;
      if (call.queried) {
        printed = call.printed;
        call = call.queried;
      }
      const { puid, tuid } = call.meta;
      const pid = normTuid(puid);
      const tid = normTuid(tuid);
      let pidGroup = groups.get(pid);
      if (!pidGroup) {
        pidGroup = {
          id: pid,
          content: `${pid}`,
          nestedGroups: [],
        };
        groups.add(pidGroup);
      }

      // if the tid is also the pid, just leave it.
      if (pid !== tid) {
        let tidGroup = groups.get(tid);
        if (!tidGroup) {
          tidGroup = {
            id: tid,
            content: `${tid}`
          };
          groups.add(tidGroup);
        }
        if (!pidGroup.nestedGroups.includes(tid)) {
          pidGroup.nestedGroups.push(tid);
        }
      }

      let content = shortSymbolName(call.func.name);
      if (printed) {
        for (const item of printed) {
          if (item.value && item.value.data) {
            content += `<br>${item.name}: ${item.value.data}`;
          }
        }
      }

      let dataId = gTimelineDataGen++;
      data.add({
        id: dataId,
        group: tid,
        content,
        type: 'range',
        start: call.meta.entryMoment.event,
        end: call.meta.returnMoment ? call.meta.returnMoment.event : call.meta.entryMoment.event,
        extra: {
          focus: call.meta.focusInfo,
        },
      });
    }
  }

  // Our client listener looks for this global and will invoke it when the
  // pernosco session is seeked, allowing us to remain synchronized.
  gTimelineSeek = (moment) => {
    // Set the marker for the current focus point.
    gTimeline.setCustomTime(moment.event, "focus");

    // Check whether the focus point is visible for the current visible time
    // window and if not move the timeline so that it's centered.  We do
    // this conditionally to avoid moving the timeline unless necessary;
    // this is important because moving the timeline can impact layout and
    // the user's understanding of what they're looking at.
    const { start, end } = gTimeline.getWindow();
    if (moment.event < start || moment.event > end) {
      gTimeline.moveTo(moment.event);
    }
  };

  renderTimeline(container, true, 'container');
}

function renderTimelineFromAnalysis(analyzer, container) {
  if (!gTimelineData) {
    gTimelineGroups = new DataSet();
    gTimelineData = new DataSet();
  }

  gTimelineGroups.clear();
  gTimelineData.clear();

  analyzer.renderIntoVisJs(gTimelineGroups, gTimelineData);
  console.log('used analyzer', analyzer, gTimelineGroups);

  gTimelineSeek = (moment) => {
    const targetSeqId = analyzer.mapMomentToSeqId(moment);

    // Set the marker for the current focus point.
    gTimeline.setCustomTime(targetSeqId, "focus");

    // Check whether the focus point is visible for the current visible time
    // window and if not move the timeline so that it's centered.  We do
    // this conditionally to avoid moving the timeline unless necessary;
    // this is important because moving the timeline can impact layout and
    // the user's understanding of what they're looking at.
    const { start, end } = gTimeline.getWindow();
    if (targetSeqId < start || targetSeqId > end) {
      gTimeline.moveTo(targetSeqId);
    }
  };

  renderTimeline(
    container, false, (groupA, groupB) => {
      // sort priorities descending
      const priorityDelta = (groupB.priority || 0) - (groupA.priority || 0);
      if (priorityDelta) {
        return priorityDelta;
      }
      return (groupA.earliestSeqId || 0) - (groupB.earliestSeqId || 0);
    });
}

// Common timeline rendering helper, invoked by other renderTimeline* funcs.
function renderTimeline(container, doStack=true, groupOrder) {
  console.log('rendering timeline using groups', gTimelineGroups, 'data', gTimelineData);

  const options = {
    // configure produces an interesting configuration UI after the timeline,
    // but it didn't seem immediately useful.
    //configure: true,
    clickToUse: true,
    zoomMin: 10,
    zoomMax: 1 * 1000 * 1000,
    zoomFriction: 40,
    showCurrentTime: false,
    // TODO: Probably figure out a general gameplan for these.
    groupOrder,
    // The analyzer would ideally like to be able to control stacking at the
    // group level, but `subgroupStack` is just for subgroups... I think.
    stack: doStack,
    format: {
      minorLabels: function(date/*, scale/*, step*/) {
        const relTicks = date.valueOf(); //Math.floor(date / 100);
        return `${relTicks} Seqs`;
      },
      majorLabels: function(date/*, scale/*, step*/) {
        const relTicks = Math.floor(date / 100);
        return `${relTicks} CSeqs`;
      }
    }
  };

  if (!gTimeline) {
    gTimeline = new Timeline(container, gTimelineData, gTimelineGroups, options);
    let customTime = 0;
    if (client.statusReport && client.statusReport.focus &&
        client.statusReport.focus.moment) {
      customTime = client.statusReport.focus.moment.event;
    }
    gTimeline.addCustomTime(customTime, "focus");
    gTimeline.on('click', (info) => {
      // Make us seek to the construction moment of the lifetime.
      //
      // Consider: check whether we're closer to the start/end and pick the
      // destruction moment if closer to the end.
      if (info.what === "background" && info.group) {
        const group = gTimelineGroups.get(info.group);
        console.log('BACKGROUND GROUP', group);
        const focusInfo = group?.extra?.inst?.constructorExec?.call?.meta?.focusInfo;
        if (focusInfo) {
          client.setFocus(focusInfo);
        } else {
          console.log('No focus info; not trying to focus.');
        }
      }
    });
    gTimeline.on('select', ({items, event}) => {
      if (items.length !== 1) {
        return;
      }
      const item = gTimelineData.get(items[0]);
      console.log('Trying to focus', item);
      client.setFocus(item.extra.focus);
    });
  }
}

let gMostRecentResults = null;
let gRenderMode = "auto-magic";
let gLastRender = "";

function prettifyQueryResultsInto(resultRows, into, mode) {
  gMostRecentResults = window.RESULTS = { resultRows, into, mode };
  renderCurrentResults();
}

function renderCurrentResults() {
  if (!gMostRecentResults) {
    return;
  }

  let { resultRows, into, mode } = gMostRecentResults;

  if (gTimeline && gRenderMode !== "timeline") {
    gTimeline.destroy();
    gTimeline = null;
  }
  // We like to redraw from scratch unless we were already displaying the
  // timeline and are going to continue to be displaying the timeline.
  if (gLastRender !== "timeline" || gRenderMode !== "timeline") {
    into.innerHTML = '';
  }

  let frag;
  switch (gRenderMode) {
    case "auto-magic": {
      frag = prettifyQueryResults(grokAndPrettifyInto, resultRows, mode);
      break;
    }

    default:
    case "pretty-pml": {
      frag = prettifyQueryResults(prettifyPmlInto, resultRows, mode);
      break;
    }

    case "logs": {
      frag = prettifyLogs(resultRows, mode);
      break;
    }

    case "raw": {
      frag = renderRawJSON(resultRows, mode);
      break;
    }

    case "lineup": {
      // TODO: implementing lineup hookup here.
      break;
    }

    case "timeline": {
      renderTimelineFromRows(resultRows, into, mode);
    }
  }

  if (frag) {
    into.appendChild(frag);
  }
  gLastRender = gRenderMode;
}

async function queryExecutions(symName, print) {
  const eOutput = document.getElementById('output-content');
  // This is our brand for ensuring we still should be the one outputting there.
  const reqId = eOutput.reqId = gNextReqId++;

  const results = await client.sendMessageAwaitingReply(
    'rangeQuery',
    {
      name: 'execution',
      limit: 250,
      mixArgs: {
        params: {
          symbol: symName,
          print
        },
      },
    });

  let mode = print ? 'executions-with-print' : 'executions';

  if (eOutput.reqId === reqId) {
    prettifyQueryResultsInto(results, eOutput, mode);
  }
}

async function queryStdouterr() {
  const eOutput = document.getElementById('output-content');
  // This is our brand for ensuring we still should be the one outputting there.
  const reqId = eOutput.reqId = gNextReqId++;

  const results = await client.sendMessageAwaitingReply(
    'rangeQuery',
    {
      name: 'stdouterr',
      limit: 5000,
      mixArgs: {
        params: {},
      },
    });

  let mode = "logs";

  if (eOutput.reqId === reqId) {
    prettifyQueryResultsInto(results, eOutput, mode);
  }
}

async function queryLogs() {
  const eOutput = document.getElementById('output-content');
  // This is our brand for ensuring we still should be the one outputting there.
  const reqId = eOutput.reqId = gNextReqId++;

  const results = await client.sendMessageAwaitingReply(
    'rangeQuery',
    {
      name: 'microdiversionsLog',
      limit: 5000,
      mixArgs: {
        params: {},
      },
    });

  let mode = "logs";

  if (eOutput.reqId === reqId) {
    prettifyQueryResultsInto(results, eOutput, mode);
  }
}

// note there's also "complete-frame" which finds the source code for the
// current moment.
async function queryStack() {
  const eOutput = document.getElementById('output-content');
  // This is our brand for ensuring we still should be the one outputting there.
  const reqId = eOutput.reqId = gNextReqId++;

  const results = await client.sendMessageAwaitingReply(
    'simpleQuery',
    {
      name: 'stack',
      mixArgs: {
        params: {}
      },
    });

  if (eOutput.reqId === reqId) {
    prettifyQueryResultsInto(results, eOutput, 'stack');
  }
}

async function queryCurrentTasks() {
  const eOutput = document.getElementById('output-content');
  // This is our brand for ensuring we still should be the one outputting there.
  const reqId = eOutput.reqId = gNextReqId++;

  const results = await client.sendMessageAwaitingReply(
    'simpleQuery',
    {
      name: 'current-tasks',
      mixArgs: {
        params: {}
      },
    });

  if (eOutput.reqId === reqId) {
    prettifyQueryResultsInto(results, eOutput, 'current-tasks');
  }
}

async function queryTaskTree() {
  const eOutput = document.getElementById('output-content');
  // This is our brand for ensuring we still should be the one outputting there.
  const reqId = eOutput.reqId = gNextReqId++;

  const results = await client.sendMessageAwaitingReply(
    'simpleQuery',
    {
      name: 'task-tree',
      mixArgs: {
        params: {}
      },
    });

  if (eOutput.reqId === reqId) {
    prettifyQueryResultsInto(results, eOutput, 'task-tree');
  }
}

// XXX deref was for a time distinct from "evaluate", but this should now be
// merged a little.
async function queryDeref(focus, data, moment) {
  const eOutput = document.getElementById('output-content');
  // This is our brand for ensuring we still should be the one outputting there.
  const reqId = eOutput.reqId = gNextReqId++;

  // Copy the focus so we can clobber its moment.
  focus = Object.assign({}, focus);
  focus.moment = moment;

  const results = await client.sendMessageAwaitingReply(
    'simpleQuery',
    {
      name: 'evaluate',
      mixArgs: {
        focus,
        payload: {
          data,
        }
      },
    });

  if (eOutput.reqId === reqId) {
    prettifyQueryResultsInto(results, eOutput, 'evaluate');
  }
}

/**
 * Synthesize an evaluate request for a memory address and given length.
 *
 * TODO: Support also using an already known dwarf type to impose a type view
 * on a given piece of memory.
 *
 * In general the goal here is to provide a means to provide hand-rolled glue
 * logic to help bridge pretty printing gaps that pernosco couldn't possibly
 * understand from the type system like nsTHashtable.
 */
async function queryMemory(memAddr, memLength) {
  const eOutput = document.getElementById('output-content');
  // This is our brand for ensuring we still should be the one outputting there.
  const reqId = eOutput.reqId = gNextReqId++;

  const focus = client.statusReport.focus;

  const results = await client.sendMessageAwaitingReply(
    'simpleQuery',
    {
      name: 'evaluate',
      mixArgs: {
        focus,
        payload: {
          data: {
            producer: {
              memory: {
                addressSpace: focus.frame.addressSpaceUid,
                padWithUnmapped: memLength,
                ranges: [
                  {
                    end: memAddr + memLength,
                    start: memAddr,
                  }
                ]
              }
            },
            renderer: {
              pointer: 64,
            }
          }
        }
      },
    });

  if (eOutput.reqId === reqId) {
    prettifyQueryResultsInto(results, eOutput, 'evaluate');
  }
}

/**
 * Search evaluations can come back wrapped as [inline, explorable, inline]
 * where we can pierce the outer inline and explorable and return just the
 * inner inline.
 */
function pmlUnwrapExplorable(node) {
  if (node.t !== 'inline' || node.c.length !== 1) {
    return node;
  }
  let inner = node.c[0];
  if (inner.t !== 'explorable' || inner.c.length !== 1) {
    return node;
  }
  return inner.c[0];
}

/**
 * Use the search box pretty printing mechanism to initiate a search which
 * should result in an evaluation.
 */
async function querySearchEvaluate(symName) {
  const eOutput = document.getElementById('output-content');
  // This is our brand for ensuring we still should be the one outputting there.
  const reqId = eOutput.reqId = gNextReqId++;

  const rawResults = await client.sendMessageAwaitingReply(
    'simpleQuery',
    {
      name: 'search',
      mixArgs: {
        focus: client.statusReport.focus,
        input: symName,
        maxResults: 10,
      },
    });

  let results = [];
  console.log('raw results', rawResults);
  for (const outerRow of rawResults) {
    if (!outerRow.results) {
      continue;
    }

    for (const row of outerRow.results) {
      // We expect a row with { action: { evaluation: { pml: pmlNode } },
      // description: pmlNode }
      if (!row.action || !row.action.evaluation) {
        continue;
      }

      // We're directly interested in the evaluation, so just use its pmlNode.
      let pmlNode = pmlUnwrapExplorable(row.action.evaluation.pml);
      // We wrap this to look like what prettifyQueryResults expects for
      // "evaluate".
      results.push({ items: [{ pml: pmlNode }] });
    }
  }

  if (eOutput.reqId === reqId) {
    prettifyQueryResultsInto(results, eOutput, 'search-evaluate');
  }
}

function buildEvalPayload(symName) {
  return {
    expression: symName,
    context: [
      client.statusReport.source.url,
      {
        "l": client.statusReport.source.pos.l[0],
        "c": client.statusReport.source.pos.l[1],
      }
    ],
    language: client.statusReport.source.lang,
  };
}

function normalizeValueToPml(rawResults) {
  let results = [];
  for (const row of rawResults) {
    results.push({ items: [{ focus: row.focus, pml: row.value }]})
  }
  return results;
}

/**
 * Request an evaluation.  There appear to be the following variations of this:
 * 1. The client requesting an expansion of a `payload` that contains the
 *    server-provided `data` from a previous PML response.
 * 2. This one: Source view hovering, with contents of:
 *    - "focus": The current UI focus
 *    - "expression": The word that was hovered over in the source.
 *    - "context": [Source URL, { offset }]
 * 3. Typing an expression into the search bar up top (new!)
 */
async function queryEvaluate(symName) {
  const eOutput = document.getElementById('output-content');
  // This is our brand for ensuring we still should be the one outputting there.
  const reqId = eOutput.reqId = gNextReqId++;

  const rawResults = await client.sendMessageAwaitingReply(
    'simpleQuery',
    {
      name: 'evaluate',
      mixArgs: {
        focus: client.statusReport.focus,
        payload: buildEvalPayload(symName),
      },
    });

  if (eOutput.reqId === reqId) {
    prettifyQueryResultsInto(normalizeValueToPml(rawResults), eOutput, 'evaluate');
  }
}

function extractPointerAndTypeFromRawValue(rawResults) {
  const row = rawResults[0];
  const grokked = grokPML(row.value, "evaluate");
  const producer = grokked?.value?.values?.[0]?.producer;
  if (producer) {
    let type;
    if (producer.size === 8) {
      type = "uint64_t";
    } else {
      type = "uint32_t";
    }
    return [`0x${producer.address.toString(16)}`, type];
  }
  return [null, null];
}

async function queryEvaluateAndWatch(symName) {
  const eOutput = document.getElementById('output-content');
  // This is our brand for ensuring we still should be the one outputting there.
  const reqId = eOutput.reqId = gNextReqId++;

  const rawResults = await client.sendMessageAwaitingReply(
    'simpleQuery',
    {
      name: 'evaluate',
      mixArgs: {
        focus: client.statusReport.focus,
        payload: buildEvalPayload(symName),
      },
    });

  const [address, type] = extractPointerAndTypeFromRawValue(rawResults);
  const results = await client.sendMessageAwaitingReply(
    'rangeQuery',
    {
      name: 'watchpoint',
      limit: 111,
      mixArgs: {
        params: {
          address,
          type,
        },
      },
    });

  if (eOutput.reqId === reqId) {
    prettifyQueryResultsInto(results, eOutput, 'watchpoint');
  }
}

async function queryEvaluateAndWatchAndRefcountTrace(symName) {
  const eOutput = document.getElementById('output-content');
  // This is our brand for ensuring we still should be the one outputting there.
  const reqId = eOutput.reqId = gNextReqId++;

  const rawResults = await client.sendMessageAwaitingReply(
    'simpleQuery',
    {
      name: 'evaluate',
      mixArgs: {
        focus: client.statusReport.focus,
        payload: buildEvalPayload(symName),
      },
    });

  const [address, type] = extractPointerAndTypeFromRawValue(rawResults);
  const rawWatchResults = await client.sendMessageAwaitingReply(
    'rangeQuery',
    {
      name: 'watchpoint',
      limit: 111,
      mixArgs: {
        params: {
          address,
          type,
        },
      },
    });

  // (Now we have the history of the values over time.)

  // ## Figure out the first reasonable starting value sequence
  //
  // Ideally when we're going based on the analyzer data we'll have a strictly
  // bound timeline, but when operating in a heuristic mode, we should see
  // expect to see a 0 value followed by a 1 value as the start of the valid
  // sequence.  (And presumably before that, we should see e5 poison.)
  let useWatchResults;
  for (let iVal = 1; iVal < rawWatchResults.length; iVal++) {
    const lastVal = result[iVal - 1].data;
    const thisVal = result[iVal].data;
    if (lastVal === "0" && thisVal === "1") {
      useWatchResults = rawWatchResults.slice(iVal - 1);
      break;
    }
  }
  if (!useWatchResults) {
    console.error("failed to find valid start of refcounting!");
  }

  // ## NEXTSTEP


  if (eOutput.reqId === reqId) {
    prettifyQueryResultsInto(rawWatchResults, eOutput, 'watchpoint');
  }
}

let gAnalyzer;

async function runAnalyzer() {
  const eOutput = document.getElementById('output-content');
  const eStatus = document.getElementById('status-content');

  // This is our brand for ensuring we still should be the one outputting there.
  const reqId = eOutput.reqId = gNextReqId++;

  eStatus.textContent = '';

  const analyzer = gAnalyzer = await loadAnalyzer([
     //'toml-configs/shutdown-phases.toml',
    'toml-configs/sw-lifecycle.toml',
    'toml-configs/swp-lifecycle.toml',
    'toml-configs/clients-lifecycle.toml',
    //'toml-configs/document-channel.toml'
    //'toml-configs/browsing-context.toml',
    //'toml-configs/canonical-browsing-context.toml',
    //'toml-configs/global-window.toml',
  ]);
  // The results are currently just the aggregation of all the underlying
  // queries.
  console.log('using analyzer', analyzer);
  const results = await analyzer.analyze(
    client,
    (state, details) => {
      eStatus.textContent = state;
    });

  if (eOutput.reqId === reqId) {
    renderTimelineFromAnalysis(analyzer, eOutput);
    //prettifyQueryResultsInto(results, eOutput, 'raw');
  }
}

// BROKEN: Removed the graphviz WASM/asm.js dep, so we no longer have graphviz.
async function runVisualizer() {
  if (gAnalyzer) {
    const dotSrc = gAnalyzer.renderSemTypeInstancesToDot(
      // Root sem types
      new Set([

        'interceptedChannel',
        'loadListener',
        'docChannelParent',

        // 'browsingContext',
        //'canonicalBrowsingContext',
        //'windowGlobalParent',
      ]),
      // Valid sem types: set to null now to just treat all traversed edges from
      // the roots as fine.
      null,
      gMoment);
    // Client-side graphviz is currently disabled.
    console.log("Disabled dot:", { gMoment, dotSrc });
    //graphviz('#output-content', {}).renderDot(dotSrc);
  }
}

let gLastFocus = null;

function findClosestFocus(target, initialFocus=null) {
  let focus = initialFocus;
  for (let node = target; node; node = node.parentNode) {
    if (node.usingFocus) {
      focus = node.usingFocus;
      break;
    }
  }
  return focus;
}

function humanParseInt(str) {
  if (str.startsWith('0x')) {
    return parseInt(str, 16);
  }
  return parseInt(str, 10);
}

/**
 * Tab mechanism derived from about:networking's as it was readily available and
 * I thought it might be more accessible than I think it may be.
 */
function showTab(newHeaderElem) {
  const match = /tab-header-(.+)/.exec(newHeaderElem.id);
  const newTabName = match[1];

  console.log('switching to tab', newTabName);

  const oldHeaderElem = document.querySelector('[selected=true]');
  const oldTabElem = document.querySelector('.tab.active');

  oldTabElem.classList.remove('active');
  oldTabElem.hidden = true;
  oldHeaderElem.removeAttribute('selected');

  const newTabElem = document.getElementById(`tab-${newTabName}`);
  newTabElem.classList.add('active');
  newTabElem.hidden = false;
  newHeaderElem.setAttribute('selected', true);

  location.hash = newTabName;
}

window.addEventListener('load', () => {
  document.getElementById('show-symbol-executions').addEventListener('click', (evt) => {
    const eSymName = document.getElementById('symbol-name');
    const symName = eSymName.value;

    const eSymPrint = document.getElementById('symbol-print');
    const symPrint = eSymPrint.value || undefined;

    queryExecutions(symName, symPrint);
  });

  document.getElementById('eval-symbol-search').addEventListener('click', (evt) => {
    const eSymName = document.getElementById('eval-symbol-name');
    const symName = eSymName.value;

    querySearchEvaluate(symName);
  });

  document.getElementById('eval-symbol-run').addEventListener('click', (evt) => {
    const eSymName = document.getElementById('eval-symbol-name');
    const symName = eSymName.value;

    queryEvaluate(symName);
  });

  document.getElementById('eval-symbol-watch').addEventListener('click', (evt) => {
    const eSymName = document.getElementById('eval-symbol-name');
    const symName = eSymName.value;

    queryEvaluateAndWatch(symName);
  });

  document.getElementById('eval-symbol-watch-refcount').addEventListener('click', (evt) => {
    const eSymName = document.getElementById('eval-symbol-name');
    const symName = eSymName.value;

    queryEvaluateAndWatchAndRefcountTrace(symName);
  });

  document.getElementById('mem-run').addEventListener('click', (evt) => {
    const eAddr = document.getElementById('mem-address');
    const addr = humanParseInt(eAddr.value);

    const eLength = document.getElementById('mem-length');
    const length = humanParseInt(eLength.value);

    queryMemory(addr, length);
  });

  document.getElementById('show-current-tasks').addEventListener('click', (evt) => {
    queryCurrentTasks();
  });

  document.getElementById('show-task-tree').addEventListener('click', (evt) => {
    queryTaskTree();
  });

  document.getElementById('show-stack').addEventListener('click', (evt) => {
    queryStack();
  });

  document.getElementById('show-stdouterr').addEventListener('click', (evt) => {
    queryStdouterr();
  });

  document.getElementById('show-logs').addEventListener('click', (evt) => {
    queryLogs();
  });

  document.getElementById('analyze-run').addEventListener('click', (evt) => {
    runAnalyzer();
  });

  document.getElementById('vis-run').addEventListener('click', (evt) => {
    runVisualizer();
  });

  document.getElementById('output-show-as-form').addEventListener('change', (evt) => {
    evt.preventDefault();

    gRenderMode = evt.target.value;
    console.log(`Display mode is now: ${evt.target.value}`);
    renderCurrentResults();
  });

  document.getElementById('output-content').addEventListener('click', (evt) => {
    console.log('Processing click of', evt.target);

    // Handle focus clicks
    if (evt.target.classList.contains('pda-focus')) {
      evt.preventDefault();
      evt.stopPropagation();

      let focus = findClosestFocus(evt.target);
      if (focus) {
        console.log("Trying to focus", focus);
        client.setFocus(focus);
      }
      return;
    }

    // Handle deref requests
    if (evt.target.tagName === 'INPUT' &&
        evt.target.type === 'button' &&
        evt.target.value === 'Deref') {
      evt.preventDefault();
      evt.stopPropagation();

      // In the event this is a deref of a deref, we want to keep using the same
      // focus we used last time.
      let focus = findClosestFocus(evt.target, gLastFocus);
      let data = evt.target.derefData;
      let moment = evt.target.derefMoment;
      if (focus) {
        // Save off this focus so if we deref a deref it still works.
        gLastFocus = focus;
        queryDeref(focus, data, moment);
      }
      return;
    }
  });

  const eTabHeaders = document.getElementById('tab-headers');
  eTabHeaders.addEventListener('click', (evt) => {
    if (evt.target && evt.target.parentNode === eTabHeaders) {
      showTab(evt.target);
    }
  });

  if (location.hash) {
    const useHeaderElem =
      document.getElementById(`tab-header-${location.hash.substring(1)}`);
    showTab(useHeaderElem);
  }

  // Get the current "show-as" value, which may have been propagated from a
  // reload carrying prior form data forward.
  const showAsForm = document.forms['output-show-as-form'];
  const showAsFormData = new FormData(showAsForm);
  gRenderMode = showAsFormData.get('show-as');
});
