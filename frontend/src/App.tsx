import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLightCurve, getSpectrum } from "./api";
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
import { TopBar } from "./components/TopBar/TopBar";
import type { ViewQuery, ViewSource } from "./data/source";
import { useAsync } from "./hooks/useAsync";
import { useIdle } from "./hooks/useIdle";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { usePlayback } from "./hooks/usePlayback";
import { useView } from "./hooks/useView";
import { DATA_CREDIT } from "./lib/brand";
import { prepareReturnFlight, shrinkDomeForHome } from "./lib/flight";
import { readFlag, writeFlag } from "./lib/storage";
import { findPreset, PRESETS, type Preset } from "./lib/targets";
import { DEFAULTS, parseUrl, toSearch, type Panel, type ViewMode, type ViewState } from "./lib/url";

const GUIDE_KEY = "spherex-blink.guide-dismissed";
const CUSTOMIZE_KEY = "spherex-blink.customize-hidden";
const GUTTER = 16;
const RAIL_W = 52;
const PANEL_W = 284;
const DRAWER_W = 340;

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
  const [url, setUrl] = useState<ViewState>(() => parseUrl(window.location.search));
  const [attempt, setAttempt] = useState(0);
  const [guideHidden, setGuideHidden] = useState(() => readFlag(GUIDE_KEY));
  const [customizeHidden, setCustomizeHidden] = useState(() => readFlag(CUSTOMIZE_KEY));
  const [sheetOpen, setSheetOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [tourOn, setTourOn] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const mobile = useMediaQuery("(max-width: 768px)");

  const update = useCallback((patch: Partial<ViewState>) => setUrl((u) => ({ ...u, ...patch })), []);

  const query = useMemo<ViewQuery | null>(
    () =>
      url.ra === null || url.dec === null
        ? null
        : { ra: url.ra, dec: url.dec, fov_arcmin: url.fov, band: url.band, mode: "stack", source: url.source, presetId: url.target },
    [url.ra, url.dec, url.fov, url.band, url.source, url.target],
  );
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

  const preset = findPreset(url.target);
  const drawerOpen = url.panel !== null;
  const customizeOpen = mobile ? sheetOpen : !customizeHidden;
  const idle = useIdle(pb.playing && !drawerOpen && !guideOpen && !tourOn && !reducedMotion && !(mobile && sheetOpen));

  const pickPreset = (p: Preset) => update({ ra: p.ra, dec: p.dec, fov: p.fov, band: p.band, target: p.id, epoch: 0, sel: null, ref: 0 });
  // Starfield jump starts the instant a flight starts, before the target is committed.
  const [flightKey, setFlightKey] = useState<string | null>(null);
  const [flightActive, setFlightActive] = useState(false);
  const returningHome = useRef(false);
  const finishFlight = useCallback(() => {
    returningHome.current = false;
    window.setTimeout(() => setFlightActive(false), reducedMotion ? 0 : 250);
    if (reducedMotion) delete document.documentElement.dataset.flying;
  }, [reducedMotion]);
  /** Where on screen the last home flight ended, so the dome can grow out of that spot. */
  const [flightOrigin, setFlightOrigin] = useState<{ x: number; y: number } | null>(null);
  const openFromHome = (p: Preset, from: { x: number; y: number } | null) => {
    setFlightOrigin(from);
    pickPreset(p);
  };
  const pickCoords = (ra: number, dec: number) => {
    setFlightOrigin(null);
    setFlightActive(true);
    update({ ra, dec, target: null, epoch: 0, sel: null, ref: 0 });
  };
  /** Target chips and search: no home flight, so the dome zooms from the centre. */
  const pickFromBar = (p: Preset) => {
    setFlightOrigin(null);
    setFlightActive(true);
    pickPreset(p);
  };
  const goHome = () => {
    if (url.ra === null || url.dec === null || returningHome.current) return;
    returningHome.current = true;
    setFlightActive(true);
    document.documentElement.dataset.flying = "1";
    prepareReturnFlight({ id: preset?.id ?? null, ra: url.ra, dec: url.dec });
    void shrinkDomeForHome().then(() => {
      setFlightKey(null);
      update({ ra: null, dec: null, target: null, epoch: 0, panel: null, mode: "all", sel: null });
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
      fov: preset?.fov ?? DEFAULTS.fov,
      band: preset?.band ?? DEFAULTS.band,
      speed: DEFAULTS.speed,
      stretch: DEFAULTS.stretch,
      invert: DEFAULTS.invert,
      smooth: DEFAULTS.smooth,
      gain: DEFAULTS.gain,
      ref: DEFAULTS.ref,
      source: DEFAULTS.source,
    });

  const available = {
    gaia: false, // Needs GET /api/views/{id}/gaia (issue #29).
    flags: !!view && view.masks.some((m) => m !== null),
    grid: !!view,
  };
  const overlays = {
    gaia: url.overlays.gaia && available.gaia,
    flags: url.overlays.flags && available.flags,
    grid: url.overlays.grid && available.grid,
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

  const status = view
    ? [
        view.label ?? null,
        view.manifest.catalog.collections.join(" + "),
        `${epochs.length} ${epochs.length === 1 ? "pass" : "passes"}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : DATA_CREDIT;

  const left = mobile || load.kind === "idle" ? GUTTER : customizeOpen ? PANEL_W + GUTTER * 2 : 44 + GUTTER * 2;
  const right = mobile ? GUTTER : drawerOpen ? DRAWER_W + RAIL_W + GUTTER * 3 : RAIL_W + GUTTER * 2;
  // The map and the dome are centred on the screen, so the stage reserves the same space on both sides.
  // With the details drawer open there is not enough room, so the dome shifts left instead of shrinking.
  const centred = !mobile && !drawerOpen;
  const stageLeft = centred ? Math.max(left, right) : left;
  const stageRight = centred ? Math.max(left, right) : right;
  const sheet = mobile && (drawerOpen || sheetOpen);

  return (
    <AppShell
      idle={idle}
      stageLeft={stageLeft}
      stageRight={stageRight}
      hideBottom={sheet}
      bottomReserve={sheet ? Math.min(window.innerHeight * 0.6, 480) : 0}
      backdrop={
        <SkyBackdrop
          dim={load.kind !== "idle"}
          travelKey={url.ra === null || url.dec === null ? flightKey : `${url.ra},${url.dec}`}
        />
      }
      top={
        <>
          <TopBar
            crumb={url.ra === null ? null : (preset?.name ?? "Custom position")}
            onHome={goHome}
            onPreset={pickFromBar}
            onCoords={pickCoords}
            onShare={share}
            shareDisabled={!query}
            onGuide={() => setGuideOpen(true)}
            onTour={startTour}
          />
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
          gaia={null}
          showLabel={!drawerOpen}
          sel={url.sel}
          onSelect={select}
          onRetry={() => setAttempt((a) => a + 1)}
          onPreset={pickPreset}
          onOpenFromHome={openFromHome}
          flightOrigin={flightOrigin}
          onFlightStart={(p) => {
            setFlightActive(true);
            setFlightKey(`${p.ra},${p.dec}`);
          }}
          onFlightEnd={finishFlight}
          onCursor={(xy) => update({ sel: xy })}
          onTour={startTour}
        />
      }
      bottom={
        load.kind === "idle" || flightActive ? null : (
        <PlaybackBar
          epochs={epochs}
          index={pb.index}
          sequence={pb.sequence}
          playing={pb.playing}
          canPlay={pb.canPlay}
          mode={url.mode}
          status={status}
          loading={load.kind === "loading"}
          customizeOpen={customizeOpen}
          onToggle={pb.toggle}
          onPrev={pb.prev}
          onNext={pb.next}
          onSeek={pb.seek}
          onMode={setMode}
          onCustomize={() => setCustomizeOpen(!customizeOpen)}
        />
        )
      }
      overlays={
        <>
          {!flightActive && (mobile ? sheetOpen : load.kind !== "idle") && (
            <CustomizePanel
              open={customizeOpen}
              onOpenChange={setCustomizeOpen}
              values={customize}
              onChange={(v) => update(v)}
              onReset={resetCustomize}
              epochs={epochs}
              origin={view?.manifest.origin ?? null}
              collections={view?.manifest.catalog.collections ?? []}
              loading={load.kind === "loading"}
              sheet={mobile}
            />
          )}
          {!mobile && !flightActive && (
            <Toolbar
              groups={[
                [
                  { id: "details", label: "Details", icon: "info", expanded: drawerOpen, shortcut: "I", onClick: () => openPanel(drawerOpen ? null : "pass") },
                ],
                [
                  { id: "grid", label: "Coordinate grid", icon: "grid", pressed: overlays.grid, disabled: !available.grid, onClick: () => toggleOverlay("grid") },
                  { id: "gaia", label: "Gaia positions", icon: "gaia", pressed: overlays.gaia, disabled: !available.gaia, onClick: () => toggleOverlay("gaia") },
                  { id: "flags", label: "Flagged pixels", icon: "flag", pressed: overlays.flags, disabled: !available.flags, onClick: () => toggleOverlay("flags") },
                  { id: "invert", label: "Invert", icon: "invert", pressed: url.invert, disabled: !view, onClick: () => update({ invert: !url.invert }) },
                ],
                [
                  { id: "home", label: "Whole sky", icon: "globe", onClick: goHome },
                  { id: "fullscreen", label: "Full screen", icon: "fullscreen", onClick: fullscreen },
                ],
              ]}
            />
          )}
          {!flightActive && drawerOpen && url.panel && (
            <Drawer
              panel={url.panel}
              onPanel={(p) => openPanel(p)}
              onClose={() => openPanel(null)}
              view={view}
              index={pb.index}
              target={preset ?? null}
              position={url.ra !== null && url.dec !== null ? { ra: url.ra, dec: url.dec } : null}
              sel={url.sel}
              spectrum={spectrum}
              lightcurve={lightcurve}
              onSelectEpoch={pb.seek}
            />
          )}
          {guideOpen && <Guide onClose={() => setGuideOpen(false)} onTour={startTour} />}
          {tourOn && <Tour prepare={prepareTour} onClose={() => setTourOn(false)} />}
          <Toast message={toast} />
        </>
      }
    />
  );
}
