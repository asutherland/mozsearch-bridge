# Specific Useful Visualization Things

## Bug 1594572
https://bugzilla.mozilla.org/show_bug.cgi?id=1594572

### Situation

#### The Problem
A worker is being instantiated and this is potentially happening at a time that
potentially races shutdown.

#### Immediate Investigation Performed
- Executions of `WorkerPrivate::Constructor`
  - aScruptURL isn't getting dumped as a string.  Although it appears the first
    character is, so it could be getting freaked out by the char16_t?
- Executions of `RuntimeService::Shutdown`... never invoked.
- Executions of `WorkerPrivate::Notify`
- Executions of `WorkerPrivate::NotifyInternal`
- Executions of `nsObserverService::NotifyObservers`
  - The aTopic does pretty print and it is nice.
  - This is a situation that's screaming for faceting, however, as immediately
    I see like a zillion "flush-cache-entry",
    "cycle-collector-forget-skippable", and "image-drawing" occurrences which
    then get capped by the more/more manual virtual list doodads.
    - I have tricelog UI code for this already from grokysis to consume gdb
      gaudy tricelog output.  Should probably just bridge grokysis next.

#### Useful Context
- Overall lifecycle of the process.
  - Timeline with process having ambiently marked startup/shutdown phases from
    observer service.

#### Useful Details
