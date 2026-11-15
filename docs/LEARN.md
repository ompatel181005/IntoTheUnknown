# Learn, observe, check, share (#66)

`/learn.html` is a separate production entry. It uses only the bundled Barnard,
RW Aur and WISE 0855 manifests, float arrays and masks via `api.fetchAsset`.
It never submits a view build or falls back to an astronomy archive. In
particular, WISE uses its actual saved manifest coordinates. The advanced-viewer
link uses that manifest query.

The lesson selector and language do not reload the page. Language, activity,
visit and optional scientific-grid pixel are encoded in the URL. Selection is
an annotation, never photometry, object identification or a scored answer.
All epochs use the existing shared asinh stretch and north-up row convention.

Observation PNGs contain actual rendered saved arrays, the observation windows,
wavelength ranges and input counts, the learner's annotation when present,
explicit evidence limits, data attribution and the reproducible lesson URL.
They use no external image/QR service. The learner's self-reported response is
not stored or described as a scientific result.

Only Barnard's saved-sequence motion has independent validation. RW Aur's
activity teaches wavelength comparability; WISE 0855 teaches uncertainty and
does not claim a validated detection. Raw pipeline flag names are retained;
their mean input-pixel counts are explained and are not object counts.

English, Spanish and Hindi packs cover the entire learning flow. Spanish and
Hindi are initial translations and have not received human/native-speaker
review. Proper names, mission names, units and pipeline flag codes remain in
their original forms. The advanced viewer retains English controls.

Checks: `npm ci`, `npm run lint`, `npm run build`, and
`node --test tests/learn.test.mjs` from `frontend/`. The pure tests exercise URL
validation, FITS/canvas orientation, real-manifest metadata and translation
coverage. Browser QA should additionally exercise keyboard annotation,
320–390 px layouts, all languages, failed clipboard/download handling, blocked
API/archive requests and actual PNG download.
