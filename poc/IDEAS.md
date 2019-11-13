## Pretty printing

- It might be possible to use one-off gdb queries via python injection to
  extract the relevant type information to make JS pretty printing easier.
  - Noting that pernosco clearly already knows all the info, and its flattening
    may already be sufficient anyways.
  - One reason to do this might be to allow a gdb bridge as the normal baseline.
    But driving gdb through pernosco is probably highly redundant and
    inefficient.
