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
 * Magic value for grokkers to indicate no content.
 */
const GROKKED_OMIT = {};

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
 *
 * ## containerId and parent values
 *
 * A neat trick of the PML representation is that content can be filled into
 * place later through use of a "containerId" attribute on PML nodes, which
 * then is provided on an item with a "parent" value matching the containerId.
 * This seems to be used with "elided" which results in expandible ellipsis
 * which avoids visual churn as the data is asynchronously filled in.
 *
 * For simplicity of implementation, it is assumed that we will have normalized
 * the PML by first walking all items with a "parent" and saving them in a map,
 * then we walk through all non-parented nodes looking for containerId
 * attributes and applying those fixes.
 *
 * Note that the "elided" annotation is orthogonal to this; it can be used
 * independently from use of "containerId".  For example, "stack" uses it to
 * hide the namespaces which are included directly.
 */
class GrokContext {
  constructor() {
    this.verbose = false;
    this.stack = [];
    this.blackboard = {};
  }

  isIdent(pml) {
    return pml && pml.t === "ident";
  }

  isInline(pml) {
    return pml && pml.t === "inline";
  }

  // True if there's a single child that's a string
  isSoleString(pml) {
    if (!pml || !pml.c) {
      return false;
    }
    return (pml.c.length === 1 && typeof(pml.c[0]) === "string");
  }

  // True if there are only 2 children and they're both strings.  This can
  // happen in situations where a raw pointer address is being dereferenced
  // (or rather that's how it's being presented).
  isDoubleString(pml) {
    if (!pml || !pml.c) {
      return false;
    }
    return pml.c.length === 2 &&
           typeof(pml.c[0]) === "string" &&
           typeof(pml.c[1]) === "string";
  }

  hasSoleChildOfType(pml, childType) {
    if (!pml || !pml.c) {
      return false;
    }
    return (pml.c.length === 1 && pml.c[0]?.t === childType);
  }

  firstChildIsStringAndStartsWith(pml, prefix) {
    if (!pml || !pml.c || pml.c.length === 0) {
      return false;
    }
    // Okay, so we have at least one child.
    const firstChild = pml.c[0];
    if (firstChild?.t === "str" && firstChild?.c?.length) {
      return firstChild.c[0].startsWith(prefix);
    }
    // should we handle there just being a raw string in here?
    return false;
  }

  pickFirstChildOfType(pml, childType) {
    if (!pml || !pml.c) {
      return null;
    }
    for (const child of pml.c) {
      if (child?.t === childType) {
        return child;
      }
    }
    return null;
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
   * Helper to check if we're looking at a t=inline that is a delimited list.
   * This will return false on the ambiguous case where it could be a single
   * entry list.  However, in this case, the caller may not care as long as the
   * extra layer of wrapping doesn't pose a problem.
   */
  seemsDelimitedWith(pml, delim, allowRepeatedDelim) {
    if (!pml || pml.t !== "inline" || !pml.c || pml.c.length < 3) {
      return false;
    }
    if (allowRepeatedDelim) {
      // We assume that there needs to be some content for the first node, so
      // we skip it and then scan.  We require any strings we see to be the
      // (possibly whitespace-padded) delimiter, and that if we see an actual
      // non-delimiter, that it has to be followed by a delimiter.
      let nonStringAllowed = false;
      for (let i = 1; i < pml.length; i++) {
        let node = pml.c[i];
        if (typeof(node) === "string") {
          if (node.trim() !== delim) {
            return false;
          }
          nonStringAllowed = true;
        } else if (nonStringAllowed) {
          nonStringAllowed = false;
        } else {
          return false;
        }
      }
    } else {
      for (let i = 1; i < pml.length; i += 2) {
        if (pml.c[i]?.trim() !== delim) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Return true if the PML node seems to have 2 object nodes with the provided
   * string literal between them serving as a splitting delimiter.  Note that
   * there's now a case for "=" delimited things where they may be structured
   * as [[left, "="], right], in which case `hasPairDelimShapes` is the thing to
   * use.
   */
  hasPairDelim(pml, delim) {
    if (!pml || !pml.c) {
      return false;
    }
    if (pml.c.length !== 3) {
      return false;
    }

    return pml.c[1]?.trim() === delim;
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
   * Check if `splitPairDelimShapes` would succeed.
   */
  hasPairDelimShapes(pml, delim=null) {
    const info = this.splitPairDelimShapes(pml, delim);
    return info ? info.delim !== null : false;
  }

  /**
   * Given a [left, delim, right] or [[left, delim], right] shape, return
   * { left, delim, right } with non-null values on match and null values on
   * non-match.
   */
  splitPairDelimShapes(pml, delim=null) {
    const result = {
      left: null,
      delim: null,
      right: null,
    };
    if (!pml || !pml.c) {
      return result;
    }
    if (pml.c.length === 3) {
      if (typeof(pml.c[1]) !== "string" ||
          (delim && pml.c[1]?.trim() !== delim)) {
        return result;
      }
      result.left = pml.c[0];
      result.delim = pml.c[1];
      result.right = pml.c[2];
      return result;
    }
    if (pml.c.length !== 2 ||
        pml.c[0].t !== "inline" ||
        pml.c[0].c?.length !== 2 ||
        typeof(pml.c[0].c?.[1]) !== "string" ||
        (delim && pml.c[0].c?.[1]?.trim() !== delim)) {
      return result;
    }
    result.left = pml.c[0].c[0];
    result.delim = pml.c[0].c[1];
    result.right = pml.c[1];
    return result;
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
      this.warn("Expected sole string", pml);
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
        this.warn("Problem flattening string node", kid, "in", pml);
        return "";
      }
    });
    return parts.join('');
  }

  /**
   * For cases like the process argument list where the actual data is t=str
   * interleaved with t=inline whitespace, normalize into an array whose items
   * are the (flattened) payloads of the t=str nodes, with the t=inline nodes
   * ignored.  parsify is overkill for this, but if this seems too limited, you
   * probably want parsify.
   */
  pickAndExtractStrings(pml) {
    return pml.c.filter(x => x.t === "str").map(x => this.getFlattenedString(x));
  }

  /**
   * Return true if the PML node has the given first and last literal children.
   */
  hasWrappingDelims(pml, opens, closes) {
    if (!pml || !pml.c || pml.c.length < 2) {
      return false;
    }

    const firstChild = pml.c[0];
    const lastChild = pml.c[pml.c.length - 1];

    return (firstChild === opens) && (lastChild === closes);
  }

  runGrokkerOnNode(grokker, node, position=undefined) {
    if (!grokker) {
      this.warn("Attempting to use falsey grokker", grokker, "on node", node);
      return {};
    }
    this.stack.push({ grokker, node, position });
    let result;
    try {
      result = grokker(node, this);
      if (this.verbose) {
        this.log("Got", result, "from grokker", grokker, "on", node);
      }
    } catch (ex) {
      this.error("Exception", ex, "from grokker", grokker, "on", node);
      // re-throw; no point hiding this.
      throw ex;
    }
    this.stack.pop();
    return result;
  }

  log(...args) {
    console.log(...args);
  }

  error(...args) {
    console.error(...args, 'contextStack: ', this.stack.concat());
  }

  warn(...args) {
    console.warn(...args, 'contextStack: ', this.stack.concat());
  }

  /**
   * Processing helper to handle very simple state machine for processing a
   * single PML node where there's effectively a trivial grammar going on where
   * there are delimiting text nodes that unambigiously indicate a repetition
   * (comma) or a transition to a different rule via some other delimiting
   * character.
   *
   * This method does NOT require that it fully consume the list of handlers
   * before running out of tokens!  So, for example, in a function call where
   * there could optionally be a return value delimited by a "=" followed by
   * a value after the closing ")", we don't actually ever need to see the "=".
   */
  parsify(pml, allHandlers) {
    this.stack.push({ parsify: allHandlers, node: pml });
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
      this.log("parsifying node", pml);
    }
    // duplicate the list of children so that we can flatten nodes like argument
    // lists which now seem to get wrapped into their own t=inline container.
    const children = pml.c.concat();
    let node = null, iNode;
    const flattenCurrentNode = () => {
      // We replace the current node with its children.
      children.splice(iNode, 1, ...node.c);
      node = children[iNode];
    }
    for (iNode = 0; iNode < children.length; iNode++) {
      node = children[iNode];
      let handler = allHandlers[iHandler];
      let nextHandler;
      if (iHandler + 1 < allHandlers.length) {
        nextHandler = allHandlers[iHandler + 1];
      }
      if (this.verbose) {
        this.log("considering", typeof(node), node, "with", handler, "and next", nextHandler);
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
            this.warn(
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
        // - Introducing `allowRepeatedDelim` because of a weird case where we
        //   seem to sometimes see multiple commas at deep nesting levels,
        //   presumably due to some depth-limiting heuristic?
        if (expectingHandlerDelim || handler.allowRepeatedDelim) {
          if (handler.repeatDelim === node) {
            expectingHandlerDelim = false;
            continue;
          }

          // There's also an ellipsis possibility if this is the last element.
          // The container should probably have "collapsible" on it in this case
          // although it's not clear there's a benefit to checking.
          if (iNode === (children.length - 1) &&
              node === `${handler.repeatDelim} …`) {
            expectingHandlerDelim = false;
            continue;
          }
        }

        this.error(
          `Found unexpected delimiter ${node} [${iNode}] for`, iHandler, 'in',
          allHandlers, `(was expecting?: ${expectingHandlerDelim})`, pml);
        break;
      }

      // ## It's something fancier!
      if (expectingHandlerDelim) {
        this.warn(
          "Was expecting some kind of delimiter but got", node, "in",
          allHandlers, "at index", iNode, "of", children);
        break;
      }

      if (handler.repeatDelim) {
        if (handlerProcessed === 0) {
          curValue = resultObj[handler.name] = [];
          if (handler.alwaysFlatten && this.isInline(node)) {
            flattenCurrentNode();
          }
          // Flatten the child node into our current traversal if it looks like
          // the contents that previously would have been flattened have been
          // instead placed into their own t=inline that includes the delimiter.
          else if (handler.maybeFlatten &&
              this.seemsDelimitedWith(node, handler.repeatDelim,
                                      handler.allowRepeatedDelim)) {
            flattenCurrentNode();
          }
        }

        const grokkedValue = this.runGrokkerOnNode(handler.grokker, node, `${handler.name}@${iNode}`);
        if (grokkedValue !== GROKKED_OMIT) {
          curValue.push(grokkedValue);
        }

        // We don't advance but we do mark that we processed something and are
        // now expecting a delimiter.
        handlerProcessed++;
        expectingHandlerDelim = true;
      } else {
        // If the thing can't recur, advance.
        const grokkedValue = this.runGrokkerOnNode(handler.grokker, node, `${handler.name}@${iNode}`);
        if (grokkedValue !== GROKKED_OMIT) {
          resultObj[handler.name] = grokkedValue;
        }
        advanceHandler();
      }
    }

    this.stack.pop();
    return resultObj;
  }

  /**
   * Variant on `parsify` that expects the pml node it is handed is t="inline"
   * with a single content child that's wrapped with the specified wrapper.
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
    // XXX this may now be handled by `grokObjectKeyAndValue`?
    if (this.hasWrappingDelims(kid, wrapper.opens, wrapper.closes)) {
      return this.unwrapAndParsify(kid, wrapper, allHandlers);
    }
    // We can end up in a situation like objects where there's only a single
    // entry in the list and the comma-delimited list is elided.  In that case,
    // when the wrapper config indicates it, we can directly pierce to only
    // invoke the (single handler).
    else if (wrapper.pierceIfDelimIs &&
             this.hasPairDelimShapes(kid, wrapper.pierceIfDelimIs) &&
             allHandlers.length === 1) {
      const handler = allHandlers[0];
      const soleValue = this.runGrokkerOnNode(handler.grokker, kid, "pierced");
      return {
        [handler.name]: [soleValue]
      };
    } else {
      return this.parsify(kid, allHandlers);
    }
  }
}

/**
 * Normalize a tuid into a string so that we can use it for key purposes.
 */
function normTuid(tuid) {
  return `${tuid.serial}-${tuid.tid}`;
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
    return ctx.runGrokkerOnNode(grokProducerDwarfVariable, val.dwarfVariable, "dwarfVariable");
  } else if (val.subrange) {
    return ctx.runGrokkerOnNode(grokProducerSubrange, val.subrange, "subrange");
  } else if (val.memory) {
    return ctx.runGrokkerOnNode(grokProducerMemory, val.memory, "memory");
  } else if (val.dereference) {
    return ctx.runGrokkerOnNode(grokProducerDereference, val.dereference, "dereference");
  } else if (val.returnValue) {
    return ctx.runGrokkerOnNode(grokProducerReturnValue, val.returnValue, "returnValue");
  } else if (val.literal) {
    return ctx.runGrokkerOnNode(grokProducerLiteral, val.literal, "literal");
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
  if (val.producer?.memory?.ranges.length) {
    return {
      address: val.producer.memory.ranges[0].start,
      size: val.producer.memory.ranges[0].end - val.producer.memory.ranges[0].start,
    };
  }
  if (val.producer?.dwarfVariable?.variable) {
    return {
      // we don't have an address, and I think the variable stuff is handles
      // into DWARF debug info or something like that.
      size: val.subrange.end - val.subrange.start,
    }
  }
  return {};
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
  return {
    address: val.ranges[0].start,
    size: val.ranges[0].end - val.ranges[0].start,
  };
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
  // At least in the superclass case, it's possible that if the superclass only
  // has a single attribute, that we won't end up with the comma nesting level
  // and instead will only have the values.

  return ctx.unwrapAndParsify(
    pml,
    {
      opens: "{",
      closes: "}",
      pierceIfDelimIs: "=",
    },
    [
      {
        name: "values",
        grokker: grokObjectKeyAndValue,
        repeatDelim: ",",
        // maybeFlatten seems to actively break things if enabled here.
        allowRepeatedDelim: true,
      }
    ]);
}

function grokObjectKeyAndValue(pml, ctx) {
  // TODO: This direct re-delegation maybe shouldn't be bypassing the ctx?

  // It seems like objects can also have nested objects, presumably due to
  // superclass fields.  So if that's the case, just call grokObject again.
  if (ctx.hasWrappingDelims(pml, "{", "}")) {
    return ctx.runGrokkerOnNode(grokObject, pml, "wrapped");
  }

  // TODO: maybe this wants more special handling than the function logic
  return ctx.runGrokkerOnNode(grokFunctionArg, pml, "not-wrapped");
}

function grokValue(pml, ctx) {
  let data, rawData;
  if (pml.t === "number") {
    // Numbers should be included directly
    data = ctx.getSoleString(pml);
  } else if (pml.t === "inline") {
    // String values seem to end up as a t=inline with 3 children: [`"`,
    // t=str c=["ACTUAL STRING"], `"`].
    if (ctx.hasWrappingDelims(pml, '"', '"') && pml.c[1].t === "str") {
      // There should probably only be a sole string, but handle weirdness.
      data = ctx.getFlattenedString(pml.c[1]);
    } else if (ctx.hasSoleChildOfType(pml, "number")) {
      const numKid = pml.c[0];
      data = ctx.getSoleString(numKid);
      if (numKid?.a?.numberData?.raw) {
        rawData = numKid.a.numberData.raw;
      }
    }
  } else if (pml.t === "ident") {
    data = ctx.getFlattenedString(pml);
  }

  const result = {
    data
  };

  if (rawData !== undefined) {
    result.rawData = rawData;
  }

  if (pml?.a?.data) {
    result.producer = ctx.runGrokkerOnNode(grokProducer, pml.a.data.producer, "producer");
    // renderer is currently useless, so not including it.
    //result.renderer = ctx.runGrokkerOnNode(grokRenderer, pml.a.data.renderer, "renderer");
  }

  if (pml?.a?.dataMoment) {
    result.dataMoment = pml.a.dataMoment;
  }

  return result;
}

/**
 * Process the results of an "executions of" "print" arg results.
 *
 * In simple cases, we expect these to be an inline with "data" and "dataMoment"
 * attributes that wraps an inline that is the actual printable result.
 *
 * But in a more complex case like
 * `aSource->mClientInfo.mData->id_.mVal.ToString()`
 * (for ClientManagerService::AddSource) where we have a complex return type
 * (`nsIDToCString` is an object with `char mStringBytes[NSID_LENGTH];`) we may
 * see an object structure.
 *
 * ### ';'-delimited list of print results
 *
 * Here's the full context, but note that
 *
 * t=block (cyan)
 * - t=inline (red)
 *   - t=inline (yellow) [focus] itemShortHand/itemTypeName
 *     - t=ident (blue)
 *       - t=inline elided
 *         - 'mozilla'
 *       - '::dom::ClientMatchPrincipalInfo'
 *     - '('
 *     - ...
 *     - ')'
 *     - '='
 *     - t=inline (blue) producer/renderer/dataMoment
 *       - t=ident value{}
 *         - 'true'
 *   - '→'
 *   - t=inline (yellow) producer/renderer/dataMoment
 *     - t=inline (blue)
 *       - '{'
 *       - t=inline (green) collapsible
 *         - t=inline (red) producer/renderer/dataMoment
 *           - t=inline (cyan)
 *             - t=ident locationText={}
 *               - 'attrs_' (key name)
 *             - '='
 *           - t=inline (cyan)
 *             - '{'
 *             - t=inline (pink) collapsible=null
 *               - t=inline (yellow) producer/renderer
 *                 - '{'
 *                 - t=inline (blue) producer/renderer/dataMoment
 *                   - t=inline (green)
 *                     - t=ident (red) producer/renderer/dataMoment
 *                       - 'mIsAnyMemberPresent' (key)
 *                     - '='
 *                   - t=inline (green) value={}
 *                     - 'true'
 *                 - '}'
 *               - ','
 *               - t=inline (yellow) producer/renderer/dataMoment
 *                 - t=inline (blue)
 *                   - t=ident (green) locationText={}
 *                     - 'mFirstPartyDomain' (key)
 *                   - '='
 *                 - t=inline (blue) value={}
 *                   - '"'
 *                   - t=str with no children (empty string, but if there were
 *                     it would have a JS string as a child and there would be
 *                     attrs: charBytes="JS chars", charSpec={producer/renderer})
 *                   - '"'
 *         - ','
 *         - t=inline (red) producer/renderer/dataMoment
 *         - (',' t=inline (red) repeats)
 *       - '}'
 *   - ','
 *   - t=inline (yellow) producer/renderer/dataMoment
 *     - (same as above)
 *
 */
function grokPrinted(pml, ctx) {
  // At least in the detailed case above, objects now seem to have an outer
  // t=inline with the dataMoment and then a t=inline inside that which just
  // contains the delimiting.
  let looksObjecty = !ctx.isInline(pml) || pml.c.length !== 1;
  if (!looksObjecty && ctx.hasWrappingDelims(pml.c[0], "{", "}")) {
    looksObjecty = true;
    pml = pml.c[0];
  }
  if (looksObjecty) {
    let asObj = ctx.runGrokkerOnNode(grokObject, pml, "printed");

    if (asObj?.values) {
      if (asObj.values.length === 1) {
        return asObj.values[0];
      }

      return asObj;
    }

    return "weird print";
  }

  const producer = pml.a.data && pml.a.data.producer;
  const producerSubrange = producer && producer.subrange;

  return {
    name: producerSubrange ? producerSubrange.name : "???",
    value: ctx.runGrokkerOnNode(grokValue, pml.c[0], "printed"),
  };
}

// Stack frames have a useless human readable description that looks like this:
// - t=inline
//   - " at "
//   - t=inline
//     - t=ident a={title="full original source path"}
//       - "FilenameOnly.ext"
//     - ":NUMBER"
//
// We just ignore its contents because the parent inline node includes the
// information in a more useful form in its "source" attribute.
function grokStackAtSourceFileAndLine(pml, ctx) {
  return GROKKED_OMIT;
}

function grokSourceLineNumber(pml, ctx) {
  return {
    source: pml.a.source,
  };
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
    return ctx.runGrokkerOnNode(grokIdent, pml, "ident");
  }

  function processIdent(piecePml) {
    if (ctx.isIdent(piecePml)) {
      return ctx.runGrokkerOnNode(grokIdent, piecePml, "ident-simple");
    } else {
      return ctx.runGrokkerOnNode(grokCompoundIdent, piecePml, "ident-compound");
    }
  }

  if (ctx.hasPairDelim(pml, ".")) {
    let left = processIdent(pml.c[0]);
    let right = processIdent(pml.c[2]);

    const name = left.name + "." + right.name;

    // There's other information in here, but it's not particularly useful yet.
    const ret = {
      name
    };
    // If the left part had a value, expose that.
    if (left.value) {
      ret.rootValue = left.value;
    }
    return ret;
  }

  if (ctx.hasPairDelim(pml, "@")) {
    // We expect this nesting to happen in the case where we're piercing a
    // (smart?) pointer and including the pointer's value as well as the
    // contents of what the pointer is referring to.  So we expose this as a
    // name with a value.
    //
    // It's possible this case should actually be handled by grokFunctionArgName
    // more directly.
    let left = processIdent(pml.c[0]);
    let right = ctx.runGrokkerOnNode(grokValue, pml.c[2], "@right");

    return {
      name: left.name,
      value: right,
    };
  }

  if (ctx.isArraySubscripting(pml)) {
    // We just generally recurse for this.
    const wrapped = pml.c[0];
    const subscripted = ctx.runGrokkerOnNode(grokCompoundIdent, wrapped, "subscripted");
    subscripted.subscript = pml.c[1];
    return subscripted;
  }

  console.warn("Unknown compound ident format", pml);
  return null;
}

/**
 * There's weird overlap with `grokCompoundIdent` here.
 *
 * Many options:
 * - t=ident
 * - t=inline with [t=ident, "@", t=number]
 * - t=inline variant array variant [[t=ident, "@", t=number], "[0]"]
 * - Fancy simple struct expansion:
 *   `aCreationTimestamp@0x621019ec2458.mValue={mUsedCanonicalNow=0, mTimeStamp=1216622902540}`
 *   - t=inline (yellow)
 *     - t=inline (blue)
 *       - t=inline [t=ident "aCreationTimestamp", "@", t=number 0xblah] (green)
 *       - "."
 *       -  t=ident "mValue"
 *     - "="
 *     - t=inline (blue), "{"/"}" wrapped, t=inline comma-delimited "="-split
 */
function grokFunctionArgName(pml, ctx) {
  let producer;
  let renderer;
  if (pml?.a?.data) {
    producer = ctx.runGrokkerOnNode(grokProducer, pml.a.data.producer, "producer");
    renderer = ctx.runGrokkerOnNode(grokRenderer, pml.a.data.renderer, "renderer");
  }

  // ## Simple Case: Just an ident
  if (ctx.isIdent(pml)) {
    return {
      ident: ctx.runGrokkerOnNode(grokIdent, pml, "ident"),
      producer,
      renderer,
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
      producer,
      renderer,
      value: undefined,
    };
  }

  // ## Stringified pointer case: 2 children "*" "hex address"
  if (ctx.isInline(pml) && ctx.isDoubleString(pml) && pml.c[0] === "*") {
    return {
      ident: null,
      producer,
      renderer,
      value: pml.c[1]
    };
  }

  // ## It's probably a compound ident...
  // XXX this should perhaps just be a direct invocation of grokCompoundIdent,
  // but the semantics around { ident: { name }, value } versus
  // { ident: { name, value }} should likely be clarified.  Like should we shell
  // out but propagate any value up?


  // ## "." delimited indicating a compound ident
  if (ctx.isInline(pml) && ctx.hasPairDelim(pml, ".")) {
    return {
      ident: ctx.runGrokkerOnNode(grokCompoundIdent, pml, "ident-compound"),
      producer,
      renderer,
      value: undefined,
    };
  }

  if (ctx.isInline(pml) && ctx.hasPairDelim(pml, "@")) {
    return {
      // This could be a simple ident or ?maybe? a compound ident
      ident: ctx.runGrokkerOnNode(grokCompoundIdent, pml.c[0], "ident@0"),
      producer,
      renderer,
      value: ctx.runGrokkerOnNode(grokValue, pml.c[2], "value@2"),
    };
  }

  // This is the array-subscripted situation.
  if (ctx.isArraySubscripting(pml)) {
    // We just generally recurse for this.
    const wrapped = pml.c[0];
    const subscripted = ctx.runGrokkerOnNode(grokFunctionArgName, wrapped, "subscripted@0");
    subscripted.subscript = pml.c[1];
    return subscripted;
  }

  ctx.warn("Unknown function argument name format", pml);
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
      value: ctx.runGrokkerOnNode(grokObject, pml, "wrapped"),
      pretty: undefined,
    };
  }

  return {
    value: ctx.runGrokkerOnNode(grokValue, pml, "unwrapped"),
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
 *
 * There's now a variant where insetad of [left, "=", right] we end up with
 * [[left, "="], right].  Presumably this is done to bias the line-wrapping
 * behavior.
 */
function  grokFunctionArg(pml, ctx) {
  const { left, delim, right } = ctx.splitPairDelimShapes(pml);
  if (!delim) {
    return null;
  }

  // Because of the complex situation where the name can end up including the
  // memory location of the object-printed right, we need to post-process the
  // results of the more straightforward grokking.
  const namish = ctx.runGrokkerOnNode(grokFunctionArgName, left, "left");
  const valueish = ctx.runGrokkerOnNode(grokFunctionArgValue, right, "right");

  return {
    ident: namish.ident,
    value: namish.value || valueish.value,
    producer: namish.producer || valueish.producer,
    renderer: namish.renderer || valueish.renderer,
    pretty: valueish.pretty,
  };
}

function grokFunctionArgList(pml, ctx) {
  const result = ctx.parsify(
    pml,
    [
      {
        name: "args",
        grokker: grokFunctionArg,
        repeatDelim: ",",
        allowRepeatedDelim: true,
      }
    ]
  );
  return result.args;
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
        grokker: grokFunctionArgList,
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
    puid: focusInfo.frame.addressSpaceUid.task,
    tuid: focusInfo.tuid,
    entryMoment: focusInfo.frame.entryMoment,
    returnMoment: focusInfo.frame.returnMoment,
    focusInfo,
    source: pml.a.source,
  };

  return result;
}

/**
 * ## call start/stop info
 * There's a bunch of redundant encoding of information around this.  The
 * basic situation and core logic is:
 * - t=block a={ extent: {s, e}}
 *   - t=inline a={ focus }
 *
 * extent.s and extent.e are valid focuses for the start and end of the frame
 * where as the inline focus represents the current actual timestamp.  The
 * focus moment will be the same through all of the frames in the stack.
 *
 */
function grokStackFrame(pml, ctx) {
  const extent = pml.a.extent;
  // pierce to the inline node which has the rest of what we want.
  pml = pml.c[0];
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
        grokker: grokFunctionArgList,
      },
      ")",
      {
        name: "humanReadableFrame",
        grokker: grokStackAtSourceFileAndLine
      }
    ]);

  const focusInfo = pml.a.focus;
  result.meta = {
    puid: focusInfo.frame.addressSpaceUid.task,
    tuid: focusInfo.tuid,
    // do we want to include these moments given that we have full focuses?
    entryMoment: focusInfo.frame.entryMoment,
    returnMoment: focusInfo.frame.returnMoment,
    startFocusInfo: extent.s,
    focusInfo,
    endFocusInfo: extent.e,
    source: pml.a.source,
  };

  return result;
}

const LINE_CONTENT_DELIM_DASH = "—";

function grokBreakpointHit(pml, ctx) {
  const result = ctx.parsify(
    pml,
    [
      {
        name: "file",
        grokker: grokIdent,
      },
      ":",
      {
        name: "sourceLineNumber",
        grokker: grokSourceLineNumber,
      },
      LINE_CONTENT_DELIM_DASH,
      // This bit seems to be exactly the same information as the above but with
      // the presumption that a SourceText lookup will be run to provide the
      // content at the given position.
      {
        name: "sourceLine",
        grokker: grokSourceLineNumber
      }
    ]);

    result.breakpoint = true;

    return result;
}

/**
 * treeItems have a structure where the first child is a t=inline that contains
 * the contents of the item.  All subsequent children are tree children where:
 * - t=block children are leaf nodes which should only have a single inline
 *   child which is their content.
 * - t=treeItem children will also have children.
 *
 * For "task-tree", we also observe:
 * - Nodes will either be describing a "process" or a "thread", where each will
 *   be preceded by a descriptive word, or in the event of an `exec` the first
 *   inline child will contain the command line.  For processes we can see "Vfork"
 *   and "Fork".  For threads we see "Create".  Note that while "Create " is
 *   initial-caps, both "process" and "thread" are lowercase but visually modified
 *   through the use of the `domClass="capitalize"` on the block/treeItem.
 * - Note that in some cases the "Exit" nodes seem to be at the samee level as
 *   the command line arguments.  This seems like it might be when a signal
 *   kills the process rather than the process exiting cleanly?  Either way we
 *   don't currently care about exiting.
 * - "thread" nodes are "Create " followed by a t=task wrapping another t=task
 *   with children: ["thread NNNNNN (", t=str "thread name", ")"].
 * - The only reason that makes sense for the wrapping is that it lets the
 *   t=process also be a t=task, but it's not clear the UI cares about this.
 *   It seems possible that this the backend datamodel leaking through somewhat.
 *
 * Representationally, while the normalized tree is interesting, and in
 * particular that it's ordered by creation, a major result here is that we also
 * populate a "thread" lookup on the provided context.
 *
 * Implementation-wise, because the structure is constrained, we hand-roll this.
 */
function grokTreeItem(rootPml, ctx, mode) {
  if (mode !== "task-tree") {
    console.warn("don't know how to handle tree with mode", mode);
    return undefined;
  }

  const threadMap = ctx.blackboard.threadMap = new Map();
  const processes = ctx.blackboard.processes = [];

  // Processes a node with the given process id as the containing process.
  const chewItem = (pml, inProc) => {
    if (!pml || typeof(pml) !== "object" || !pml.c) {
      return;
    }

    if (pml.t !== "block" && pml.t !== "treeItem") {
      return;
    }

    // The content node, this should be t=inline.
    const infoKid = pml.c[0];
    if (infoKid?.t !== "inline") {
      return;
    }

    // This is an `exec` if the inline payload is the arguments.
    //
    // We originally tried to just reach into the children to find the exec
    // because it seemed like that was an inherent part of the structure, but at
    // least one rebuilt old trace seemed to regularly have forks before the exec
    // so now when we detect an exec we fix-up the info for our current process.
    const isExec = ctx.firstChildIsStringAndStartsWith(infoKid, "/");
    let isProcess, taskNode;
    if (isExec) {
      const args = ctx.pickAndExtractStrings(infoKid);
      let name = args[0];
      const idxLastSlash = name.lastIndexOf("/");
      if (idxLastSlash > -1) {
        name = name.substring(idxLastSlash + 1);
      }
      inProc.name = name;
      inProc.args = args;
      isProcess = true;
    } else {
      // Otherwise the child should be a task node.
      // This is where labeling text like "Create " exists; we skip it.
      taskNode = ctx.pickFirstChildOfType(infoKid, "task");
      if (!taskNode) {
        return;
      }

      isProcess = taskNode.c[0].t === "process";
    }

    // If this is a process,
    if (isProcess) {

      let thisProc;
      if (!isExec) {
        const procNode = taskNode.c[0];
        const tuid = procNode.a.tuid; // same info also on the taskNode.

        const threads = [];
        thisProc = {
          kind: "process",
          puid: tuid,
          tuid,
          name: inProc?.name,
          args: null,
          threads,
        };
        processes.push(thisProc);
        threadMap.set(normTuid(tuid), thisProc);
      } else {
        thisProc = inProc;
      }

      for (let iNode = 1; iNode < pml.c.length; iNode++) {
        const node = pml.c[iNode];
        // It's possible is something like an "Exit..." line we want to skip.
        if (ctx.isSoleString(node)) {
          continue;
        }

        chewItem(node, thisProc);
      }
    } else { // it's a thread
      const threadNode = taskNode.c[0];
      const tuid = threadNode.a.tuid;
      const name = ctx.pickFirstChildOfType(threadNode, "str");
      const thread = {
        kind: "thread",
        puid: inProc.puid,
        tuid,
        name,
      };

      inProc.threads.push(thread);
      threadMap.set(normTuid(tuid), thread);
    }
  };

  console.log("Chewing root", rootPml);

  chewItem(rootPml, null);
  return { processes };
}

const PRINT_DELIM_ARROW = "→";

/**
 * XXX recursively tries to find the itemTypeName by traversing down the first
 * child of the given PML nodes, but I think this ends up overlapping with
 * what grokRootPML was already doing and I was trying to find my place.
 */
function findItemType(pml) {
  if (pml.a && pml.a.itemTypeName) {
    return pml.a.itemTypeName;
  }

  if (pml.c) {
    return findItemType(pml.c[0]);
  }

  return null;
}

/**
 * Process root PML nodes which we expect to be blocks that hold an inline
 * result whose attributes describes what we're seeing.
 *
 * TODO: Things will get more complicated when print expressions get involved.
 */
function grokRootPML(ctx, pml, mode, results, focus) {
  window.LAST_ROOT_PML = pml;
  if (mode === "evaluate") {
    let result;
    result = ctx.runGrokkerOnNode(grokFunctionArgValue, pml, "root-evaluate");
    results.push(result);
    return;
  }
  if (mode === "search-evaluate") {
    let result;
    // Not sure what's up with the outer inline, but let's scrape it off.
    if (ctx.isInline(pml) && ctx.hasSoleChildOfType(pml, "inline")) {
      result = ctx.runGrokkerOnNode(grokFunctionArg, pml.c[0], "root-evaluate");
    }
    results.push(result);
    return;
  }

  // "task-tree" has a singular root treeItem, but "current-tasks" has a list of
  // treeItems, one per current process, so this only works for "task-tree"
  // right now.  (Although grokPMLRows should work for that...)
  if (pml.t === "treeItem") {
    let result = grokTreeItem(pml, ctx, mode);
    results.push(result);
    return;
  }

  if (pml.t !== "block") {
    console.warn("Unexpected root PML type", pml.t, pml);
    return;
  }
  if (!pml.c) {
    console.warn("Root PML has no children?", pml);
    return;
  }

  if (mode === "stack") {
    // the outer t=block has the extent attribute which we need/want
    results.push(ctx.runGrokkerOnNode(grokStackFrame, pml));
    return;
  }
  if (mode === "watchpoint") {
    let result;
    // pierce the wrapping block to get to the t=inline
    result = ctx.runGrokkerOnNode(grokValue, pml.c[0], "root-watchpoint");
    results.push(result);
    return;
  }

  let topPml;
  let canonChild;
  let canonGrokker;
  let printWrapped = false;

  if (mode === 'breakpoint') {
    // Breakpoints end up looking like:
    //
    // 0. t=inline
    //    0. t=ident
    //    1. ":"
    //    2. t=sourceLineNumber
    //    3. " — "
    //    4. t=source-line
    // 1. " → "
    // 2. t=inline (the normal print stuff)
    //
    // This differs from the 'execution' case by not having an additional layer
    // of t=inline wrapping.

    topPml = pml;
    printWrapped = true;
    // Curry
    canonGrokker = (subPml, subCtx) => {
      const result = grokBreakpointHit(subPml, subCtx);
      result.meta = {
        puid: focus.frame.addressSpaceUid.task,
        tuid: focus.tuid,
        entryMoment: focus.frame.entryMoment,
        returnMoment: focus.frame.returnMoment,
        focusInfo: focus,
        source: result.sourceLineNumber.source,
      };
      return result;
    }
  } else {
    if (pml.c.length !== 1) {
      console.warn("Root PML has more than 1 child?", pml);
      return;
    }

    // At this point, we expect to either have a single child with an
    // "itemTypeName" attribute OR we expect for it to be wrapped in an inline
    // that has "→" as a delimiter separating print values from that child.
    topPml = pml.c[0];
    canonChild = topPml;

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
  }

  let result;
  if (printWrapped) {
    // See `grokPrinted` block comment for a full example
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
    result = ctx.runGrokkerOnNode(grokItemTypeFunction, canonChild, "root-not-printwrapped");
  }

  results.push(result);
}

export function normalizePmlPayload(payload) {
  if (!Array.isArray(payload)) {
    return payload;
  }
  // We only want to perform a fix-up if we saw some "parent" entries.
  const namedRows = [];
  const unparentedNodes = [];
  const parentedNodes = new Map();
  for (const row of payload) {
    if (!row.items) {
      if (row.name) {
        namedRows.push(row);
      }
      continue;
    }
    for (const node of row.items) {
      // Note that the parent value is a string, as is the containerId payload.
      if (node.parent) {
        parentedNodes.set(node.parent, node);
      } else {
        unparentedNodes.push(node);
      }
    }
  }

  // Just return the payload verbatim if there were no parented nodes.
  if (parentedNodes.size === 0) {
    return payload;
  }

  // Our fixup method just basically walks all the children and checks if there
  // is a containerId and then applies it by replacing the initial containerId
  // node.  I initially just added it as a child, but for cases like "stack"
  // this let to divergence in the structure between the "show executions"
  // mechanism.  This doesn't matter for the pernosco UI which is only about
  // presentation, but it's much saner for us if we don't introduce variations
  // where they don't need to exist.
  function fixupPml(pml) {
    const containerId = pml?.a?.containerId;
    if (containerId) {
      const contentNode = parentedNodes.get(containerId);
      // It looks like the container indeed is a container and gets to still
      // exist.  There is some question of how the context should be handling
      // this, though.  The structure we end up with is basically:
      //
      // - t=inline a={elided: null}
      //   - t=inline a={containerId: "ID"}
      //
      // While parsify can automatically pierce that, there's an argument to be
      // made to perform the merge on the elided level.  The argument against
      // that is we're already basically working in pml as it exists, so we
      // create a variation.  The context helpers already exist to help abstract
      // things away, and they could abstract this.
      if (contentNode) {
        return contentNode.pml;
      }
    }

    if (pml.c) {
      for (let iNode = 0; iNode < pml.c.length; iNode++) {
        const kid = pml.c[iNode];
        const replacement = fixupPml(kid);
        if (replacement) {
          pml.c[iNode] = replacement;
        }
      }
    }
  }

  const transformedRows = namedRows.concat();
  const transformedItems = [];
  for (const node of unparentedNodes) {
    if (node.pml) {
      fixupPml(node.pml);
    }
    transformedItems.push(node);
  }
  transformedRows.push({ items: transformedItems });

  return transformedRows;
}

export function grokPML(pml, mode, focus) {
  const ctx = new GrokContext();
  const results = [];
  grokRootPML(ctx, pml, mode, results, focus);
  return results[0];
}

export function grokPMLRows(rows, mode) {
  const ctx = new GrokContext();
  const results = [];
  for (const row of rows) {
    if (row.items) {
      for (const item of row.items) {
        if (item.pml) {
          grokRootPML(ctx, item.pml, mode, results);
        }
      }
    }
  }
  return results;
}

export function grokStructured(rows, mode) {
  console.log('grokStructured', rows, mode);
  const ctx = new GrokContext();
  const results = [];

  /**
   * Helper to verify that the rows contains a single row that has an "items"
   * property and that it has a single item whose pml type is `rootType`.  This
   * explicitly is fine with rows that just have a `{ name: string }` payload.
   *
   * Result object contains:
   * - "results": The list of results like `grokPMLRows` would provide.
   * - "blackboard": The structured data built as a side-effect of the grokking
   *   process that may provide multiple perspectives on the underlying data.
   *   For example, the "task-tree" "results" are a sequenced hierarchy that
   *   tells the history of how all processes came into existence, but will
   *   create blackboard entries that map normalized tuid's to thread info as
   *   well as a flattened list of all known processes.
   */
  const assertTreeShape = (checkRows, { rootType }) => {
    let itemRows = 0;
    let result = undefined;
    for (const row of checkRows) {
      if (row.items) {
        if (itemRows++) {
          throw new Error("Too many items rows!");
        }
        if (row.items.length > 1) {
          throw new Error("Too many items!");
        }
        if (row.items[0]?.pml?.t !== rootType) {
          throw new Error(`Root item has type ${row.items[0].pml.t} but should have ${rootType}`);
        }
        result = row.items[0].pml;
      }
    }

    if (!itemRows || !result) {
      throw new Error("No items rows!");
    }
    return result;
  };

  switch (mode) {
    case "task-tree": {
      const pml = assertTreeShape(rows, { rootType: "treeItem" });
      let result = grokTreeItem(pml, ctx, mode);
      results.push(result);
      break;
    }
    default: {
      throw new Error(`Unknown mode: ${mode}`);
    }
  }

  return {
    results,
    blackboard: ctx.blackboard
  };
}
