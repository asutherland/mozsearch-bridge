import parse from '@iarna/toml/parse-string';
import bounds from 'binary-search-bounds';

import { grokPML, grokPMLRows } from '../pmlgrok/grokker.js';

function shortSymbolName(name) {
  const parts = name.split('::');
  return parts.slice(-2).join('::');
}

function deriveClassConstructor(name) {
  const parts = name.split('::');
  parts.push(parts[parts.length - 1]);
  return parts.join('::');
}

function deriveClassDestructor(name) {
  const parts = name.split('::');
  parts.push('~' + parts[parts.length - 1]);
  return parts.join('::');
}

// Assemble a PidPtr from a pid (process id) and pointer (hex string of a
// pointer).
function makePidPtr(pid, ptr) {
  return `${pid}:${ptr}`;
}

function makePidPtrUsingFocusInfo(focusInfo, ptr) {
  const pid = focusInfo.frame.addressSpaceUid.task.tid;
  return makePidPtr(pid, ptr);
}

function cmpMoment(a, b) {
  if (a.event < b.event) {
    return -1;
  }
  if (a.event > b.event) {
    return 1;
  }
  // a.event === b.event
  if (a.instr < b.instr) {
    return -1;
  }
  if (a.instr > b.instr) {
    return 1;
  }
  return 0;
}

// Given a symbol name, pop off the last segment assuming it's a method.
// Returns null if there was only 1 segment.
function classNameFromMethod(symName) {
  const idxDouble = symName.lastIndexOf('::');
  if (idxDouble === -1) {
    return null;
  }
  const className = symName.substring(0, idxDouble);
  return className;
}

function extractThisPtr(callInfo) {
  if (!callInfo.args || callInfo.args.length < 1) {
    return null;
  }
  const firstArg = callInfo.args[0];
  if (firstArg?.ident?.name !== "this") {
    return null;
  }
  if (!firstArg?.value?.data) {
    return null;
  }
  return firstArg.value.data;
}

function extractThisPtrFromIdentity(identity) {
  return identity?.this?.value?.data;
}

class AnalyzerConfig {
  constructor(rawConfig, path) {
    this.path = path;
    this.rawConfig = rawConfig;

    this.tomlConfig = parse(rawConfig);

    // The prefix that should be asumed for all classes referenced in the
    // config file.  `normalizeSymName` uses this.
    this.nsPrefix = this.tomlConfig.namespace?.prefix || '';

    // Map from full class name to information about the class.
    this.classInfoMap = new Map();

    this.semTypeToClassInfo = new Map();

    // Methods to trace
    this.traceMethods = [];

    this._processConfig();
  }

  /**
   * Helper to apply the `namespace.prefix` to all symbol names.
   *
   * TODO: In the near future we'll probably need a way to express symbols that
   * should not just have the prefix applied.  Like using "::" at the start
   * to indicate that we should pop the last namespace (which is likely
   * "(anonymous namespace)") or view "mozilla::" at the start as an absolute
   * namespace usage via hardcoding that could be overridden.
   */
  normalizeSymName(rawName) {
    // Don't normalize absolute namespaces.
    if (rawName.startsWith('mozilla::')) {
      return rawName;
    }
    return this.nsPrefix + rawName;
  }

  /**
   * Get the ClassInfo for a symName, creating it if it doesn't already exist.
   * See inline docs below about what the object containts.
   */
  getOrCreateClass(symName,) {
    let classInfo = this.classInfoMap.get(symName);
    if (classInfo) {
      return classInfo;
    }

    classInfo = {
      name: symName,
      semType: null,
      trackLifecycle: false,
      // Immediate (non-transitive) subclasses, currently comes directly from
      // typeinfo (and which can be a simplification of reality).
      subclasses: new Set(),
      // Immediate superclasses, currently inferred from "subclasses".
      superclasses: new Set(),
      stateDefs: [],
      identityDefs: [],
      // If non-null, the method we should find the execution of in order to
      // sample the identity.
      //
      // This ends up being 2-phase, where:
      // 1. We find the executions of the method to identify at least one start
      //    point.  For now we accumulate all the executions as a normal trace
      //    invocation.
      // 2. We query the dynamic annotations of one of the method executions in
      //    order to identify the last line in the method.  We then issue a
      //    breakpoint query with the identity values we want as a print
      //    query.  This lets us know the value at exit time.  Note that this is
      //    potentially imperfect for something initialized on the last line of
      //    the method when the closing brace itself doesn't get its own
      //    breakpoint.
      identityMethodSymName: null,
      identitySamplingTraceDef: null,
      // This is populated by Analyzer._deriveHierarchies
      identityLinkTypes: {},
    };
    this.classInfoMap.set(symName, classInfo);
    return classInfo;
  }

  /**
   * Process the configuration from a hopefully compact human-friendly TOML
   * file into a more immediately consumable representation for the Analyzer.
   */
  _processConfig() {
    this._processTypeInfo(this.tomlConfig.typeinfo);
    this._processClassInfo(this.tomlConfig.class);
    this._processTraceInfo(this.tomlConfig.trace);
  }

  /**
   * Process the "typeinfo" top-level dictionary in the configuration file which
   * provides us with class hierarchy information that we should really be able
   * to automatically extract from searchfox or pernosco, but currently cannot.
   * (Bug 1641372 tracks the work in searchfox to get this information landed
   * from the fancy branch.)
   */
  _processTypeInfo(typeInfo) {
    if (!typeInfo) {
      return;
    }

    for (const [rawClassName, rawInfo] of Object.entries(typeInfo)) {
      const className = this.normalizeSymName(rawClassName);

      const classInfo = this.getOrCreateClass(className);
      if (rawInfo.subclasses) {
        for (const rawSubclassName of rawInfo.subclasses) {
          const subclassName = this.normalizeSymName(rawSubclassName);
          const subclassInfo = this.getOrCreateClass(subclassName);

          classInfo.subclasses.add(subclassInfo);
          subclassInfo.superclasses.add(classInfo);
        }
      }
    }
  }

  /**
   * Process the "class" top-level dictionary which centralizes information
   * about a class's identity and states.  During analysis, it's assumed that
   * all subclasses want all of this info from all their ancestors.
   */
  _processClassInfo(rawClassDict) {
    if (!rawClassDict) {
      return;
    }

    for (const [rawClassName, rawInfo] of Object.entries(rawClassDict)) {
      const className = this.normalizeSymName(rawClassName);
      const classInfo = this.getOrCreateClass(className);

      if (rawInfo.lifecycle) {
        classInfo.trackLifecycle = true;
      }
      if (rawInfo.semType) {
        classInfo.semType = rawInfo.semType;
      } else if (classInfo.trackLifecycle) {
        // If there's no human assigned semType, we use the symbol name because
        // all of our infrastructure really wants this.
        classInfo.semType = classInfo.name;
      }

      if (classInfo.semType) {
        this.semTypeToClassInfo.set(classInfo.semType, classInfo);
      }


      // Lifecycle currently means that we automatically trace the constructors
      // and destructors, sampling the identity attributes at destructor time
      // so that we can build an object instance for hierarchy purposes.
      if (classInfo.trackLifecycle) {
        this.traceMethods.push({
          symName: deriveClassConstructor(className),
          mode: 'constructor',
          classInfo,
          capture: null,
        });
        const destructorTraceDef = {
          symName: deriveClassDestructor(className),
          mode: 'destructor',
          classInfo,
          capture: null,
        };
        classInfo.identitySamplingTraceDef = destructorTraceDef;
        this.traceMethods.push(destructorTraceDef);
      }

      if (rawInfo.identityMethod) {
        classInfo.identityMethodSymName =
          this.normalizeSymName(rawInfo.identityMethod);
        const identityTraceDef = {
          symName: classInfo.identityMethodSymName,
          mode: 'last-line',
          classInfo,
          capture: null,
        };
        classInfo.identitySamplingTraceDef = identityTraceDef;
        this.traceMethods.push(identityTraceDef);
      }

      if (rawInfo.state) {
        for (const [name, capInfo] of Object.entries(rawInfo.state)) {
          classInfo.stateDefs.push({
            name,
            eval: capInfo.eval,
          });
        }
      }

      if (rawInfo.identity) {
        // We need to explicitly cram a "this" in ahead of any other identity
        // data when using a breakpoint.
        if (rawInfo.identityMethod) {
          classInfo.identityDefs.push({
            name: 'this',
            eval: 'this',
          });
        }
        for (const [name, capInfo] of Object.entries(rawInfo.identity)) {
          classInfo.identityDefs.push({
            name,
            eval: capInfo.eval,
          });
        }
      }
    }
  }

  /**
   * Process the "trace" top-level dictionary that contains information about
   * methods that we explicitly want to trace.  In the future this might
   * largely be mooted by other mechanisms where interest is expressed just at
   * the class level or via other means of heuristic determination and iterative
   * deepening rather than potentially massively over-tracing (and requiring a
   * lot of manual method enumeration).
   */
  _processTraceInfo(rawTraceDict) {
    if (!rawTraceDict) {
      return;
    }

    for (const [rawSymName, rawInfo] of Object.entries(rawTraceDict)) {
      const symName = this.normalizeSymName(rawSymName);
      const className = classNameFromMethod(symName);
      const classInfo = this.getOrCreateClass(className);

      let captureDefs;
      if (rawInfo.capture) {
        captureDefs = [];
        for (const [name, capInfo] of Object.entries(rawInfo.capture)) {
          captureDefs.push({
            name,
            eval: capInfo.eval,
          });
        }
      }

      this.traceMethods.push({
        symName,
        mode: 'trace',
        classInfo,
        captureDefs,
      });
    }
  }
}

/**
 * The Analyzer takes a TOML config that describes methods and classes in a
 * given subsystem and performs a series of pernosco queries in order to build
 * up one or more group hierarchies over time-series representations of method
 * calls and derived states.
 */
class Analyzer {
  constructor(configs) {
    this.configs = configs;

    this.client = null;
    this.allQueryResults = [];

    this._allMoments = [];
    this.momentToSeqId = new Map();
    this.lastSeqId = 0;

    // Map from symbol/method name to a TraceResult record; does not include
    // automatically generated class lifecycle traces which end up in
    // `classResults`.
    this.traceResultsMap = new Map();
    // Map from class (symbol) name to { classInfo, constructorTraceResults,
    // destructorTraceResults } and which may be expanded in the future.
    this.classResultsMap = new Map();

    // Key is a `semType`, value is a Map whose keys are PidPtr strings (that
    // combine a process id and hex string value for memory space uniqueness)
    // and values are arrays of instances with start/end values.
    this.semTypeToInstanceMap = new Map();

    // Key is an identity that wasn't a semType.
    this.conceptToInstanceMap = new Map();

    // We aggregate this from all of our configs.
    let semTypePieces = [];
    for (const config of configs) {
      semTypePieces.push(...config.semTypeToClassInfo);
    }
    this.semTypeToClassInfo = new Map(semTypePieces);
  }

  _getOrCreateClassResults(classInfo) {
    let classResults = this.classResultsMap.get(classInfo.name);
    if (!classResults) {
      classResults = {
        classInfo,
        // The idea is that we unify over all constructors here.
        // TODO: Make sure we actually unify over all constructors.
        constructorTraceResults: null,
        destructorTraceResults: null,
        identityTraceResults: null,
      };
      this.classResultsMap.set(classInfo.name, classResults);
    }
    return classResults;
  }

  _getOrCreateConceptInstance(name, value) {
    let conceptInstMap = this.conceptToInstanceMap.get(name);
    if (!conceptInstMap) {
      conceptInstMap = new Map();
      this.conceptToInstanceMap.set(name, conceptInstMap);
    }
    let conceptInst = conceptInstMap.get(value);
    if (!conceptInst) {
      conceptInst = {
        semLocalObjId: value,
        name: value,
        isConcept: true,
      };
      conceptInstMap.set(value, conceptInst);
    }
    return conceptInst;
  }

  // Get the instance characterized by the given pidPtr at the provided moment.
  // Our approach here is intentionally a little fuzzy since we current expect
  // to be performing lifecycle analyses at object destruction time and it's
  // conceivable for the destructions to have stale-ish pointers.  So we're
  // really asking what was the most recent instance for this address at the
  // given moment, even if it theoretically is already destroyed.
  _getSemTypeInstance(semType, pidPtr, moment) {
    const instanceMap = this.semTypeToInstanceMap.get(semType);
    if (!instanceMap) {
      return null;
    }

    const instList = instanceMap.get(pidPtr);
    if (!instList) {
      return null;
    }

    const idxLE = bounds.le(
      instList, moment,
      (a, _moment) => cmpMoment(a.constructionMoment, _moment));
    if (idxLE === -1) {
      return null;
    }
    return instList[idxLE];
  }

  async analyze(client, progressCallback) {
    console.log('Analyzing using configs', this.configs);

    this.client = client;
    const allQueryResults = this.allQueryResults = [];

    // ## Phase 1: Trace methods of interest, noting interesting instances
    for (const config of this.configs) {
      console.log(`## Processing Config: ${config.path}`)
      for (const traceDef of config.traceMethods) {
        console.log('Tracing', traceDef.symName, traceDef);
        progressCallback(`Tracing ${traceDef.symName}`, {});
        await this._doTrace(traceDef);
      }
    }

    // Establish the time mapping as early as possible so we can use it for
    // debugging logging or similar.
    this._establishTimeMapping();

    // ## Phase 2: Derive instances
    this._deriveInstances();

    // ## Phase 3: Derive hierarchies amongst the life-lines
    this._deriveHierarchies();

    console.log('Results', allQueryResults);
    return [];
  }

  async _doTrace(traceDef, pass = 'initial', queryParams) {
    const { symName, classInfo } = traceDef;

    let stateDefs = null;
    let identityDefs = null;
    function walkClassInfo(ci) {
      if (!ci) {
        return;
      }
      if (ci.stateDefs.length) {
        if (!stateDefs) {
          stateDefs = [];
        }
        stateDefs.push(...ci.stateDefs);
      }
      if (ci.identityDefs.length) {
        if (!identityDefs) {
          identityDefs = [];
        }
        identityDefs.push(...ci.identityDefs);
      }
      for (const superclass of ci.superclasses) {
        walkClassInfo(superclass);
      }
    }
    walkClassInfo(classInfo);

    const usePrint = traceDef.captureDefs || stateDefs || identityDefs;
    const printParts = usePrint ? [] : undefined;
    const printNames = usePrint ? [] : undefined;
    const printSources = usePrint ? [] : undefined;

    if (traceDef.captureDefs) {
      for (const capDef of traceDef.captureDefs) {
        printParts.push(capDef.eval);
        printNames.push(capDef.name);
        printSources.push('capture');
      }
    }
    if (stateDefs) {
      for (const def of stateDefs) {
        printParts.push(`this->${def.eval}`);
        printNames.push(def.name);
        printSources.push('classState');
      }
    }
    // If this is a class that has its lifecycle tracked, then there's no need
    // to extract the identity on anything but the identitySamplingTraceDef.
    // An edge case here is in 'last-line' mode we actually will run a second
    // query after this one and that's when we should do that.
    //
    // XXX this is unwieldy for the last-line case and it's appropriate to
    // revisit all of this if some other pre/post-pass becomes necessary.  For
    // last-line, it's quite likely/possible pernosco will take on this
    // responsibility in the future and we can avoid doing any extra work, which
    // is why we're not getting fancier here.
    if (identityDefs &&
        (!classInfo.identitySamplingTraceDef ||
          (classInfo.identitySamplingTraceDef === traceDef &&
           (traceDef.mode !== 'last-line' || pass !== 'initial')))) {
      for (const def of identityDefs) {
        printParts.push(def.eval);
        printNames.push(def.name);
        printSources.push('identity');
      }
    }

    const print = printParts ? printParts.join(', ') : undefined;

    if (!queryParams) {
      queryParams = {
        name: 'execution',
        limit: 222,
        mixArgs: {
          params: {
            symbol: symName,
            print
          },
        },
      };
    } else {
      queryParams.mixArgs.params.print = print;
    }

    // This will be an array of items of the form { items: [ { focus, pml }]}
    const rawResults = await this.client.sendMessageAwaitingReply(
      'rangeQuery',
      queryParams
    );

    const execs = [];
    for (const row of rawResults) {
      if (row.items) {
        for (const item of row.items) {
          if (item.pml) {
            const grokked = grokPML(item.pml, queryParams.name, item.focus);
            let call;
            let data = null;
            if (grokked.queried) {
              call = grokked.queried;
              data = {};
              for (let i = 0; i < printSources.length; i++) {
                const printed = grokked.printed[i];
                const name = printNames[i];
                const source = printSources[i];

                let sourceDict = data[source];
                if (!sourceDict) {
                  sourceDict = data[source] = {};
                }
                sourceDict[name] = printed;
              }
            } else {
              call = grokked;
            }
            this._learnMoment(call.meta.entryMoment);
            this._learnMoment(call.meta.returnMoment);
            execs.push({
              call,
              data,
              rawItem: item,
              identityLinks: {},
            });
          }
        }
      }
    }

    const traceResults = {
      symName,
      traceDef,
      execs,
    };
    switch (traceDef.mode) {
      case 'constructor':
      case 'destructor': {
        const classResults = this._getOrCreateClassResults(traceDef.classInfo);
        if (traceDef.mode === 'constructor') {
          classResults.constructorTraceResults = traceResults;
        } else {
          classResults.destructorTraceResults = traceResults;
        }
        break;
      }

      case 'last-line': {
        if (pass === 'initial') {
          // XXX Include this in the trace results for now so that we get the
          // init calls showing up on the timeline in order to ensure that the
          // object shows up at all... but this perhaps should be optional or
          // at least collapsed into the lifeline.
          this.traceResultsMap.set(symName, traceResults);

          // TODO: Extract out the various sub-command invocations here.
          if (execs.length) {
            // ## Figure out the last line so we can do a breakpoint query

            // Use the focus from the first exec.  It doesn't matter which exec,
            // just an exec.
            const useFocus = execs[0].call.meta.focusInfo;
            const useSourceUrl = execs[0].call.meta?.source?.url;

            // ## Get the annotations!
            // Results look like:
            // - glyphMarginDecorations: {}
            //   - points: Array of 4-tuples:
            //     0. { l: [line, column] } designed to be translated by
            //        `textReferenceToPosition`.
            //     1. "strong" or "weak" ("kind", where strong is this loop)
            //     2. { data, frame, moment, node, tuid }, but optional and
            //        where it seems expected that the frame will be null and
            //        should instead be populated from this focus's frame.
            //     3. 0.  ("titleIndex" which is some kind of weird lookup
            //        magic that my experimentation doesn't trigger.)
            let annoResults = await this.client.sendMessageAwaitingReply(
              'simpleQuery',
              {
                name: 'dynamicAnnotations',
                mixArgs: {
                  // Use the entry moment's focus.
                  focus: useFocus,
                  // We should have the source from the call here.
                  source: useSourceUrl,
                }
              }
            );
            // There should only be a single value in the array.
            annoResults = annoResults[0];

            let lastLine = 0;
            let linePos = null;
            let lineFocus = null;
            if (annoResults?.glyphMarginDecoration?.points) {
              for (const point of annoResults.glyphMarginDecoration.points) {
                const line = point[0].l[0];
                if (line >= lastLine) {
                  lastLine = line;
                  linePos = point[0];
                  lineFocus = point[2];
                  lineFocus.frame = useFocus.frame;
                }
              }
            }

            // ## Do the breakpoint query
            if (lineFocus) {
              await this._doTrace(
                traceDef,
                'last-line',
                {
                  name: 'breakpoint',
                  limit: 222,
                  mixArgs: {
                    params: {
                      url: useSourceUrl,
                      // The o is an offset in the source file that SourceText
                      // goes to a lot of work to figure out.
                      //
                      // For now we're just going to try to pass a 0 offset and
                      // see if that works.  Otherwise, it likely makes sense
                      // to create an async protocol to make SourceText do the
                      // work for us via
                      // `originalTextPositionToClientTextReference` which
                      // expects the { l: [l, c] } pos to have been expanded to
                      // { lineNumber, column } as
                      // `textReferenceToOriginalTextPosition` does.
                      points: [{ l: linePos.l[0], c: linePos.l[1], o: 0 }]
                    },
                  },
                });
              }
          }
        } else {
          const classResults = this._getOrCreateClassResults(traceDef.classInfo);
          classResults.identityTraceResults = traceResults;
          // Also treat this as a normal trace result?
          //this.traceResultsMap.set(symName, traceResults);
        }
        break;
      }

      default: {
        this.traceResultsMap.set(symName, traceResults);
        break;
      }
    }

    this.allQueryResults.push(...rawResults);
  }

  /**
   * Process the `classResultsMap` to populate `semTypeToInstanceMap`, building
   * up an understanding of all (future work: relevant) instances and their
   * lifetimes.
   */
  _deriveInstances() {
    for (const { classInfo, constructorTraceResults, destructorTraceResults, identityTraceResults } of
         this.classResultsMap.values()) {
      const instanceMap = new Map();
      this.semTypeToInstanceMap.set(classInfo.semType, instanceMap);

      // NB: There may be a fundamental flaw related to class slicing that we
      // will need to address.  (Or maybe pernosco does magic for us already?)
      const getInstanceListForPtr = (pidPtr) => {
        let list = instanceMap.get(pidPtr);
        if (!list) {
          list = [];
          instanceMap.set(pidPtr, list);
        }
        return list;
      }
      // Find the largest construction moment preceding the provided moment.
      const findInstanceBestConstruction = (instList, moment) => {
        const idxLE = bounds.le(
          instList, moment,
          (a, _moment) => cmpMoment(a.constructionMoment, _moment));
        if (idxLE === -1) {
          return null;
        }
        return instList[idxLE];
      }

      // Process all the constructors first
      {
        const { symName, traceDef, execs } = constructorTraceResults;
        for (const exec of execs) {
          const thisPtr = extractThisPtr(exec.call);
          const thisPidPtr = makePidPtr(exec.call.meta.pid, thisPtr);
          const instList = getInstanceListForPtr(thisPidPtr);

          // This is inherently the right sequential ordering MODULO the fact
          // that we use limits in our query request;s so we could be only
          // capturing a limited subset of the entire space.
          instList.push({
            // Create a per-semType object id by using the list index.  That is,
            // this identifier is only unique for a given semType; the
            // underlying memory could obviously have also been many other
            // things.
            semLocalObjId: `${thisPidPtr}:${instList.length}`,
            // Dig out the ordering moments...
            constructionMoment: exec.call.meta.entryMoment,
            destructionMoment: null,
            // But otherwise let's just hold onto the entire execInfo so we
            // don't find ourselves wishing we had.
            constructorExec: exec,
            destructorExec: null,
            // Identity extracted values
            rawIdentity: {},
            identityLinks: {},
          });
        }
      }

      // Identity trace results which are implicitly from a 'last-line' config
      // at this time and which therefore mean that we also had to pull the
      // "this" out via a print.
      if (identityTraceResults) {
        const { symName, traceDef, execs } = identityTraceResults;
        for (const exec of execs) {
          const thisPtr = extractThisPtrFromIdentity(exec.data.identity);
          const thisPidPtr = makePidPtr(exec.call.meta.pid, thisPtr);
          const instList = getInstanceListForPtr(thisPidPtr);

          const inst = findInstanceBestConstruction(
            instList, exec.call.meta.entryMoment);
          // XXX ignore destructions for which we lack a construction for now...
          if (!inst) {
            continue;
          }

          // Perform identity extractions here as well.
          if (exec.data && exec.data.identity) {
            for (const [name, printed] of Object.entries(exec.data.identity)) {
              // we extracted this above.
              if (name === 'this') {
                continue;
              }

              let rawVal = printed?.value?.data;
              // Normalize pointers into PidPtrs.
              // XXX The grok process can/should retain the type information
              // here and or propagate it upwards into the classInfo so we
              // aren't doing shoddy if reliable hacks here or requiring the
              // config file to contain things that can be inferred.
              let val;
              if (rawVal && rawVal.startsWith('0x')) {
                val = makePidPtr(exec.call.meta.pid, rawVal);
              } else {
                val = rawVal;
              }
              inst.rawIdentity[name] = val;
            }
          }
        }
      }

      // Process all the destructors next/last.
      //
      // Note that, as discussed above, our execution queries are currently
      // bounded and so it's possible for us to see destructions that correspond
      // to constructions we didn't see.
      {
        const { symName, traceDef, execs } = destructorTraceResults;
        for (const exec of execs) {
          const thisPtr = extractThisPtr(exec.call);
          const thisPidPtr = makePidPtr(exec.call.meta.pid, thisPtr);
          const instList = getInstanceListForPtr(thisPidPtr);

          const inst = findInstanceBestConstruction(
            instList, exec.call.meta.entryMoment);
          // XXX ignore destructions for which we lack a construction for now...
          if (!inst) {
            continue;
          }

          inst.destructionMoment = exec.call.meta.entryMoment;
          inst.destructorExec = exec;

          // Perform identity extractions here as well.
          if (exec.data && exec.data.identity) {
            for (const [name, printed] of Object.entries(exec.data.identity)) {
              let rawVal = printed?.value?.data;
              // Normalize pointers into PidPtrs.
              // XXX The grok process can/should retain the type information
              // here and or propagate it upwards into the classInfo so we
              // aren't doing shoddy if reliable hacks here or requiring the
              // config file to contain things that can be inferred.
              let val;
              if (rawVal && rawVal.startsWith('0x')) {
                val = makePidPtr(exec.call.meta.pid, rawVal);
              } else {
                val = rawVal;
              }
              inst.rawIdentity[name] = val;
            }
          }
        }
      }
    }
  }

  /**
   * Process all instances and semTypes, establishing identity links.
   */
  _deriveHierarchies() {
    for (const [semType, instanceMap] of this.semTypeToInstanceMap.entries()) {
      const classInfo = this.semTypeToClassInfo.get(semType);
      let linkTypesDefined = false;
      for (const [pidPtr, instList] of instanceMap.entries()) {
        for (const inst of instList) {
          for (const [name, rawIdent] of Object.entries(inst.rawIdentity)) {
            // See if this name corresponds to a semType; if so, we know we
            // should be establishing a semType link instead of a concept link.
            //
            // XXX This process could be hoisted or further pre-computed; that
            // is, linkTypesDefined would happen once here or in a prior stage
            // which would allow this step to be rote application of the
            // identityLinkTypes knowledge.
            const identClassInfo = this.semTypeToClassInfo.get(name);
            if (identClassInfo) {
              const linkInst = this._getSemTypeInstance(
                name, rawIdent, inst.destructionMoment);
              inst.identityLinks[name] = linkInst;
              if (!linkTypesDefined) {
                if (classInfo) {
                  classInfo.identityLinkTypes[name] = identClassInfo;
                } else {
                  console.warn('weird classInfo for semType', semType, ':', classInfo);
                }
              }
            } else {
              // It's a concept!
              const conceptInst =
                this._getOrCreateConceptInstance(name, rawIdent);
              inst.identityLinks[name] = conceptInst;
              if (!linkTypesDefined) {
                classInfo.identityLinkTypes[name] = 'concept';
              }
            }
          }
          linkTypesDefined = true;
        }
      }
    }

    for (const { symName, traceDef, execs } of this.traceResultsMap.values()) {
      const classInfo = traceDef.classInfo;
      for (const exec of execs) {
        // Process identity data for links.
        //
        // If the class has its lifecycle tracked, then there won't actually be
        // any identity information attached to these trace entries, and so
        // instead we want to extract the "this" argument to create a
        // self-identity link from the execution to its instance.
        if (classInfo.trackLifecycle) {
          const thisPtr = extractThisPtr(exec.call);
          const thisPidPtr = makePidPtr(exec.call.meta.pid, thisPtr);

          const linkInst = this._getSemTypeInstance(
            classInfo.semType, thisPidPtr, exec.call.meta.entryMoment);
          exec.identityLinks[classInfo.semType] = linkInst;
        } else if (exec.data?.identity) {
          // XXX This logic is a mash-up from _deriveInstances and the above
          // and might benefit from refactoring for reuse, also maybe not.
          for (const [name, printed] of Object.entries(exec.data.identity)) {
            let rawVal = printed?.value?.data;
            let val;
            if (rawVal && rawVal.startsWith('0x')) {
              val = makePidPtr(exec.call.meta.pid, rawVal);
            } else {
              val = rawVal;
            }
            // XXX we're punting on the "concept" thing here; that likely wants
            // to be normalized before handling it here.
            const linkInst = this._getSemTypeInstance(
              name, val, exec.call.meta.entryMoment);
            exec.identityLinks[name] = linkInst;
          }
        }
      }
    }
  }

  /**
   * Establish a mapping from the moments observed in the trace onto a timeline
   * with the singular goal of establishing a useful density of events on the
   * timeline rather than having vast empty spaces between insanely dense
   * clusters of events.  The latter is what a naive mapping on "event"
   * establishes, which creates a bad UX as one must zoom way out only to zoom
   * way back in.  (This can be partially addressed by simultaneously
   * visualizing at both a global and local scale, but that doesn't actually
   * make the global scale useful.)
   *
   * We are explicitly not attempting to establish a mapping consistent with the
   * wall cock or with a global linearization over all instructions executed
   * (which would be the most realistic timeline), but if it turns out pernosco
   * provides a means of doing the latter, it would be useful to be able to
   * visualize time gaps and optionally project events onto their instruction
   * timeline.
   *
   * Disclaimer: All other analysis logic that is aware of time/sequences
   * currently continues to use moments.
   *
   * ## Process
   *
   * Building the mapping:
   * - All traced methods contribute their start and end moments to a list of
   *   known moments.
   *   - These are currently always extracted from the `call.meta.entryMoment`
   *     and `call.meta.returnMoment` (if present, I think it's moot), noting
   *     that these are actually extracted by the grokker from inside the
   *     focusInfo.frame.entryMoment, so the object identities should be
   *     equivalent there as well.
   *   - We currently don't want won't use the anyMoment or dataMoment, although
   *     they should usually be equivalent (but not the same object instance!).
   * - We sort the list.
   * - We assign sequential sequence id's to every moment which we call `SeqId`.
   *   - We currently don't bother to check for exact sequence equivalence
   *     because it seems like that shouldn't happen because different traces
   *     for the the same stack will inherently have different instruction
   *     positions.
   *   - We currently use a step size of 2 rather than 1 so that we can have a
   *     concept of a position between our known moments for pernosco moments
   *     that aren't from our known set.
   * - We build a big Map from the underlying moment objects to the sequence id
   *   because this is very easy to do without using a library.
   *
   * Using the mapping:
   * - We lookup any provided moment object in the Map.  This depends on object
   *   identities being maintained AKA only asking for a mapping of moments that
   *   were added in the prior step.
   * - We do also provide `mapMomentToSeqId` which performs a binary search to
   *   accomplish the mapping process.
   *
   * ## Context
   *
   * Pernosco's moments are defined as { event, instr } which seems to be a
   * deterministic event counter paired with an instruction counter that resets
   * whenever a new deterministic event occurs.
   */
  _establishTimeMapping() {
    const allMoments = this._allMoments;
    allMoments.sort(cmpMoment);

    const momentToSeqId = this.momentToSeqId;

    let seqId = 1;
    let lastMoment = null;
    for (let iMoment = 0; iMoment < allMoments.length; iMoment++) {
      const moment = allMoments[iMoment];
      momentToSeqId.set(moment, seqId);
      // Handle equivalent moments by assigning them the same sequence and
      // evicting them from the array.  (But we do want to have mapped them as
      // we've just done.)
      if (lastMoment && cmpMoment(lastMoment, moment) === 0) {
        allMoments.splice(iMoment, 1);
        // Don't accidentally skip a moment.
        iMoment--;
        continue;
      }
      lastMoment = moment;
      seqId += 2;
    }

    this.lastSeqId = seqId;
  }

  _learnMoment(moment) {
    if (moment) {
      this._allMoments.push(moment);
    }
  }

  mapMomentToSeqId(moment) {
    const idxLE = bounds.le(this._allMoments, moment, cmpMoment);
    if (idxLE === -1) {
      return 0;
    }
    // If it's an exact match for the moment, return the sequence id
    // corresponding exactly to the moment.
    if (cmpMoment(this._allMoments[idxLE], moment) === 0) {
      return idxLE * 2 + 1;
    }
    // Otherwise we want 1 more than that.
    return idxLE * 2 + 2;
  }

  /**
   * Populate VisJS group and item datasets.
   *
   * The current approach for grouping is:
   * - Create a group for each traced method on a per-TID basis.  We do this
   *   so that the group can hold the method label and we can
   */
  renderIntoVisJs(groups, items) {
    const momentToSeqId = this.momentToSeqId;

    let nextGroupId = 1;
    let nextDataId = 1;

    // A map from semType to a Map from `semLocalObjId` to group.
    const semTypeGroupMaps = new Map();
    const semGroupGetOrCreateForInstance = (semType, inst, startSeqId) => {
      let groupMap = semTypeGroupMaps.get(semType);
      if (!groupMap) {
        groupMap = new Map();
        semTypeGroupMaps.set(semType, groupMap);
      }

      let group = groupMap.get(inst.semLocalObjId);
      if (!group) {
        let groupId = nextGroupId++;
        let parentGroupId = null;
        let treeLevel = 1;
        let content = `<b>${semType}: ${inst.semLocalObjId}</b>`;

        // For now, only the first identityLink is used to be our group parent
        // and the rest gets stuck in the group content.
        if (inst.identityLinks) {
          let foundParent = false;
          for (const [name, linkInst] of Object.entries(inst.identityLinks)) {
            // linkInst may be null, in which case parenting is impossible and
            // we should fall back to just performing the labeling.
            //
            // TODO: Maybe the linkInst check should be inside the condition
            // here so that `foundParent` gets set to true so that null links
            // don't end up inconsistently being parented?
            if (!foundParent && linkInst) {
              const parentGroup = semGroupGetOrCreateForInstance(name, linkInst, startSeqId);
              parentGroup.nestedGroups.push(groupId);
              parentGroupId = parentGroup.id;
              treeLevel = parentGroup.treeLevel + 1;
              foundParent = true;
            } else {
              content += `<br>${name}: ${linkInst?.semLocalObjId}`;
            }
          }
        }

        group = {
          id: groupId,
          content,
          nestedGroups: [],
          treeLevel,
          parentGroupId,
          earliestSeqId: startSeqId,
        };
        groupMap.set(inst.semLocalObjId, group);
        groups.add(group);

        // If this is an instance with a lifetime (AKA non-concept), we want a
        // background item to express the lifeline of the instance.
        if (inst.constructionMoment) {
          const startSeqId = momentToSeqId.get(inst.constructionMoment) || 0;
          // If there's no end, just use 1 more than the sequence so it has some
          // duration.  This also kind/sorta works with our "between" space that
          // we build into the sequence space.  If this ends up weird it might
          // work to have the sequence gap be 2 instead of 1 (and placing the
          // between step at +2).
          const endSeqId = inst.destructionMoment ?
                            (momentToSeqId.get(inst.destructionMoment) || startSeqId) :
                            this.lastSeqId;

          items.add({
            id: nextDataId++,
            group: groupId,
            className: inst.destructionMoment ? 'instance-known-lifeline' : 'instance-unknown-lifeline',
            start: startSeqId,
            end: endSeqId,
            type: 'background',
          });
        }
      } else {
        if (startSeqId < group.earliestSeqId) {
          group.earliestSeqId = startSeqId;
        }
      }
      return group;
    }

    // We assign each method to its own group so that all the calls to a single
    // method can end up in a single track/swim-lane *under its parent group*.
    // This gets keyed by "{parent group id or ROOT}-{method name}-{thread id}".
    const methodTrackMap = new Map();

    for (const { symName, traceDef, execs } of this.traceResultsMap.values()) {
      let methodName = shortSymbolName(symName);
      for (const exec of execs) {
        const startSeqId = momentToSeqId.get(exec.call.meta.entryMoment);

        let contentPieces = [];
        if (exec.data?.capture) {
          for (const [name, item] of Object.entries(exec.data.capture)) {
            const useName = (item.name === "???") ? name : item.name;
            if (item.value && item.value.data) {
              contentPieces.push(`${useName}: ${item.value.data}`);
            }
          }
        }
        if (exec.data?.classState) {
          for (const [name, item] of Object.entries(exec.data.classState)) {
            const useName = (item.name === "???") ? name : item.name;
            if (item.value && item.value.data) {
              contentPieces.push(`${useName}: ${item.value.data}`);
            }
          }
        }

        let identityGroup = null;
        for (const [name, linkInst] of Object.entries(exec.identityLinks)) {
          if (!identityGroup && linkInst) {
            identityGroup = semGroupGetOrCreateForInstance(name, linkInst, startSeqId);
          } else if (linkInst) {
            // Actually this maybe wants to induce additional tupling?
            contentPieces.push(`${name}: ${linkInst.semLocalObjId}`);
          }
        }

        // Create the dedicated swimlane group for the method for the thread
        let trackUniqueId;
        if (identityGroup) {
          trackUniqueId = `${identityGroup.id}-${methodName}-${exec.call.meta.tid}`;
        } else {
          trackUniqueId = `ROOT-${methodName}-${exec.call.meta.tid}`;
        }
        let trackGroup = methodTrackMap.get(trackUniqueId);
        if (!trackGroup) {
          trackGroup = {
            id: nextGroupId++,
            // Note: Ideally we could use `subgroupStack` to control stacking of
            // items in this group... but this doesn't work, so we're now having
            // the top-level options "stack" be set to false.
            content: `${methodName} : ${exec.call.meta.tid}`,
            treeLevel: identityGroup ? identityGroup.treeLevel + 1 : 0,
            parentGroupId: identityGroup ? identityGroup.id : null,
            earliestSeqId: startSeqId,
          };
          methodTrackMap.set(trackUniqueId, trackGroup);
          groups.add(trackGroup);
          if (identityGroup) {
            identityGroup.nestedGroups.push(trackGroup.id);
          }
        } else {
          if (startSeqId < trackGroup.earliestSeqId) {
            trackGroup.earliestSeqId = startSeqId;
          }
        }

        
        // If there's no end, just use 1 more than the sequence so it has some
        // duration.  This also kind/sorta works with our "between" space that
        // we build into the sequence space.  If this ends up weird it might
        // work to have the sequence gap be 2 instead of 1 (and placing the
        // between step at +2).
        const endSeqId = exec.call.meta.returnMoment ? momentToSeqId.get(exec.call.meta.returnMoment) : (startSeqId + 1);

        let dataId = nextDataId++;
        items.add({
          id: dataId,
          group: trackGroup.id,
          content: contentPieces.join('<br>'),
          // For layout purposes the point doesn't avoid stacking and in fact
          // ends up misleadingly larger than many ranges with our normal time
          // mapping, so we use a range even for a same-sequence id situation.
          type: (startSeqId !== endSeqId) ? 'range' : 'range',
          start: startSeqId,
          end: endSeqId,
          extra: {
            focus: exec.call.meta.focusInfo,
          },
        });
      }
    }

    // XXX it seems like we may need to reorder the groups to get the hierarchy
    // to show up correctly?
  }
}

export async function loadAnalyzer(paths) {
  const configs = [];

  for (const path of paths) {
    const resp = await fetch(path);
    if (resp.status !== 200) {
      console.error('Problem fetching', path, 'got', resp);
      continue;
    }
    const respText = await resp.text();
    const config = new AnalyzerConfig(respText, path);

    configs.push(config);
  }

  return new Analyzer(configs);
}
