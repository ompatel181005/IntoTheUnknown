import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getGaiaMatch, getLightCurve, getSpectrum } from "./api";
import { AppShell } from "./components/AppShell/AppShell";
import { CustomizePanel, type CustomizeValues } from "./components/Customize/CustomizePanel";
import { Drawer } from "./components/Drawer/Drawer";
import { Guide } from "./components/Guide/Guide";
import { Tour } from "./components/Tour/Tour";
import type { TourStep } from "./components/Tour/steps";
import { PlaybackBar } from "./components/PlaybackBar/PlaybackBar";
import { SkyBackdrop } from "./components/SkyBackdrop/SkyBackdrop";
import { SkyStage } from "./components/SkyStage/SkyStage";
import { StepGuide } from "./components/StepGuide/StepGuide";
import { Toast } from "./components/Toast/Toast";
import { Toolbar } from "./components/Toolbar/Toolbar";
import { HomeGuideButton, TopBar } from "./components/TopBar/TopBar";
import { HomePanel } from "./components/HomePanel";
import { useCatalog } from "./hooks/useCatalog";
import { useCatalogSelection } from "./hooks/useCatalogSelection";
import { APP_NAME } from "./lib/brand";
import { pointPosition } from "./lib/catalog";
import availability from "../public/catalog/data-availability.json";
import { catalogCounts } from "./lib/catalogSort";
import { formatDec, formatRa, parseCoords } from "./lib/format";
import type { CatalogObject } from "./types";
import type { ViewQuery, ViewSource } from "./data/source";
import { useAsync } from "./hooks/useAsync";
import { useIdle } from "./hooks/useIdle";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { usePlayback } from "./hooks/usePlayback";
import { useView } from "./hooks/useView";
import { markFlight, prepareReturnFlight, requestCoordinateFlight, requestTargetFlight } from "./lib/flight";
import { readFlag, writeFlag } from "./lib/storage";
import { findPreset, PRESETS, type Preset } from "./lib/targets";
import { DEFAULTS, parseUrl, toSearch, type Panel, type ViewMode, type ViewState } from "./lib/url";
import { centeredPreset, sourcePresentation } from "./lib/viewPresentation";

const GUIDE_KEY = "spherex-blink.guide-dismissed";
const HOME_PANEL_KEY = "spherex-blink.home-panel-hidden";
const NO_OBJECTS: readonly CatalogObject[] = [];
const CUSTOMIZE_KEY = "spherex-blink.customize-hidden";
const GUTTER = 16;
const RAIL_W = 52;
const PANEL_W = 284;
const DRAWER_W = 374;

function isTyping(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

/** Elements that already use Space or arrows themselves. */
function ownsKeys(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  if (!t) return false;
  return t.tagName === "BUTTON" || ["radio", "tab", "slider", "application"].includes(t.getAttribute("role") ?? "");
}

export default function App({ source }: { source: ViewSource }) {
  const [storedUrl, setUrl] = useState<ViewState>(() => parseUrl(window.location.search));
  const [initialParams] = useState(() => new URLSearchParams(window.location.search));
  const [attempt, setAttempt] = useState(0);
  const [guideHidden, setGuideHidden] = useState(() => readFlag(GUIDE_KEY));
  const [customizeHidden, setCustomizeHidden] = useState(() => readFlag(CUSTOMIZE_KEY));
  const [sheetOpen, setSheetOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [tourOn, setTourOn] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const mobile = useMediaQuery("(max-width: 768px)");

  const catalog = useCatalog("points", storedUrl.point !== null || storedUrl.ra === null);
  const objects = catalog.catalog?.objects ?? NO_OBJECTS;
  const point = objects.find((object) => object.id === storedUrl.point) ?? null;
  const pointDefaults = useMemo(() => {
    if (!point) return null;
    const challenge = findPreset(point.preset_id);
    return challenge ? { ra: challenge.ra, dec: challenge.dec, fov: challenge.fov, band: challenge.band } : pointPosition(point);
  }, [point]);
  const pointLinkDefaults = useMemo(() => pointDefaults ? {
    ...pointDefaults,
    fov: initialParams.has("fov") ? storedUrl.fov : pointDefaults.fov,
    band: initialParams.has("band") ? storedUrl.band : pointDefaults.band,
  } : null, [pointDefaults, initialParams, storedUrl.fov, storedUrl.band]);
  const url = useMemo(() => storedUrl.point && storedUrl.ra === null && pointLinkDefaults
    ? { ...storedUrl, ...pointLinkDefaults } : storedUrl, [storedUrl, pointLinkDefaults]);
  const selection = useCatalogSelection(catalog.catalog);
  const [homeQuery, setHomeQuery] = useState("");
  const homeCoords = parseCoords(homeQuery);
  const [homePanelOpen, setHomePanelOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(HOME_PANEL_KEY);
      if (saved !== null) return saved !== "1";
    } catch { /* Use the viewport default when storage is unavailable. */ }
    return !window.matchMedia("(max-width: 768px)").matches;
  });
  const setHomePanel = (open: boolean) => {
    setHomePanelOpen(open);
    try { localStorage.setItem(HOME_PANEL_KEY, open ? "0" : "1"); } catch { /* Storage is optional. */ }
  };

  const update = useCallback((patch: Partial<ViewState>) => setUrl((u) => ({ ...u, ...(u.ra === null && u.point ? pointLinkDefaults : {}), ...patch })), [pointLinkDefaults]);

  const query = useMemo<ViewQuery | null>(() => {
    if (url.ra === null || url.dec === null || (url.point && !point && catalog.status === "loading")) return null;
    const rendered = point?.view;
    const useRendered = rendered && url.source === "auto" && Math.abs(url.ra - rendered.query.ra) < 0.0000051 && Math.abs(url.dec - rendered.query.dec) < 0.0000051
      && url.fov === rendered.query.fov_arcmin && url.band === rendered.query.band;
    return { ra: url.ra, dec: url.dec, fov_arcmin: url.fov, band: url.band, mode: "stack", source: url.source,
      presetId: url.target ?? point?.preset_id ?? null, ...(useRendered ? { manifestUrl: rendered.manifest_url } : {}) };
  }, [url.ra, url.dec, url.fov, url.band, url.source, url.target, url.point, point, catalog.status]);
  const load = useView(source, query, attempt);
  const view = load.kind === "ready" ? load.view : null;
  const epochs = useMemo(() => view?.manifest.epochs ?? [], [view]);
  const ref = Math.min(url.ref, Math.max(epochs.length - 1, 0));

  const pb = usePlayback(view?.viewId ?? "none", epochs.length, url.mode, url.speed, url.epoch, ref);

  // The URL is the state. The epoch is written while paused so links point at a still frame.
  useEffect(() => {
    const next = toSearch({ ...url, epoch: pb.playing ? url.epoch : pb.index });
    try {
      window.history.replaceState(null, "", next || window.location.pathname);
    } catch {
      // Some embedded contexts block history writes; the app still works.
    }
  }, [url, pb.index, pb.playing]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Measurements for the drawer, at the picked pixel or the target at the centre.
  const nx = view?.manifest.grid.nx ?? 0;
  const ny = view?.manifest.grid.ny ?? 0;
  const at: [number, number] = url.sel ?? [nx >> 1, ny >> 1];
  const spectrum = useAsync(
    view && url.panel === "colours" ? `${view.viewId}|${at[0]}|${at[1]}|${pb.index}` : null,
    (signal) => getSpectrum(view!.viewId, at[0], at[1], pb.index, signal),
  );
  const lightcurve = useAsync(
    view && url.panel === "brightness" ? `${view.viewId}|${at[0]}|${at[1]}` : null,
    (signal) => getLightCurve(view!.viewId, at[0], at[1], signal),
  );
  const gaiaMatch = useAsync(
    view?.gaia && (url.panel === "colours" || url.panel === "brightness") ? `${view.viewId}|${at[0]}|${at[1]}|${pb.index}` : null,
    (signal) => getGaiaMatch(view!.viewId, at[0], at[1], pb.index, signal),
  );

  const preset = centeredPreset(url.target, url.ra, url.dec);
  const drawerOpen = url.panel !== null;
  const customizeOpen = mobile ? sheetOpen : !customizeHidden;
  const idle = useIdle(pb.playing && !drawerOpen && !guideOpen && !tourOn && !reducedMotion && !(mobile && sheetOpen));

  const pickPreset = (p: Preset) => update({ ra: p.ra, dec: p.dec, fov: p.fov, band: p.band, target: p.id, point: null, epoch: 0, sel: null, ref: 0 });
  // Starfield jump starts the instant a flight starts, before the target is committed.
  const [flightActive, setFlightActive] = useState(false);
  // Prepare controls after first paint, rather than mounting them at landing.
  const [chromeReady, setChromeReady] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setChromeReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const returningHome = useRef(false);
  const finishFlight = useCallback(() => {
    returningHome.current = false;
    markFlight("chrome-reveal");
    setFlightActive(false);
  }, []);
  const openFromHome = (object: CatalogObject) => {
    markFlight("target-mount");
    const challenge = findPreset(object.preset_id);
    if (challenge) pickPreset(challenge);
    else update({ ...pointPosition(object), target: null, point: object.id, epoch: 0, sel: null, ref: 0 });
  };
  const flyToPoint = (id: string) => {
    if (flightActive || !selection.checked.has(id)) return;
    requestTargetFlight(id);
  };
  const pickCoords = (ra: number, dec: number) => {
    if (flightActive) return;
    if (url.ra === null) {
      setFlightActive(true);
      void requestCoordinateFlight(ra, dec).then(finishFlight);
    }
    update({ ra, dec, target: null, point: null, epoch: 0, sel: null, ref: 0 });
  };
  const pickFromBar = (p: Preset) => {
    if (flightActive) return;
    markFlight("search-start");
    if (url.ra === null && requestTargetFlight(p.id)) return;
    pickPreset(p);
  };
  const goHome = () => {
    if (url.ra === null || url.dec === null || returningHome.current || flightActive) return;
    markFlight("home-start");
    returningHome.current = true;
    setFlightActive(true);
    const r = document.querySelector('[data-tour="dome"]')?.getBoundingClientRect();
    const dome = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, side: r.width } : null;
    void prepareReturnFlight({ id: preset?.id ?? point?.id ?? null, ra: url.ra, dec: url.dec }, dome).then(() => {
      update({ ra: null, dec: null, target: null, point: null, epoch: 0, panel: null, mode: "all", sel: null });
      finishFlight();
    });
  };
  const openPanel = (panel: Panel | null) => {
    if (mobile && panel) setSheetOpen(false);
    update({ panel, mode: panel === null && url.mode === "inspect" ? "all" : url.mode });
  };
  const setMode = (mode: ViewMode) => update({ mode, panel: mode === "inspect" ? (url.panel ?? "pass") : url.panel });
  const setCustomizeOpen = (open: boolean) => {
    if (mobile) {
      setSheetOpen(open);
      if (open && url.panel) update({ panel: null });
      return;
    }
    setCustomizeHidden(!open);
    writeFlag(CUSTOMIZE_KEY, !open);
  };
  const toggleOverlay = (k: keyof ViewState["overlays"]) => update({ overlays: { ...url.overlays, [k]: !url.overlays[k] } });
  const select = (xy: [number, number] | null) =>
    update({ sel: xy, panel: url.panel === "colours" || url.panel === "brightness" ? url.panel : "colours" });
  const startTour = () => {
    pb.pause();
    setGuideOpen(false);
    setTourOn(true);
  };
  // Make the app show what a tour step points at.
  const prepareTour = (needs: TourStep["needs"]) => {
    pb.pause();
    if ((needs === "view" || needs === "drawer") && url.ra === null) pickPreset(PRESETS[0]);
    if (needs === "drawer" && !url.panel) update({ panel: "colours" });
    if (needs !== "drawer" && url.panel && mobile) update({ panel: null });
    if (needs === "customize" && !mobile) setCustomizeOpen(true);
  };
  const fullscreen = () => {
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    } catch {
      // Fullscreen is blocked in some embeds.
    }
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setToast("Link copied");
    } catch {
      setToast("Copy failed. Copy the address bar instead.");
    }
  };

  const customize: CustomizeValues = {
    source: url.source,
    fov: url.fov,
    speed: url.speed,
    stretch: url.stretch,
    band: url.band,
    invert: url.invert,
    smooth: url.smooth,
    gain: url.gain,
    ref,
  };
  const resetCustomize = () =>
    update({
      fov: preset?.fov ?? pointDefaults?.fov ?? DEFAULTS.fov,
      band: preset?.band ?? pointDefaults?.band ?? DEFAULTS.band,
      speed: DEFAULTS.speed,
      stretch: DEFAULTS.stretch,
      invert: DEFAULTS.invert,
      smooth: DEFAULTS.smooth,
      gain: DEFAULTS.gain,
      ref: DEFAULTS.ref,
      source: DEFAULTS.source,
    });

  const available = {
    flags: !!view && view.masks.some((m) => m !== null),
    grid: !!view,
    gaia: !!view?.gaia,
  };
  const overlays = {
    flags: url.overlays.flags && available.flags,
    grid: url.overlays.grid && available.grid,
    gaia: url.overlays.gaia && available.gaia,
  };

  // Keyboard shortcuts. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const k = e.key;
      if (tourOn || guideOpen) return; // they handle their own keys
      if (k === "Escape") {
        if (drawerOpen) openPanel(null);
        else if (mobile && sheetOpen) setSheetOpen(false);
        return;
      }
      if (k === "?") return setGuideOpen(true);
      if (url.ra === null || flightActive) return;
      if ((k === " " || k === "ArrowLeft" || k === "ArrowRight") && ownsKeys(e.target)) return;
      if (k === " ") {
        e.preventDefault();
        pb.toggle();
      } else if (k === "ArrowLeft") {
        e.preventDefault();
        pb.prev();
      } else if (k === "ArrowRight") {
        e.preventDefault();
        pb.next();
      } else if ((k === "b" || k === "B") && epochs.length > 1) {
        setMode(url.mode === "blink" ? "all" : "blink");
      } else if ((k === "d" || k === "D") && epochs.length > 1) {
        setMode(url.mode === "diff" ? "all" : "diff");
      } else if (k === "c" || k === "C") {
        setCustomizeOpen(!customizeOpen);
      } else if (k === "i" || k === "I") {
        openPanel(url.panel ? null : "pass");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const guideDone: [boolean, boolean, boolean] = [load.kind !== "idle", pb.played, pb.loops > 0];
  const showGuide = !guideHidden && !(mobile && (drawerOpen || sheetOpen));

  const left = mobile || load.kind === "idle" ? GUTTER : customizeOpen ? PANEL_W + GUTTER * 2 : 44 + GUTTER * 2;
  const right = mobile ? GUTTER : drawerOpen ? DRAWER_W + RAIL_W + GUTTER * 3 : RAIL_W + GUTTER * 2;
  // The map and the dome are centred on the screen, so the stage reserves the same space on both sides.
  // Equal insets keep the image and its overlays centred when Details needs more room.
  const centred = !mobile;
  const stageLeft = centred ? Math.max(left, right) : left;
  const stageRight = centred ? Math.max(left, right) : right;
  const sheet = mobile && (drawerOpen || sheetOpen);
  const chromeHidden = flightActive || load.kind === "idle";

  return (
    <AppShell
      idle={idle}
      flying={flightActive}
      stageLeft={stageLeft}
      stageRight={stageRight}
      hideBottom={sheet}
      bottomReserve={sheet ? Math.min(window.innerHeight * 0.6, 480) : 0}
      backdrop={
        <SkyBackdrop
          dim={load.kind !== "idle"}
        />
      }
      top={
        <>
          {url.ra === null && <HomeGuideButton onGuide={() => setGuideOpen(true)} />}
          <div style={{ display: url.ra === null ? "none" : "contents" }}>
            <TopBar
              crumb={url.ra === null ? null : (preset?.name ?? point?.name ?? "Custom position")}
              onHome={goHome}
              homeDisabled={flightActive}
              onPreset={pickFromBar}
              onCoords={pickCoords}
              onShare={share}
              shareDisabled={!query}
              onGuide={() => setGuideOpen(true)}
              onTour={startTour}
            />
          </div>
          {showGuide && (
            <StepGuide
              done={guideDone}
              onDismiss={() => {
                setGuideHidden(true);
                writeFlag(GUIDE_KEY, true);
              }}
            />
          )}
        </>
      }
      stage={
        <SkyStage
          load={load}
          catalogObjects={objects}
          point={point}
          visibleIds={selection.checked}
          target={preset ?? null}
          ra={url.ra}
          dec={url.dec}
          fov={url.fov}
          index={pb.index}
          mode={url.mode}
          stretch={url.stretch}
          invert={url.invert}
          smooth={url.smooth}
          gain={url.gain}
          refIndex={ref}
          overlays={overlays}
          flying={flightActive}
          onFullscreen={fullscreen}
          showLabel={!drawerOpen}
          sel={url.sel}
          onSelect={select}
          onRetry={() => setAttempt((a) => a + 1)}
          onPreset={pickPreset}
          onOpenFromHome={openFromHome}
          onFlightStart={() => {
            markFlight("marker-start");
            setFlightActive(true);
          }}
          onFlightEnd={finishFlight}
          onCursor={(xy) => update({ sel: xy })}
          onTour={startTour}
        />
      }
      bottom={
        !chromeReady ? null : (
          <div data-flight-chrome="playback" aria-hidden={chromeHidden} inert={chromeHidden}>
            <PlaybackBar
              epochs={epochs}
              index={pb.index}
              sequence={pb.sequence}
              playing={pb.playing}
              canPlay={pb.canPlay}
              mode={url.mode}
              status={null}
              loading={load.kind === "loading"}
              customizeOpen={customizeOpen}
              onToggle={pb.toggle}
              onPrev={pb.prev}
              onNext={pb.next}
              onSeek={pb.seek}
              onMode={setMode}
              onCustomize={() => setCustomizeOpen(!customizeOpen)}
              onDetails={() => openPanel(drawerOpen ? null : "pass")}
              detailsOpen={drawerOpen}
            />
          </div>
        )
      }
      overlays={
        <>
          <div hidden={url.ra !== null} aria-hidden={url.ra !== null || flightActive} inert={url.ra !== null || flightActive}>
            <HomePanel
              items={objects.map((object) => ({ id: object.id, name: object.name, kind: object.kind, clickable: true, counts: catalogCounts(object, availability) }))}
              checked={selection.checked}
              onToggle={selection.toggle}
              onSetAll={selection.setAll}
              query={homeQuery}
              onQuery={setHomeQuery}
              coordsHint={homeCoords ? `Go to RA ${formatRa(homeCoords.ra)}, Dec ${formatDec(homeCoords.dec)}` : null}
              onGoToCoords={homeCoords ? () => pickCoords(homeCoords.ra, homeCoords.dec) : undefined}
              onFly={flyToPoint}
              open={homePanelOpen}
              onOpenChange={setHomePanel}
              brand={APP_NAME}
              onGuide={() => setGuideOpen(true)}
            />
            {catalog.status !== "ready" && <span className="home-catalog-status" role="status">{catalog.error ?? "Loading target list…"}</span>}
          </div>
          <div data-flight-chrome="panels" aria-hidden={chromeHidden} inert={chromeHidden}>
            {chromeReady && (!mobile || sheetOpen) && (
              <CustomizePanel
                open={customizeOpen}
                onOpenChange={setCustomizeOpen}
                values={customize}
                onChange={(v) => update(v)}
                onReset={resetCustomize}
                epochs={epochs}
                origin={view?.manifest.origin ?? null}
                provenance={view ? sourcePresentation(view) : null}
                collections={view?.manifest.catalog.collections ?? []}
                loading={load.kind === "loading"}
                sheet={mobile}
              />
            )}
            {chromeReady && !mobile && (
              <Toolbar
                groups={[
                  [
                    { id: "details", label: "Details", icon: "info", expanded: drawerOpen, shortcut: "I", onClick: () => openPanel(drawerOpen ? null : "pass") },
                  ],
                  [
                    { id: "grid", label: "Coordinate grid", icon: "grid", pressed: overlays.grid, disabled: !available.grid, onClick: () => toggleOverlay("grid") },
                    ...(!view || available.flags ? [{ id: "flags", label: "Flagged pixels", icon: "flag" as const, pressed: overlays.flags, disabled: !available.flags, onClick: () => toggleOverlay("flags") }] : []),
                    ...(available.gaia ? [{ id: "gaia", label: "Gaia stars", icon: "gaia" as const, pressed: overlays.gaia, onClick: () => toggleOverlay("gaia") }] : []),
                    { id: "invert", label: "Invert", icon: "invert", pressed: url.invert, disabled: !view, onClick: () => update({ invert: !url.invert }) },
                  ],
                  [
                    { id: "home", label: "Whole sky", icon: "globe", onClick: goHome },
                    { id: "fullscreen", label: "Full screen", icon: "fullscreen", onClick: fullscreen },
                  ],
                ]}
              />
            )}
            {drawerOpen && url.panel && (
              <Drawer
                panel={url.panel}
                onPanel={(p) => openPanel(p)}
                onClose={() => openPanel(null)}
                view={view}
                index={pb.index}
                target={preset ?? null}
                point={point}
                position={url.ra !== null && url.dec !== null ? { ra: url.ra, dec: url.dec } : null}
                sel={url.sel}
                spectrum={spectrum}
                lightcurve={lightcurve}
                gaiaMatch={gaiaMatch}
                onSelectEpoch={pb.seek}
              />
            )}
          </div>
          {guideOpen && <Guide onClose={() => setGuideOpen(false)} onTour={startTour} hasTarget={url.ra !== null && !flightActive} multi={epochs.length > 1} />}
          {tourOn && <Tour prepare={prepareTour} onClose={() => setTourOn(false)} />}
          <Toast message={toast} />
        </>
      }
    />
  );
}
