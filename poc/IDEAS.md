
# General Technique Thoughts

## Pretty printing

- It might be possible to use one-off gdb queries via python injection to
  extract the relevant type information to make JS pretty printing easier.
  - Noting that pernosco clearly already knows all the info, and its flattening
    may already be sufficient anyways.
  - One reason to do this might be to allow a gdb bridge as the normal baseline.
    But driving gdb through pernosco is probably highly redundant and
    inefficient.

## Thread lifetimes / ownership hierarchy
Timeline where spans are thread lifetimes and have parent/child relationships
with offspring.

Probably only useful as an overview with grouping by clusters, and in general
use would want to be a data-source that gets sliced down to the currently
participating threads.  A dual of this situation would be where the threads
become groups with the general thread lifecycle conveyed via background area.
