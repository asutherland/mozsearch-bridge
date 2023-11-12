
# Workers

mozilla::dom::workerinternals::(anonymous namespace)::WorkerThreadPrimaryRunnable::Run

mozilla::dom::WorkerGlobalScope::ImportScripts

mozilla::dom::ServiceWorkerPrivate::CheckScriptEvaluation
mozilla::dom::CheckScriptEvaluationOp::ServiceWorkerOp

## Not really useful.
mozilla::dom::ServiceWorkerOp::ServiceWorkerOp


## maybe

# Redirect

See the worker lifetimes:
- mozilla::dom::workerinternals::(anonymous namespace)::WorkerThreadPrimaryRunnable::Run

See the JS exceptions be thrown:
- mozilla::binding_danger::TErrorResult<mozilla::binding_danger::AssertAndSuppressCleanupPolicy>::ThrowJSException

See the filenames with which EvaluateScriptData is called:
- the invocations happen inside a loop in:
  mozilla::dom::(anonymous namespace)::ScriptExecutorRunnable::WorkerRun
- I picked line 2128 just after NS_ConvertUTF16toUTF8 filename(loadInfo.mURL);
  which gets us the fiename quite nicely.
- But perhaps EvaluateScriptData works too?
  mozilla::dom::(anonymous namespace)::EvaluateScriptData<mozilla::Utf8Unit>
  - No, everything got optimized out... maybe because of templates.
- More in the JS layer:
  JS::Evaluate

See the DOM events being dispatched:
- mozilla::EventDispatcher::DispatchDOMEvent

See worker error reporting:
- mozilla::dom::WorkerErrorReport::ReportError

See WorkerRunnables executed (on the main thread?)
- (...) WorkerRunnable::Run

## Awesome "print" results

`uri.mRawPtr->mSpec`
- This works!  uri was a `nsCOMPtr<nsIURI> uri` and it worked!

## Useful things that could be done:
- Create containment relationship for things that live inside the
  WorkerThreadPrimaryRunnable to create an explicit group.
  - Locate the top-level compile runnable and locate the root script, use this
    to name the worker.

- Causality tracing of runnables.
  - There is now somewhat a plurality of dispatch methods, but there are
    invocations of nsIEventTarget::Dispatch and most accesses should be through
    XPCOM, so this could trace the aEvent.
    - How to express in the timeline?
      - A "ghost" event could express that the runnable is in the queue which
        should avoid layout complexities and also provide space for the
        runnable's meta/data to be displayed near the point of spawning.
