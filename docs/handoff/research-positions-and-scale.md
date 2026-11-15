## 1. Planet ephemerides

Compared with JPL Table 1 (1800–2050), all 48 element/rate values in `PLANETS` are exact, including the Earth–Moon barycenter values used as “Earth.” The orbital-plane coordinates and J2000 ecliptic rotation matrix are also correct. [JPL table and algorithm](https://ssd.jpl.nasa.gov/planets/approx_pos.html)

| Check | Finding |
|---|---|
| Time argument | Numerically correct Julian centuries from UTC Unix time, but JPL specifies JDTDB. UTC instead of TDB produces only a tiny display error; use an explicit JD(TDB) if claiming strict algorithm fidelity. |
| Mean anomaly | Correct for Table 1: \(M=L-\varpi\). Wrapping to `[0,2π)` rather than JPL’s `[-π,π]` is mathematically equivalent. |
| Kepler solver | Correct radian form and Newton iteration. Eight iterations are ample. |
| Orbital coordinates | Correct \(x'=a(\cos E-e)\), \(y'=a\sqrt{1-e^2}\sin E\). |
| J2000 ecliptic rotation | Correct, term-for-term with JPL. |
| Orbit paths | Bug: adding `dM` after wrapping can exceed \(2π\), but the solver remains periodic and converges here. Normalize before solving for robustness. |
| Validity | Current date 2026 is within 1800–2050. No Table 2b correction belongs with Table 1. |

## 2. Target astrometry

Coordinates below are ICRS positions propagated to epoch J2000.0. Gaia DR3 catalogue astrometry is natively epoch J2016.0; `pmRA` means \(\mu_{\alpha*}=\dot\alpha\cos\delta\). Distances are reciprocal-parallax estimates.

| Target | RA, Dec J2000 | Parallax; distance | Proper motion \((\mu_{\alpha*},\mu_\delta)\), mas/yr | `targets.ts` comparison |
|---|---|---|---|---|
| Barnard’s Star | 269.45208°, +4.69336° | 546.9759 mas; 1.8282 pc, 5.963 ly | −801.551, +10362.394 | Stored 2026 position is correct to rounding; parallax 547.0 and total motion 10.39″/yr correct. [Gaia DR3 values](https://measuredcosmos.com/stars/barnards-star) |
| ε Indi Ba/Bb barycenter | ≈331.044°, −56.783° | 274.99±0.43 mas; 3.6365 pc, 11.86 ly | +3987.41, −2505.35 | Stored position is consistent with propagation to about 2026. Parallax **270.7 is stale/wrong**; use 274.99. Total motion 4.71″/yr, PA ≈122.2°, not 4.68. No meaningful Gaia G=18.03 should be assigned to the unresolved brown-dwarf pair. [Chen et al. astrometric solution](https://www.pure.ed.ac.uk/ws/portalfiles/portal/372528683/2205.08077v1.pdf) |
| WISE 0855−0714 | 133.79513°, −7.24515° | 439.0±2.4 mas; 2.278 pc, 7.43 ly | −8123.7, +673.2 | Parallax and total motion ≈8.15″/yr are correct. Stored position (133.7599°, −7.2422°) corresponds roughly to 2013, **not 2026**; expected 2026 ≈133.7359°, −7.2403°. [Literature summary and references](https://en.wikipedia.org/wiki/WISE_0855%E2%88%920714) |
| RW Aur A | 76.95667°, +30.40139° | 5.4541±0.3324 mas; 183.35 pc, 598 ly | +4.906, −24.578 | Stored position differs from propagated 2026 by ≈2.3″ in RA and ≈0.6″ in Dec. Parallax **6.4 mas is wrong**; use 5.4541. Total motion is 0.0251″/yr, so displayed 0.03 is acceptable. [Gaia DR3 table](https://onlinelibrary.wiley.com/doi/full/10.1002%2Fasna.20230118) |
| R Dra | 248.16761°, +66.75498° | 1.2509±0.0648 mas; 799.4 pc, 2607 ly | −20.643, +6.149 | Stored position is correctly near epoch 2026. Parallax 1.25 and total motion 0.0215″/yr are correct. [Gaia DR3 via SIMBAD](https://simbad.u-strasbg.fr/simbad/sim-id?Ident=R+Dra) |

## 3. Shared coordinate frame

For distance \(d\) in AU, \(\alpha=\mathrm{RA}\), \(\delta=\mathrm{Dec}\), and J2000 mean obliquity \(\epsilon=23.43928^\circ\):

\[
\begin{aligned}
x_{eq}&=d\cos\delta\cos\alpha\\
y_{eq}&=d\cos\delta\sin\alpha\\
z_{eq}&=d\sin\delta\\
x_{ecl}&=x_{eq}\\
y_{ecl}&=\cos\epsilon\,y_{eq}+\sin\epsilon\,z_{eq}\\
z_{ecl}&=-\sin\epsilon\,y_{eq}+\cos\epsilon\,z_{eq}
\end{aligned}
\]

Use \(d_{\rm AU}=206264.806247\,d_{\rm pc}\). JPL gives \(\epsilon=23.43928^\circ\). `raDecToEcliptic` has the correct signs and geometry; change `23.4393` to `23.43928` for consistency. `galacticToEq` implements the standard IAU J2000 inverse transform correctly.

## 4. Recommended radial scale

Use this continuous, monotonic, direction-preserving mapping, in display units:

\[
R(r)=
\begin{cases}
3r,&r\le2\ {\rm AU}\\
6+2\log_{10}(r/2),&2<r\le30\\
8.352+1.5\log_{10}(r/30),&r>30
\end{cases}
\]

| Object/radius | Mapped radius |
|---|---:|
| Mercury 0.387 AU | 1.16 |
| Earth 1 AU | 3.00 |
| Mars 1.524 AU | 4.57 |
| Neptune 30 AU | 8.35 |
| Barnard, 1.83 pc | 14.50 |
| R Dra, 799 pc | 18.46 |

This gives roughly 24 px Sun–Mercury and 38 px Mercury–Earth at 1600×900 with a 60° vertical FOV and camera distance 38, while all targets remain visible.

NASA Eyes emphasizes realistic, navigable Solar-System views, but should be treated as design precedent rather than evidence for one documented scale formula. [NASA Eyes](https://www.nasa.gov/interactives/) Celestia filters stars by apparent magnitude/AutoMag; Gaia Sky uses focus/free modes, logarithmic camera-speed scaling and log depth, and can suppress labels by solid angle. Adopt that behavior: clamp labels to 12–18 px, fade orbit/label opacity below 3–5 px apparent diameter, and allow selected labels to override fading. [Celestia guide](https://www.centrovisite.ira.inaf.it/riservato/CelestiaUsersGuide-1.3.2.pdf), [Gaia Sky camera](https://gaia.ari.uni-heidelberg.de/gaiasky/docs/master/Camera-modes.html), [label/solid-angle behavior](https://gaia.ari.uni-heidelberg.de/gaiasky/docs/master/Camera-info-panel.html), [log-depth design](https://tonisagrista.com/blog/2019/gaia-sky-220/)

## 5. Camera

- Perspective camera: vertical FOV 60°, default distance **38 mapped units**, looking at origin.
- Dolly limits: **2.5–120 units**. Dynamically set near/far planes, or use logarithmic depth if real coordinates are retained.
- Pan in the view plane; constrain the focus point to mapped radius ≤20.
- Wheel/pinch: exponential dolly, `distance *= exp(−0.0015 * wheelDelta)`.
- Zoom-to-cursor: raycast cursor onto the plane through the current focus normal to camera; after dolly, translate focus/camera so the same mapped point remains under the cursor. If no intersection is usable, fall back to screen-centred dolly.
- Slow movement near the minimum distance and clamp per-event zoom to about ±20% to prevent tunnelling.