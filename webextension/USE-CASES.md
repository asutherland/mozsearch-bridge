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

# Specific Data to Extract

## Clients API

### Clients List

Right now `sClientManagerServiceInstance->mSourceTable` will get us the source
table but pernosco doesn't inherently know how to pretty print its contents.

Hashtable digging:
- At the timestamp corresponding to https://pernos.co/debug/U3Q4v_1wxjdpsFmKDDiyYw/index.html#f{m[AhK5,JX6P_,t[AQ,AcZJ_,f{e[AhK5,JX6G_,s{afzE0NZAA,bAXk,uGCPl8A,oGD6nPA___ on
  TransmitBlobURLsForPrincipal in the frame, we're sampling the above.
- mEntryStore.mEntryStore is 0x7f3116403000
  - With a capacity of 64 that means there should be 64 * 32 bytes of hash,
    meaning the data should be at: 0x7f3116403800
- mHashShift is 26, which implies capacity is 1 << (32 - 26) == 64
- mEntryCount is 22 which seems reasonable
- mEntrySize is 24 which should be covered by the entry type payload
  - In this case we know from the producers that the type is:
    `nsBaseHashtableET<nsIDHashKey, mozilla::dom::ClientSourceParent *>`

#### Frame probing

"entry":
- `p &entry` gets us: 0x7f312a97d908 139849144719624

"this":
- `p this`: (mozilla::dom::ClientManagerService *) 0x7f312f35a400
- pernosco dump is indeed: 0x7f312f35a400  139849222169600

Okay, so success-ish:
- Our memory dump got us 0x7f313ea79cf0
  - gdb x/g got us:  0x00007f313ea79cf0
  - terrifyingly, pernosco seems to actually know the name/type of the memory
    location?

Other notes:
- If we ask for 16 bytes but give it to the 64-bit pointer renderer, we still
  only get the pointer back.
- The "explorable" mechanism for this seemed to work by taking the "data" for
  the LHS (which had a dwarfType renderer) and deref-ing it, versus the RHS
  which was just a rendered pointer.


YAYYYYY!

      "a": {
        "data": {
          "producer": {
            "memory": {
              "addressSpace": {
                "execs": 1,
                "task": {
                  "serial": 1,
                  "tid": 116297
                }
              },
              "padWithUnmapped": 88,
              "ranges": [
                {
                  "end": 139849222169688,
                  "start": 139849222169600
                }
              ]
            }
          },
          "renderer": {
            "dwarfType": {
              "deref": {
                "level": 0
              },
              "type_": {
                "baseAddress": 139849306050560,
                "binary": 377,
                "type": {
                  "f": "m",
                  "o": 290788923
                },
                "unit": 290780890
              }
            }
          }
        },
        "dataMoment": {
          "event": 6223,
          "instr": 21605
        }
      },

## Blobs

