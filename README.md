mozsearch-bridge is an experimental web-extension that aspires to integrate
mozsearch ("searchfox") with other fundamental Firefox developer tools:
pernos.co ("pernosco") and the Firefox Profiler.  It is the evolution of a
prior, even more experimental tool "pernosco-bridge".

The workflow of the extension is:
- The extension becomes activated by by clicking its action button when the
  current tab is a pernos.co tab.  This makes the current pernos.co session the
  active session and will:
  - Open a new tab with a "simple" UI that is bound to that pernos.co session.
  - Dynamically activate searchfox integration by [dynamically registering a content script](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/registerContentScripts).
    These will be told to clean up after themselves and the content scripts will
    be [dynamically unregistered](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/unregisterContentScripts)
    if the pernos.co tab is closed or navigated.
- When the extension is active, new context menu items will be added to
  searchfox.  Note that currently the WebExtension only works with the
  experimental https://asuth.searchfox.org/ and accordingly only requests
  permissions for that domain.

## Implementation Details

### Communication

## Building

Currently [web-ext](https://www.npmjs.com/package/web-ext) is used for
packaging and it is expected that it will be installed globally.  It's not
installed as a dev dependency because the number of dependencies it pulls in is
terrifying and makes it harder for someone to reasonably audit what this
extension does.
