import { openDB } from 'idb';
import { cmpMoment, extractFocusMoment, inMomentRange } from '../pmlgrok/utils';

export class IDBCacheHelper {
  #db;
  #traceName;

  constructor({ traceName }) {
    this.#traceName = traceName;
    // Initially have this be a promise that resolve to the database; we'll
    // clobber it to directly be the database after.
    this.#db = this.#openDB();
  }

  // Async opening of this.#db kicked off by the constructor.  There's no need
  // to ever call this otherwise.
  async #openDB() {
    if (this.#db) {
      return this.#db;
    }

    // We assign the promise to this.#db immediately so other methods can await
    // this.#db at any time after this method goes async.
    const openPromise = this.#db = openDB("pernosco-cache", 1, {
      upgrade(db, oldVersion, newVersion, transaction, event) {
        // The cache store uses separate keys with scheme:
        // [traceName, type, name, [specific params...]]
        // where the specific params are consistently chosen by
        // `#extractNamingKeyFromPayload` and will generally be tupled over the
        // type and (payload.)name.
        //
        // All records have the following structure:
        // - lastUpdated: A JS timestamp corresponding to when the store request
        //   was made.  An index is populated based on this to allow for LRU
        //   eviction of the cache (eventually)
        // - lastUsed: A JS timestamp tracking when this query was last used,
        //   also indexed.
        // - results[]: An array of {type, payload, result, hitCount, missCount,
        //   lastUsed}.
        //   This allows for caching multiple queries for a single key
        //   to handle larger traces where the range query hit the limit and we
        //   can't just return the results we have across all focus values.
        const cacheStore = db.createObjectStore("cache");
        cacheStore.createIndex("lastUpdated", "lastUpdated");
        cacheStore.createIndex("lastUsed", "lastUsed");
      },
    });
    // And now we clobber this.#db with the actual
    this.#db = await openPromise;
    return this.#db;
  }

  // Return an array of characteristic parameters for the given type + payload.
  // We need the client in order to extract the current focus which some queries
  // use implicitly.  (The injected logic mixes the current focus in by default,
  // but some queries then clobber it with a mix-in.)
  #extractNamingKeyFromPayload(client, type, payload) {
    // Notable aspects of focus:
    // { frame, moment: {event, instr}, node, tuid }
    // Note that the statusReport also has `source` with:
    // { fileName, lang, pos, url, withCreds}
    let focus = payload?.mixArgs?.focus || client?.statusReport?.focus;
    if (!focus) {
      console.log("no focus available, unable to derive cache key", payload, client.statusReport);
      return undefined;
    }
    const momentKeys = [focus.moment.event, focus.moment.instr];

    const name = payload?.name;
    if (!name) {
      console.log("no payload name, unable to derive cache key", payload);
      return undefined;
    }

    // ## rangeQuery
    if (type === "rangeQuery") {
      // All rangeQuery requests use the current client focus but we don't need
      // to key on that in most cases since we can check the value and figure out
      // if we hit a limit or not.

      // rangeQuery {name: "execution"} is specifically characterized by the
      // params { symbol, print[] }.
      if (name === "execution") {
        const params = payload.mixArgs.params;
        return [params.symbol, ...(params.print || [])];
      }

      if (name === "breakpoint") {
        const params = payload.mixArgs.params;
        return [params.url, params.points[0].l, params.points[0].c, ...(params.print || [])];
      }

      // rangeQuery {name: "stdouterr"} has no extra params
      if (name === "stdouterr") {
        return [];
      }

      // rangeQuery {name: "microdiversionsLog"} has no extra params
      if (name === "microdiversionsLog") {
        return [];
      }

      // rangeQuery {name: 'watchpoint'} has mixArg params of { address, type }
      // where address and type are strings like "0xADDR" and "uint32_t".
      if (name === "watchpoint") {
        const params = payload?.mixArgs?.params;
        return [params?.address, params?.type];
      }
    }
    // ## simpleQuery
    else if (type === "simpleQuery") {
      // simpleQuery {name: "stack"} is extremely dependent on the current client
      // focus so we absolutely include the current focus as part of the key.
      if (name === "stack") {
        return momentKeys;
      }

      // simpleQuery {name: "current-tasks"} is extremely focus-dependent.
      if (name === "current-tasks") {
        return momentKeys;
      }

      // simpleQuery {name: "task-tree"} I think is not focus-dependent?  It's all
      // tasks.  So we can avoid keying it.
      if (name === "task-tree") {
        return [];
      }

      // simpleQuery {name: "evaluate"} has 2 variations:
      // 1. mixArgs.payload.data is present, in which case data is a
      //    { producer, renderer } pair.  This is used for the "deref" mechanism
      //    we haven't used since initial development (where the data just comes
      //    from pml) and the also older derived `queryMemory` helper that tries
      //    to emulate that.  For `queryMemory` we synthesize only a memory
      //    producer that looks like { memory: { addressSpace, padWithUnmapped,
      //    ranges: [{end, start}]}}.
      // 2. The source view hovering case containing {focus, expression, context}
      //    where context is [source URL, { offset }] and where the server needs
      //    us to provide it with byte offsets so we send line, column info as
      //    {l, c} but our injected bridge uses some more pernosco UI logic to
      //    convert that to an offset that the server is okay with.
      //
      // In all cases we absolutely do need the focus moment.
      //
      // has a runtime dependence on mixArgs focus
      // (explicit, not implicit) and payload {context[]} where index 0 is the
      // source path and index 1 is (going in,
      // it gets normalized in the injected logic) an object {l, c}.  We encode
      // all of the source path, line, and column for now because it lets us
      // differentiate between the different stack frames that exist for a given
      // moment.  But maybe we should be extract other specifics of the frame from
      // the payload?
      //
      // also  mixArgs.payload.data.producer.memory.{start,end}.
      // XXX sanity chck uses of `queryEvaluate`, definitely `querySearchEvaluate`
      // `queryEvaluateAndWatch` which invokes builEvalPayload
      if (name === "evaluate") {
        const evalPayload = payload?.mixArgs?.payload;
        const memory = evalPayload?.data?.producer?.memory;
        if (memory) {
          return [...momentKeys, memory.start, memory.end];
        }

        if (evalPayload.expression && evalPayload.context) {
          const context = evalPayload.context;
          return [...momentKeys, evalPayload.expression, context[0], context[1].l, context[1].c];
        }

        return undefined;
      }

      // simpleQuery {name: "search"} is characterized by mixArgs of
      // { focus, input } and we're ignoring { maxResults } for now.
      if (name === "search") {
        return [...momentKeys, payload.mixArgs.input, payload.mixArgs.maxResults];
      }
    }

    return undefined;
  }

  // Asynchronously see if we have results cached for the given query.
  // `undefined` will be returned for uncacheable values and `null` for cases
  // where we can cache results but we don't currently have any results.
  async lookup(client, type, payload) {
    const namingKey = this.#extractNamingKeyFromPayload(client, type, payload);
    // Nothing to do if we can't derive a cacheable key.
    if (namingKey === undefined) {
      return namingKey;
    }

    const key = [this.#traceName, type, payload.name, namingKey];

    const db = await this.#db;

    const store = db.transaction("cache", "readwrite").objectStore("cache");
    const record = await store.get(key);
    if (!record) {
      console.log("no existing cache entry for key:", key);
      return null;
    }

    const isRangeQuery = (type === "rangeQuery");

    const now = Date.now();
    record.lastUsed = now;
    let useResult = null;
    if (isRangeQuery) {
      const requestMoment = payload?.mixArgs?.focus?.moment || client?.statusReport?.focus?.moment;

      for (const result of record.results) {
        // If we didn't hit a limit, we can just use the first result we find.
        if (!result.limitHit) {
          useResult = result;
          // This should also generally be our only result but if we parallelize
          // requests it also seems conceivable that we could end up with
          // duplicated results... let's warn though so we can be aware.
          if (record.results.length > 1) {
            console.warn("More than one set of results without limit hit:", record);
          }
          break;
        }

        // So if limits were hit, our options are:
        // 1. Only reuse on exact-match.
        // 2. Declare some portion of the limit an acceptable slippage for a given
        //    request.  Like if our request's focus is within 25% of the limit
        //    from the "center" (we can use extra.beforeCount or afterCount to
        //    quickly know this), then we can just reuse that.  And we don't even
        //    need to binary search since it's just a question of ensuring the
        //    request focus is within the range defined by the results at those
        //    points.

        const resultMoment = result.extra.focusMoment;

        // Option 1 fast path; this is an exact moment match.
        if (cmpMoment(requestMoment, resultMoment) === 0) {
          useResult = result;
          break;
        }

        // Check the ranges.
        const slippage = Math.floor(result.extra.limit * 0.25);
        const startIndex = Math.max(0, result.extra.beforeCount - slippage);
        const endIndex = Math.min(result.results.length - 1, result.extra.beforeCount + slippage);

        const startMoment = extractFocusMoment(result.results[startIndex]);
        const endMoment = extractFocusMoment(result.results[endIndex]);

        if (inMomentRange(startMoment, resultMoment, endMoment)) {
          useResult = result;
          break;
        }

        result.missCount += 1;
      }
    } else {
      useResult = record.results[0];
    }
    if (useResult) {
      useResult.hitCount += 1;
      useResult.lastUsed = now;
    } else {
      console.log("existing cache entry has no hits", record);
    }

    // We intentionally don't wait for this write to complete.
    store.put(record, key);

    if (useResult) {
      return useResult.result;
    } else {
      return null;
    }
  }

  // Cache the result for the given query, if possible.  The return value
  // indicates whether the value was able to be cached for informative purposes.
  async store(client, type, payload, newResult, extra) {
    const namingKey = this.#extractNamingKeyFromPayload(client, type, payload);
    // Nothing to do if we can't derive a cacheable key.
    if (namingKey === undefined) {
      return false;
    }
    const key = [this.#traceName, type, payload.name, namingKey];

    const db = await this.#db;

    const store = db.transaction("cache", "readwrite").objectStore("cache");
    let record = await store.get(key);

    // Save a single 'now' timestamp for consistency in fields below.
    const now = Date.now();


    const isRangeQuery = (type === "rangeQuery");
    let limitHit = isRangeQuery && (extra.beforeCount >= extra.limit || extra.afterCount >= extra.limit);

    const resultEntry = {
      type,
      payload,
      result: newResult,
      extra,
      limitHit,
      hitCount: 0,
      // How many times did we have this value in the DB but it wasn't useful?
      missCount: 0,
      lastUsed: now,
    };

    // Do we already have results that we want to add this result to?
    if (record) {
      // TODO: consider eviction here; for now we'll just always append.
      record.results.push(resultEntry);
    } else {
      record = {
        lastUpdated: now,
        lastUsed: now,
        results: [resultEntry],
      };
    }

    // XXX for now we await the put to see any exceptions, but we don't really
    // need to.
    await store.put(record, key);

    return true;
  }
}
