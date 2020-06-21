Steps:

0. Read the CSP section below.
1. npm install
2. npm start
3. copy and paste the bookmarklet that the server spits out and run it in a pernosco window
4. browse to http://localhost:3333/simple.html
5. Do one of:
  - type a fully qualified symbol into the text field and click "Show Symbol Executions"
  - click "Show Current Tasks"
6. see result stuff

### CSP

The Pernosco UI now has a thorough CSP config.  Firefox's bookmarklet magic does
not create a privileged content script sandbox like webextensions uses, so
there's no way for the bookmarklet to actually accomplish its task with CSP
enabled unless the bridge is explicitly allowed by the CSP.

Setting `security.csp.enable` to false in `about:config` is the workaround for
this, but you should only do this in a dedicated Firefox profile that you use
only for this purpose.  You probably already want to be doing this because the
rest of pernosco-bridge's magic is likely to do things that will destabilize
your browser through excessive memory and/or CPU use.

Less wildly ill-advised approaches to this situation are:
1. Move the bridge into a WebExtension.
2. Create a TamperMonkey/GreaseMonkey script that can leverage the webextenion
   runtime which they run under.
3. Have Pernosco explicitly add CSP carve-outs.

The WebExtension path is likely the right one for productization.  TamperMonkey
might make sense for pernosco-bridge helping people try their own experiments.

My tentative plan is to pursue the WebExtension path as part of a Searchfox web
extension.