# View admission (#13)

The real renderer uses `MAX_RENDER_JOBS` worker threads (environment setting,
default 2). At most ten additional distinct cache misses may wait. A nonblocking
admission permit is held from submission until the worker finishes, including
failure paths. A new miss beyond that capacity returns HTTP 429 with
`Retry-After: 2` and the existing `{error: {code, message}}` shape (`QUEUE_FULL`).
Rejected requests do not leave queued jobs. A submission failure leaves a
terminal `PIPELINE_ERROR` record, releases capacity and returns HTTP 503; a later
POST can retry it. Renderer failures likewise release capacity and remain visible
through the existing job-status endpoint. Normal misses return 202; completed
cache hits return 200; invalid inputs still return 422.

Existing in-flight requests and ready memory/persistent cache hits are accepted
even while render admission is full. Persistent-cache lookup happens outside the
global jobs lock; admission and a second deduplication check happen together under
that lock, so concurrent identical misses submit only one renderer.

These limits apply to POST-driven render jobs within one backend process. They
do not bound retained terminal-job memory or cached disk/blob storage. Measurement
rebuilds remain synchronous and are outside this queue. No hard interruption of
Python worker threads or whole-job deadline is implemented. Keep one production
replica while job state remains process-local; existing archive transport bounds
remain in place.
