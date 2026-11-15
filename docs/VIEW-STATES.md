# View metadata and recovery (#21)

The pass drawer reports the actual manifest's UTC start/end window, input frame
count, wavelength range, detector IDs, collection names and alignment scatter.
`astrom_resid_px` is per-axis reference-star centroid scatter, not target-position
uncertainty. Null, missing or nonfinite values say “Not measured”; zero remains a
reported zero. Input flag counts are rounded means per input frame, overlap across
categories and must not be added into a unique-pixel/object count.

Source labels describe loaded data. The frontend marks actual bundled golden
loads as saved snapshots; cached backend renders remain distinct from new renders
built from saved cutouts. Archive-sourced data does not imply current connectivity,
and an IRSA label does not establish each cutout's transport.
No health request is added: default saved presets still need no API calls.

One epoch explicitly says motion needs at least two. Zero selected epochs means
no usable passes for this selection; it does not prove the archive lacks coverage.
Queue saturation has a distinct 429 state, while archive-down and unavailable
saved coverage receive separate explanations.

On a failed request at exact known preset coordinates, an explicit recovery link
can open that preset's saved default. The link carries the actual default position,
FOV, band and target ID, sets `src=saved`, and resets epoch/reference/selection.
It never silently substitutes a saved image for another requested patch. For a
custom position without an exact match, the user can choose saved learning
examples. Showing a cached image does not itself assert an archive outage.
An editable URL target ID labels the header/details only when its coordinates
also match the preset; a mismatched field is labeled Custom position.

Checks from `frontend/`: `npm ci`, `npm run lint`, `npm run build`,
`node --test tests/view-states.test.mjs`, `node --test tests/learn.test.mjs`,
and `node --experimental-vm-modules --test tests/loading.test.mjs`.
Browser QA: mock QUEUE_FULL/429 and IRSA_DOWN, follow recovery with API requests
denied, test single/empty epochs and null scatter on desktop/mobile, then load all
five real defaults with API requests denied. Before taking a success screenshot,
require canvas `data-ready=true`, all ancestor opacities at least 0.99, and some
nonzero rendered RGB pixels. A mounted transparent canvas is not a rendered view.
The reproducible browser runner is `tests/view_states_browser.py`; it expects a
local production preview on port 5191 and a Python environment with Playwright.
For example, `python tests/view_states_browser.py` after starting
`npm run preview -- --host 127.0.0.1 --port 5191`. Its screenshots/results go under
ignored `frontend/screenshots/view-states/`.
