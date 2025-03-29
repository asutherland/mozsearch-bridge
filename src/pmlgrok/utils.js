
export function cmpMoment(a, b) {
  if (!a || !b) {
    if (b) {
      return 1;
    }
    if (a) {
      return -1;
    }
    return 0;
  }

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

export function inMomentRange(startMomentInclusive, checkMoment, endMomentInclusive) {
    // If our data is bad just return false.  We are expecting
    // `extractFocusMoment` to be the thing that would log a warning with better
    // context so we don't return anything here, just do a safe thing.
    if (!startMomentInclusive || !endMomentInclusive) {
        return false;
    }
    if (cmpMoment(checkMoment, startMomentInclusive) < 0) {
        return false;
    }
    if (cmpMoment(checkMoment, endMomentInclusive) > 0) {
        return false;
    }
    return true;
}

// Given a result row from a query, try and find a focus and return its moment.
// We currently expect the argument to have a structure of
// `{ items: [ { focus, pml } ] }` but I haven't refreshed my understanding of the
// permutations from `grokker.js` so we're going to add some warnings and we can
// do a pass if we see those.
export function extractFocusMoment(rowOrPml) {
    const maybeFocus = rowOrPml?.items?.[0]?.focus;
    if (maybeFocus) {
        console.warn("No known focus found in", rowOrPml);
        return null;
    }
    return maybeFocus.moment;
}
