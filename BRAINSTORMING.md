## Evaluation

### Known Mechanisms

There seemed to be 2 variants of "evaluate" queries produced by the UI:
1. Regurgitation of a PML {producer,renderer} data payload provided by PML that
   had not been fully expanded.
2. Source hover magic.

There is also the "print" mechanism which seems like it's probably the easiest
way to get at any data we want at specific function timestamps.

### Motivating Pernosco Reproductions

- https://bugzilla.mozilla.org/show_bug.cgi?id=1615164
  - pernosco trace: https://pernos.co/debug/ssNhDU_d-ff50MxrRj-ITA/index.html
  - Initial presumption was that the ServiceWorker was getting spawned twice
    and the script load request each time was the same (failure), but changed
    fixed.
  - So we might want to highlight:
    - ServiceWorkerPrivateImpl life-cycle (coming into existence), event sending
    - ServiceWorkerInfo state changes.  (Which covers the ServiceWorker state
      more in general.)
    - Known ServiceWorkerRegistrations & ServiceWorkerInfo states on those.
    - importScript calls, logged, scoped to the worker.
    - The activities of the scriptloader.

### Desired Use-Cases

- Getting a lay of the land for specific subsystems:
  - See the high level things happening control-flow wise
    - This could also include inferred state if the methods are able to be
      mapped to a basic simplified model.
      - Like request actors being created and being destroyed making boxes that
        show the stack of pending requests, etc.
  - Display a representation of the current set of live objects
    - Window hierarchy would be great. (window/iframes)
    - With diffs.  Show the high level overview of state, but with focus on the
      details of what changed between different points in time.
      - For example, added ServiceWorker registration... a new ServiceWorker
        binding being added in the "installing" state, its advancing state each
        time.
- More specific pretty-printing/visualization of complex things.
  - nsString (non-C-string) pretty printing
    - The easiest thing is likely to just request that pernosco implement this.
    - If done manually, the "memory"/"subrange" mechanism could potentially
      produce this, but that assumes that a renderer exists that can expose the
      raw bytes... need to find that, and it's not clear it exists.
- Trace A/B analysis.  Given methods of interest, do the chroniquery thing where
  different control flows visually present differently.

### Possible Next Steps

- Focus on using the "print" mechanism for calls as a means of base
  introspection.
  - This can potentially provide the type 1 regurgitate-able evaluations.
  - This avoids getting in to too much moment stuff.
  - This is the most straightforward existing use-case and means to pitch
    further pernosco enhancements to support this.
- Focus on using the hover mechanism and searchfox's potential knowledge of
  source/token location lines to help provide a way to get to desired symbols.


#### Chroniquery style function call summarizations based on control flow
- The "annotation" query mechanim's "highlightLine" for "didExecute" returns a
  set of lines which can be treated as different control flow paths.
