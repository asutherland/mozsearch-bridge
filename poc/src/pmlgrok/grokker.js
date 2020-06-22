/**
 * This file hosts an attempt to re-constitute semantic information from
 * pernosco's PML representation.  The term "grok" is used excessively for want
 * of a better name; it basically means understand/process.
 *
 * ## Various Notes:
 *
 * ### Attributes of Note (Under "a")
 *
 * - "extent":
 *   - "e"/"s": Presumably start/end
 *     - "data"
 *     - "frame"
 *     - "moment"
 *     - "node"
 *     - "tuid"
 * - "derefable": documented, seems to just be a marker.
 **/


/**
 * Maintains a contextual stack for collecting hierarchical information that
 * isn't a direct outgrowth of processing the PML object tree.  Also provides
 * PML related helpers that can provide better debug output if they know their
 * exact position in the PML tree.
 *
 * ## Hierarchical Data Collection
 *
 * Actually, maybe this isn't needed.  I think it ends up that the object pretty
 * printer provider effectively redundantly provides the hierarchy information
 * as it descends the type hierarchy.  As we process down each layer we gain
 * an additional "subrange" producer, with the full ["subrange 2", "subrange 1",
 * "memory"] stack exposed at each depth, but we don't need to process the
 * full nesting at each level and invert it.  Instead, we only need to
 * consider the current "subrange N" at each depth and can depend on the parent
 * level to have defined "subrange N-1".  (Noting that the depth is a synthetic
 * concept, it's not literally in the object graph.)  The only specialization is
 * the base-case where the "subrange" is against the "memory" producer and we
 * want that.  Some base-case specialization may also be needed for the object
 * case since it doesn't look like we have the "memory" producer for the depth=0
 * case, we just redundantly get the data for each depth=1 case?
 */
class GrokContext {
  constructor() {
    this.verbose = false;
  }

  isIdent(pml) {
    return pml && pml.t === "ident";
  }

  isInline(pml) {
    return pml && pml.t === "inline";
  }

  isSoleString(pml) {
    if (!pml || !pml.c) {
      return false;
    }
    return (pml.c.length === 1 && typeof(pml.c[0]) === "string");
  }

  isArraySubscripting(pml) {
    return pml.c.length === 2 && typeof(pml.c[1]) === "string" &&
      /\[\d+\]/.test(pml.c[1]);
  }

  /**
   * Checks if a given attribute exists and has the given value, keeping in mind
   * that most (meta)data lives under the `data` attribute and other attributes
   * are pretty much all just presentational in nature.
   */
  hasAttr(pml, key, value) {
    if (!pml || !pml.a) {
      return false;
    }

    return pml.a[key] === value;
  }

  /**
   * Return true if the PML node seems to have 2 object nodes with the provided
   * string literal between them serving as a splitting delimiter.
   */
  hasPairDelim(pml, delim) {
    if (!pml || !pml.c) {
      return false;
    }
    if (pml.c.length !== 3) {
      return false;
    }

    return pml.c[1] === delim;
  }

  /**
   * If the PML shape is [left, delim, right] where delim is a token, return
   * the delimiting token.  Otherwise return null;
   */
  getPairDelim(pml) {
    if (!pml || !pml.c) {
      return null;
    }
    if (pml.c.length !== 3) {
      return null;
    }

    const delim = pml.c[1];

    if (typeof(delim) !== "string") {
      return null;
    }

    return delim;
  }

  /**
   * Assuming a single string child, return it.  `getFlattenedString` should be
   * used for cases where there may be multiple strings that should be
   * concatenated.  This can happen, for example, with namespace prefixes that
   * are elided off with a {elided:null} attribute dict.
   */
  getSoleString(pml) {
    if (!pml || !pml.c) {
      return null;
    }
    if (pml.c.length !== 1 || typeof(pml.c[0]) !== "string") {
      console.warn("Expected sole string", pml);
    }
    return pml.c[0];
  }


  getFlattenedString(pml) {
    if (!pml || !pml.c) {
      return null;
    }
    const parts = pml.c.map((kid) => {
      if (typeof(kid) === "string") {
        return kid;
      } else if (typeof(kid) === "object" && kid.c) {
        return this.getFlattenedString(kid);
      } else {
        console.warn("Problem flattening string node", kid, "in", pml);
        return "";
      }
    });
    return parts.join('');
  }

  /**
   * Return true if the PML node has the given first and last literal children.
   */
  hasWrappingDelims(pml, opens, closes) {
    if (!pml || !pml.c) {
      return false;
    }

    const firstChild = pml.c[0];
    const lastChild = pml.c[pml.c.length - 1];

    return (firstChild === opens) && (lastChild === closes);
  }

  runGrokkerOnNode(grokker, node) {
    const result = grokker(node, this);
    if (this.verbose) {
      console.log("Got", result, "from grokker", grokker, "on", node);
    }
    return result;
  }

  /**
   * Processing helper to handle very simple state machine for processing a
   * single PML node where there's effectively a trivial grammar going on where
   * there are delimiting text nodes that unambigiously indicate a repetition
   * (comma) or a transition to a different rule via some other delimiting
   * character.
   */
  parsify(pml, allHandlers) {
    let resultObj = {};

    let iHandler = 0;
    let curValue = null;
    let handlerProcessed = 0;
    let expectingHandlerDelim = false;

    const advanceHandler = () => {
      iHandler++;
      curValue = null;
      handlerProcessed = 0;
      expectingHandlerDelim = false;
    };
    if (this.verbose) {
      console.log("parsifying node", pml);
    }
    for (let node of pml.c) {
      let handler = allHandlers[iHandler];
      let nextHandler;
      if (iHandler + 1 < allHandlers.length) {
        nextHandler = allHandlers[iHandler + 1];
      }
      if (this.verbose) {
        console.log("considering", typeof(node), node, "with", handler, "and next", nextHandler);
      }
      // ## Is this PML node a string?
      if (typeof(node) === "string") {
        // normalize off any whitespace.
        node = node.trim();

        // It is a string, so then it's a question of whether this is:
        // - The current handler which is a string token, and we should consume
        //   and advance.
        if (handler === node) {
          advanceHandler();
          continue;
        }

        // - The next handler is a delimiter and we're seeing that, so we should
        //   stop processing this current handler and also consume the next
        //   handler with this node.
        if (nextHandler && nextHandler === node) {
          // Assert that the current handler was capable of repetition.
          if (!handler.repeatDelim) {
            console.warn(
              "Current handler", handler, "didn't have repeatDelim but we saw",
              "and are consuming the next node.", allHandlers);
          }
          // Done with the current handler.
          advanceHandler();
          // And done with the next handler.
          advanceHandler();
          continue;
        }

        // - The (already-used once) current handler's `repeatDelim` delimiter
        //   which is expecting a delimiter and so we should next expect to
        //   fire the handler for the next node.
        if (expectingHandlerDelim) {
          if (handler.repeatDelim === node) {
            expectingHandlerDelim = false;
            continue;
          }
        }

        console.error(
          `Found unexpected delimiter ${node} for`, iHandler, 'in',
          allHandlers, `(was expecting?: ${expectingHandlerDelim})`, pml);
        break;
      }

      // ## It's something fancier!
      if (expectingHandlerDelim) {
        console.warn(
          "Was expecting some kind of delimiter but got", node, "in",
          allHandlers);
        break;
      }

      if (handler.repeatDelim) {
        if (handlerProcessed === 0) {
          curValue = resultObj[handler.name] = [];
        }
        curValue.push(this.runGrokkerOnNode(handler.grokker, node));
        // We don't advance but we do mark that we processed something and are
        // now expecting a delimiter.
        handlerProcessed++;
        expectingHandlerDelim = true;
      } else {
        // If the thing can't recur, advance.
        resultObj[handler.name] = this.runGrokkerOnNode(handler.grokker, node);
        advanceHandler();
      }
    }

    return resultObj;
  }

  /**
   * Variant on `parsify` that expects the pml node it is handed is t="inline"
   * with only
   */
  unwrapAndParsify(pml, wrapper, allHandlers) {
    if (!pml || !pml.c) {
      console.warn("unwrapAndParsify: No children", pml);
      return null;
    }
    if (pml.t !== "inline") {
      console.warn("unwrapAndParsify: Not inline", pml);
      return null;
    }
    if (pml.c.length !== 3) {
      console.warn("unwrapAndParsify: Expected 3 children:", pml);
      return null;
    }

    const firstChild = pml.c[0];
    // (Although we assert 3 children, try not to hardcode that too much...)
    const lastChild = pml.c[pml.c.length - 1];

    if (firstChild !== wrapper.opens || lastChild !== wrapper.closes) {
      console.warn("Exepcted wrapper", wrapper, "but got PML node", pml);
      return null;
    }

    const kid = pml.c[1];

    // There are situations related to objects where we keep running into
    // wrappers, so just keep unwrapping until we run out of the wrapper.
    if (this.hasWrappingDelims(kid, wrapper.opens, wrapper.closes)) {
      return this.unwrapAndParsify(kid, wrapper, allHandlers);
    } else {
      return this.parsify(kid, allHandlers);
    }
  }
}

/**
 * The producer is an object with a single key which is one of:
 * - "dwarfVariable"
 * - "subrange"
 * - "memory"
 * - "dereference"
 * - "returnValue"
 * - "literal": Corresponds to things like $pid and $tid
 */
function grokProducer(val, ctx) {
  let grokker, subval;
  if (val.dwarfVariable) {
    return ctx.runGrokkerOnNode(grokProducerDwarfVariable, val.dwarfVariable);
  } else if (val.subrange) {
    return ctx.runGrokkerOnNode(grokProducerSubrange, val.subrange);
  } else if (val.memory) {
    return ctx.runGrokkerOnNode(grokProducerMemory, val.memory);
  } else if (val.dereference) {
    return ctx.runGrokkerOnNode(grokProducerDereference, val.dereference);
  } else if (val.returnValue) {
    return ctx.runGrokkerOnNode(grokProducerReturnValue, val.returnValue);
  } else if (val.literal) {
    return ctx.runGrokkerOnNode(grokProducerLiteral, val.literal);
  } else {
    console.warn("Unable to find appropriate producer grokker", val);
    return null;
  }
}

/**
 * Object with keys:
 * - "addressSpace": { execs, task: { serial, tid } }
 * - "function":
 *   - "addressSpaceUid": { execs, task: { serial, tid } }
 *   - "anyMoment": { event, instr }
 *   - "entryMoment": { event, instr }
 *   - "subprogram": { baseAddres, binary, subprogram: { f, o }, taskUid: { serial, tid } }
 * - "task" : { serial, tid }
 * - "variable": { baseAddress, binary, unit, variable: { f, o } }
 */
function grokProducerDwarfVariable(val, ctx) {
  // XXX stub
  return 'dwarfVariable';
}

/**
 * The "subrange" producer consists of an object with 3 keys:
 * - "name": The field name
 * - "producer": The parent's producer, walking back towards the root from a
 *   leaf.  For a field this is the type that the field lives on.  For a
 *   type "Base" that is subclassed by "Subclass" and where "Base" had a field
 *   on it, the field's parent is "Base" and its parent is then "Subclass"
 *   (because we're moving back towards the root as we go).
 * - "subrange": An object containing { start, end } (although in the opposite
 *   order), which seems to be the [start, end] of the data in the parent type.
 */
function grokProducerSubrange(val, ctx) {
  // XXX stub
  return 'subrange';
}

/**
 * The "memory" producer consists of an object with 3 keys:
 * - "addressSpace": { execs, task: { serial, tid } }
 * - "padWithUnmapped": some kind of alignment and zero-filling?
 * - "ranges": an array of { start, end } where start/end appear to be
 *   absolute memory addresses.  (Compared with "subrange" values which always
 *   seem to be relative to the parent producer.)
 */
function grokProducerMemory(val, ctx) {
  // XXX stub
  return 'memory';
}

/**
 * Corresponds to a pointer having been traversed/dereferenced.  Keys:
 * - "bytes":
 * - "derefs": Seems to be the number of pointers traversed to get to memory to
 *   pretty print it.
 * - "offset":
 * - "producer": The parent's producer.
 */
function grokProducerDereference(val, ctx) {
  return 'dereference';
}

function grokProducerReturnValue(val, ctx) {
  return 'returnValue';
}

/**
 * Keys:
 * - "addressSpaceUid": { execs, task: { serial, tid } }
 * - "bytes": This seems to be an array of uint8's.  For the value 12717 the
 *   array has 0th entry 173 (12717 & 0xff) and 1st entry 49 (12717 >> 8).
 */
function grokProducerLiteral(val, ctx) {
  return 'literal';
}

/**
 * TODO: Does this want to somehow have its result used when interpreting the
 * actual value?
 *
 * Known types:
 * - "utf8" literal
 * - "bigInt" literal
 * - "dwarfType"
 * - "pointer"
 */
function grokRenderer(val, ctx) {
  if (val === "utf8") {
    return 'utf8';
  } else if (val === "bigInt") {
    return 'bigInt';
  } else if (val.dwarfType) {
    return grokRendererDwarfType(val.dwarfType, ctx);
  } else if (val.pointer) {
    return grokRendererPointer(val.pointer, ctx);
  } else {
    console.warn("Unable to find appropriate renderer grokker", val);
    return null;
  }
}

/**
 * Keys:
 * - "deref": { level: number }
 *   - Mainly seeing level of 0 and 1, with this seeming to correspond to the
 *     number of pointers that were dereferenced (based on the existence and
 *     implied semantics of the "dereference" producer).
 * - "type_": { baseAddress, binary, type: { f: "m", o: number }, unit }
 */
function grokRendererDwarfType(val, ctx) {
  // XXX stub
  return 'dwarfType';
}

/**
 * This is just a number that's the size of the pointer and produces the hex
 * encoding of the pointer.
 */
function grokRendererPointer(val, ctx) {
  // XXX stub
  return 'pointer';
}

/**
 * Object representations look like ["{", [[name, "=", value], ",", ...], "}"].
 *
 * There also appear to be variations for classes where the superclasses get
 * wrapped in extra layers of braces.
 */
function grokObject(pml, ctx) {
  return ctx.unwrapAndParsify(
    pml,
    {
      opens: "{",
      closes: "}",
    },
    [
      {
        name: "values",
        grokker: grokObjectKeyAndValue,
        repeatDelim: ","
      }
    ]);
}

function grokObjectKeyAndValue(pml, ctx) {
  // TODO: This direct re-delegation maybe shouldn't be bypassing the ctx?

  // It seems like objects can also have nested objects, presumably due to
  // superclass fields.  So if that's the case, just call grokObject again.
  if (ctx.hasWrappingDelims(pml, "{", "}")) {
    return grokObject(pml, ctx);
  }

  // TODO: maybe this wants more special handling than the function logic
  return grokFunctionArg(pml, ctx);
}

function grokValue(pml, ctx) {
  let data;
  if (pml.t === "number") {
    // Numbers should be included directly
    data = ctx.getSoleString(pml);
  } else if (pml.t === "inline") {
    // String values seem to end up as a t=inline with 3 children: [`"`,
    // t=str c=["ACTUAL STRING"], `"`].
    if (ctx.hasWrappingDelims(pml, '"', '"') && pml.c[1].t === "str") {
      // There should probably only be a sole string, but handle weirdness.
      data = ctx.getFlattenedString(pml.c[1]);
    }
  } else if (pml.t === "ident") {
    data = ctx.getFlattenedString(pml);
  }

  let producer;
  let renderer;
  if (pml.a && pml.a.data) {
    producer = ctx.runGrokkerOnNode(grokProducer, pml.a.data.producer);
    renderer = ctx.runGrokkerOnNode(grokRenderer, pml.a.data.renderer);
  }

  return {
    data,
    //producer,
    //renderer,
  };
}

/**
 * Process the results of an "executions of" "print" arg results.
 */
function grokPrinted(pml, ctx) {
  return grokValue(pml, ctx);
}

function grokIdent(pml, ctx) {
  const name = ctx.getFlattenedString(pml);

  // There's other information in here, but it's not particularly useful yet.
  return {
    name
  };
}

/**
 * Compound identifiers end up as a left-recursive tree until we get an inline
 * of the form [t=ident, ".", t=ident] where the attr on the containing parent
 * is providing data about the right ident.  This info also provides information
 * about the parent which is the left by way of the "subrange" identifying it.
 *
 * For now we flatten everything to a single string, joining all names.
 */
function grokCompoundIdent(pml, ctx) {
  // Handle this actually being a simple ident.  We're t=inline if complex.
  if (ctx.isIdent(pml)) {
    return ctx.runGrokkerOnNode(grokIdent, pml);
  }

  function processIdent(piecePml) {
    if (ctx.isIdent(piecePml)) {
      return ctx.runGrokkerOnNode(grokIdent, piecePml);
    } else {
      return ctx.runGrokkerOnNode(grokCompoundIdent, piecePml);
    }
  }

  if (ctx.hasPairDelim(pml, ".")) {
    let left = processIdent(pml.c[0]);
    let right = processIdent(pml.c[2]);

    const name = left.name + "." + right.name;

    // There's other information in here, but it's not particularly useful yet.
    return {
      name
    };
  }

  console.warn("Unknown compound ident format", pml);
  return null;
}

/**
 * This is either a t=ident, a t=inline with [t=ident, "@", t=number], or a
 * further t=inline variant array variant [[t=ident, "@", t=number], "[0]"]
 */
function grokFunctionArgName(pml, ctx) {
  // ## Simple Case: Just an ident
  if (ctx.isIdent(pml)) {
    return {
      ident: ctx.runGrokkerOnNode(grokIdent, pml),
      value: undefined,
    };
  }

  // ## Simple case: single-string inline, ex for "<anon>"
  if (ctx.isInline(pml) && ctx.isSoleString(pml)) {
    return {
      ident: {
        // XXX since this is probably "<anon>" should this just be an undefined
        // name?
        name: ctx.getSoleString(pml),
      },
      value: undefined,
    };
  }

  // ## "." delimited indicating a compound ident
  if (ctx.isInline(pml) && ctx.hasPairDelim(pml, ".")) {
    return {
      ident: ctx.runGrokkerOnNode(grokCompoundIdent, pml),
      value: undefined,
    };
  }

  if (ctx.isInline(pml) && ctx.hasPairDelim(pml, "@")) {
    return {
      // This could be a simple ident or ?maybe? a compound ident
      ident: ctx.runGrokkerOnNode(grokCompoundIdent, pml.c[0]),
      value: ctx.runGrokkerOnNode(grokValue, pml.c[2]),
    };
  }

  // This is the array-subscripted situation.
  if (ctx.isArraySubscripting(pml) && ctx.hasPairDelim(pml.c[0], "@")) {
    const wrapped = pml.c[0];
    let ident = ctx.runGrokkerOnNode(grokCompoundIdent, wrapped.c[0]);
    ident.subscript = pml.c[1];
    return {
      // This could be a simple ident or ?maybe? a compound ident
      ident,
      value: ctx.runGrokkerOnNode(grokValue, wrapped.c[2]),
    };
  }

  console.warn("Unknown function argument name format", pml);
  return null;
}

/**
 * This is either an optimized-out special case, or a t=inline object (which
 * is the result of pretty printing magic), or a t=number/other value (which
 * didn't get pretty printed).
 */
function grokFunctionArgValue(pml, ctx) {
  if (ctx.hasAttr(pml, "domClass", "optimizedOut")) {
    return {
      value: undefined,
      pretty: undefined,
    };
  }

  if (ctx.hasWrappingDelims(pml, "{", "}")) {
    return {
      value: undefined,
      pretty: ctx.runGrokkerOnNode(grokObject, pml),
    };
  }

  return {
    value: ctx.runGrokkerOnNode(grokValue, pml),
    pretty: undefined,
  };
}

/**
 * Function arguments will take the form of [left, "=", right] if debug info
 * was able to provide a value and [left, ":", right] when "optimized out".
 *
 * In the simplest case, the left will be a t="ident" with producer/renderer
 * data and the right will be a t="number" with a producer/renderer that's
 * something like a pointer.
 *
 * In more complex cases where the right-hand side is an object and pernosco
 * has enough info to pretty print that, both of those things get folded into
 * the left like [[t=ident, "@", t=number], "=", OBJ]
 */
function grokFunctionArg(pml, ctx) {
  const delim = ctx.getPairDelim(pml);
  if (!delim) {
    return null;
  }

  const left = pml.c[0];
  const right = pml.c[2];

  // Because of the complex situation where the name can end up including the
  // memory location of the object-printed right, we need to post-process the
  // results of the more straightforward grokking.
  const namish = ctx.runGrokkerOnNode(grokFunctionArgName, left);
  const valueish = ctx.runGrokkerOnNode(grokFunctionArgValue, right);

  return {
    ident: namish.ident,
    value: namish.value || valueish.value,
    pretty: valueish.pretty,
  };
}

function grokItemTypeFunction(pml, ctx) {
  const result = ctx.parsify(
    pml,
    [
      {
        name: "func",
        grokker: grokIdent,
      },
      "(",
      {
        name: "args",
        grokker: grokFunctionArg,
        repeatDelim: ",",
      },
      ")",
      "=",
      {
        name: "rval",
        grokker: grokValue
      }
    ]);

  const focusInfo = pml.a.focus;
  result.meta = {
    pid: focusInfo.frame.addressSpaceUid.task.tid,
    tid: focusInfo.tuid.tid,
    entryMoment: focusInfo.frame.entryMoment,
    returnMoment: focusInfo.frame.returnMoment,
  };

  return result;
}

const PRINT_DELIM_ARROW = "→";

/**
 * Process root PML nodes which we expect to be blocks that hold an inline
 * result whose attributes describes what we're seeing.
 *
 * TODO: Things will get more complicated when print expressions get involved.
 */
function grokRootPML(pml, mode, results) {
  const ctx = new GrokContext();

  if (mode === "evaluate") {
    let result;
    result = ctx.runGrokkerOnNode(grokFunctionArg, pml);
    results.push(result);
    return
  }

  if (pml.t !== "block") {
    console.warn("Unexpected root PML type", pml.t, pml);
    return;
  }
  if (!pml.c) {
    console.warn("Root PML has no children?", pml);
    return;
  }
  if (pml.c.length !== 1) {
    console.warn("Root PML has more than 1 child?", pml);
    return;
  }

  // At this point, we expect to either have a single child with an
  // "itemTypeName" attribute OR we expect for it to be wrapped in an inline
  // that has "→" as a delimiter separating print values from that child.
  let topPml = pml.c[0];
  let canonChild = topPml;
  let printWrapped = false;

  if (!canonChild.a &&
      canonChild.c && canonChild.c.length && canonChild.c[0].a &&
      canonChild.c[0].a.itemTypeName) {
    if (canonChild.c[1].trim() !== PRINT_DELIM_ARROW) {
      console.warn("Result is not print-wrapped but should be?", pml);
      return;
    }

    // For assertion purposes, we want to use this as our new canonChild, but
    // we want to leave topPml the same as that's the basis of our printWrapped
    // processing.
    canonChild = canonChild.c[0];
    printWrapped = true;
  }

  if (canonChild.t !== "inline") {
    console.warn("Canonical child is not inline", canonChild.t, canonChild);
    return;
  }
  if (!canonChild.a) {
    console.warn("Canonical child has no attributes?", canonChild);
    return;
  }
  if (!canonChild.a.itemTypeName) {
    console.warn("Canonical child has no itemTypeName?", canonChild.a, canonChild);
    return;
  }

  let canonGrokker;
  switch (canonChild.a.itemTypeName) {
    case "function": {
      canonGrokker = grokItemTypeFunction;
      break;
    }

    default: {
      console.warn("No grokker for", canonChild.a.itemTypeName);
      return;
    }
  }

  let result;
  if (printWrapped) {
    result = ctx.parsify(
      topPml,
      [
        {
          name: "queried",
          grokker: canonGrokker,
        },
        PRINT_DELIM_ARROW,
        {
          name: "printed",
          grokker: grokPrinted,
          repeatDelim: ",",
        },
      ]);
  } else {
    result = ctx.runGrokkerOnNode(grokItemTypeFunction, canonChild);
  }

  results.push(result);
}

export function grokPML(pml, mode) {
  const results = [];
  grokRootPML(pml, mode, results);
  return results[0];
}

export function grokPMLRows(rows, mode) {
  const results = [];
  for (const row of rows) {
    if (row.items) {
      for (const item of row.items) {
        if (item.pml) {
          grokRootPML(item.pml, mode, results);
        }
      }
    }
  }
  return results;
}

export function renderGrokkedInto(grokked, elem) {
}