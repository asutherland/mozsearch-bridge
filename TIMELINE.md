General thoughts on a timeline visualization mechanism.

## Used Approaches

### vis.js timeline

This is the current state of the art and widely adopted.

Primary issues as used (and not necessarily the fault of vis.js):
- Fixed time scale is inflexible in the face of wildly varying event densities.
  - Pernosco's concept of time is somewhat nebulous to begin with, of course,
    but a significant problem is that events will periodically be extremely
    bursty.
  - There is a clustering mechanism which can help mitigate this problem:
    - Cluster formation is extensible via comparator, allowing facet-style
      clustering (same function, same captured variables) to occur.  An
      enhancement might be necessary to provide computed content for the
      clusters.
      - A limitation here is that the timeline doesn't support visualizations
        that would help capture what's going on inside the cluster.
- Layout instability:
  - Groups as initially implemented use auto-sizing based on the visible
    elements.  As the timeline is scrolled and events appear and disappear, the
    groups accordingly are reconfigured almost constantly.
    - There are fixed-height modes available, but the reality is that with
      uniform scaling that's readable, there will usually be insufficient screen
      real estate for this.
  - Event layout similarly is completely different when zooming in and out.

## General Proposal

Core ideas:
- First-class faceting along multiple axes:
  - Events can be hierarchically organized in multiple hierarchies
  - Summaries/digests/clusters can then be derived as more useful than just
    a zoomed out useless timeline.
- Small multiple visualizations as digests
- Compressed non-time axis scaling for not currently focused/relevant things
  to provide context.
- Optionally non-uniform scaling of time; place events sequentially, perhaps
  with summaries of currently believed boring things that happen in between
  current interesting things.
