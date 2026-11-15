import { useEffect, useState } from "react";
import type { LoadedView } from "../data/source";
import { loadLearnTarget } from "../data/learnSource";
import { content, names, targets } from "./content";
import { imagePixel, learnSearch, missionIds, parseLearnState, validSelection, type LearnState, type Locale, type MissionId } from "./state";
import { advancedLink, epochEvidence, observationPng } from "./postcard";
import { ObservationImage } from "./ObservationImage";
import s from "./Learn.module.css";

export function LearnPage() {
  const [state, setState] = useState(() => parseLearnState(location.search));
  const [result, setResult] = useState<{ mission: MissionId; view: LoadedView } | null>(null);
  const [failed, setFailed] = useState<MissionId | null>(null);
  const [retry, setRetry] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [response, setResponse] = useState<"yes" | "unsure" | null>(null);
  const [notice, setNotice] = useState<"copied" | "copyFailed" | "exportFailed" | null>(null);
  const [exporting, setExporting] = useState(false);
  const t = content[state.lang];
  const lesson = t.lessons[state.mission];
  const view = result?.mission === state.mission ? result.view : null;
  const epoch = view ? Math.min(state.epoch, view.images.length - 1) : 0;
  const selection = view ? validSelection(state.selection, view.manifest.grid.nx, view.manifest.grid.ny) : null;
  const sharedState: LearnState = { ...state, epoch, selection };
  const shareUrl = `${location.origin}/learn.html${learnSearch(sharedState)}`;

  useEffect(() => {
    const controller = new AbortController();
    loadLearnTarget(targets[state.mission], controller.signal).then(
      view => { if (!controller.signal.aborted) { setResult({ mission: state.mission, view }); setFailed(null); } },
      () => { if (!controller.signal.aborted) setFailed(state.mission); },
    );
    return () => controller.abort();
  }, [state.mission, retry]);
  useEffect(() => {
    document.documentElement.lang = state.lang;
    document.title = `${lesson.title} · Into The Unknown`;
    const canonical = view ? { ...state, epoch: Math.min(state.epoch, view.images.length - 1), selection: validSelection(state.selection, view.manifest.grid.nx, view.manifest.grid.ny) } : state;
    history.replaceState(null, "", `/learn.html${learnSearch(canonical)}`);
  }, [state, lesson.title, view]);
  useEffect(() => {
    const back = () => { setState(parseLearnState(location.search)); setPlaying(false); setRevealed(false); setResponse(null); };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  useEffect(() => {
    if (!playing || !view) return;
    const interval = window.setInterval(() => setState(prev => ({ ...prev, epoch: (Math.min(prev.epoch, view.images.length - 1) + 1) % view.images.length })), 900);
    return () => clearInterval(interval);
  }, [playing, view]);

  function choose(mission: MissionId) {
    setPlaying(false); setRevealed(false); setResponse(null); setNotice(null); setFailed(null);
    setState(prev => ({ ...prev, mission, epoch: 0, selection: null }));
  }
  function select(selection: [number, number] | null) { setPlaying(false); setState(prev => ({ ...prev, selection })); }
  async function copy() {
    try { await navigator.clipboard.writeText(shareUrl); setNotice("copied"); }
    catch { setNotice("copyFailed"); }
  }
  async function download() {
    if (!view) return;
    setExporting(true); setNotice(null);
    try {
      const blob = await observationPng(view, sharedState, location.origin);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `spherex-${targets[state.mission]}-${state.lang}.png`;
      a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch { setNotice("exportFailed"); }
    finally { setExporting(false); }
  }
  const evidence = view ? epochEvidence(view.manifest, epoch) : null;
  return <main className={s.page}>
    <header className={s.header}>
      <a className={s.brand} href="/">◔ <span>Into The Unknown</span></a>
      <label>{t.language}<select value={state.lang} onChange={e => { setNotice(null); setState(prev => ({ ...prev, lang: e.target.value as Locale })); }}>
        <option value="en">English</option><option value="es">Español</option><option value="hi">हिन्दी</option>
      </select></label>
    </header>
    <section className={s.intro}><p className={s.eyebrow}>SPHEREx · {t.saved}</p><h1>{t.title}</h1><p>{t.intro}</p></section>
    <nav className={s.activities} aria-label={t.activity}>
      {missionIds.map(id => <button type="button" key={id} aria-pressed={id === state.mission} onClick={() => choose(id)}><span>{names[id]}</span>{t.lessons[id].title}</button>)}
      <button type="button" className={s.surprise} onClick={() => { const others = missionIds.filter(id => id !== state.mission); choose(others[Math.floor(Math.random() * others.length)]); }}>↗ {t.surprise}</button>
    </nav>
    <div className={s.workspace}>
      <section className={s.observatory} aria-labelledby="observe-title">
        <div className={s.sectionTitle}><h2 id="observe-title">{t.observe} <span>· {names[state.mission]}</span></h2><span className={s.badge}>{t.source}</span></div>
        {view ? <>
          <ObservationImage view={view} epoch={epoch} selection={selection} onSelect={select} label={t.image} north={t.north} />
          <div className={s.controls}>
            <button type="button" aria-label={t.previous} onClick={() => { setPlaying(false); setState(prev => ({ ...prev, epoch: (epoch - 1 + view.images.length) % view.images.length })); }}>←</button>
            <button type="button" onClick={() => {
              // Motion never starts automatically, including when reduced motion is requested.
              setPlaying(v => !v);
            }}>{playing ? t.pause : t.play}</button>
            <button type="button" aria-label={t.next} onClick={() => { setPlaying(false); setState(prev => ({ ...prev, epoch: (epoch + 1) % view.images.length })); }}>→</button>
            <label className={s.timeline}>{t.epoch} {epoch + 1} / {view.images.length}<input aria-label={t.epoch} type="range" min={0} max={view.images.length - 1} value={epoch} onChange={e => { setPlaying(false); setState(prev => ({ ...prev, epoch: Number(e.target.value) })); }} /></label>
          </div>
          <p className={s.imageCaption}>{evidence?.dates} · {evidence?.wavelength}</p>
          <p className={s.quiet}>{t.sharedStretch}</p>
          <details className={s.markControls}><summary>{t.mark}</summary><p>{t.annotation}</p>
            <button type="button" onClick={() => select(imagePixel(0.5, 0.5, view.manifest.grid.nx, view.manifest.grid.ny))}>{t.mark}</button>
            {selection && <><label>{t.positionX}<input type="range" min={0} max={view.manifest.grid.nx - 1} value={selection[0]} onChange={e => select([Number(e.target.value), selection[1]])} /></label><label>{t.positionY}<input type="range" min={0} max={view.manifest.grid.ny - 1} value={selection[1]} onChange={e => select([selection[0], Number(e.target.value)])} /></label><p>{t.selection}: {selection.join(", ")}</p><button type="button" onClick={() => select(null)}>{t.clear}</button></>}
          </details>
        </> : <div className={s.empty} role="status"><p>{failed === state.mission ? t.error : t.loading}</p>{failed === state.mission && <button type="button" onClick={() => { setFailed(null); setRetry(v => v + 1); }}>{t.retry}</button>}</div>}
      </section>
      <aside className={s.lesson}>
        <section><p className={s.eyebrow}>{t.learn}</p><h2>{lesson.title}</h2><p className={s.question}>{lesson.question}</p><p>{lesson.instruction}</p></section>
        <section><p className={s.eyebrow}>{t.check}</p><div className={s.responses} aria-label={t.response}>{(["yes", "unsure"] as const).map(value => <button type="button" key={value} aria-pressed={response === value} onClick={() => setResponse(value)}>{t[value]}</button>)}</div><button className={s.primary} type="button" disabled={!view} onClick={() => setRevealed(true)}>{t.reveal} ↓</button>
          {revealed && <div className={s.reveal} role="status"><p>{lesson.explanation}</p><p className={s.caution}>{lesson.limit}</p></div>}
        </section>
        {view && evidence && <section className={s.evidence}><h3>{t.evidence}</h3><dl><dt>{t.dates}</dt><dd>{evidence.dates}</dd><dt>{t.wavelength}</dt><dd>{evidence.wavelength}</dd><dt>{t.frames}</dt><dd>{evidence.frames}</dd></dl><p>{view.manifest.bandpass_matched === true ? t.matched : view.manifest.bandpass_matched === false ? t.unmatched : t.unknown}</p><p className={s.caution}>{state.mission === "motion" ? t.validated : t.unvalidated}</p><details><summary>{t.flags}</summary><p className={s.flagNames}>{evidence.flags || t.unknown}</p><p>{t.flagNote}</p></details></section>}
      </aside>
    </div>
    <section className={s.share}><div><p className={s.eyebrow}>{t.share}</p><h2>{t.evidence}</h2><p>{lesson.limit}</p></div><div className={s.shareActions}><button type="button" disabled={!view || exporting} onClick={download}>{t.postcard} ↓</button><button type="button" disabled={!view} onClick={copy}>{t.copy}</button>{notice && <p role="status">{t[notice]}</p>}<label>{t.link}<input readOnly value={shareUrl} onFocus={e => e.currentTarget.select()} /></label>{view && <a href={advancedLink(view.manifest, epoch, selection)}>{t.advanced} ↗</a>}</div></section>
    <footer>{t.credits} · <a href="https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_dr1.html" target="_blank" rel="noreferrer">NASA/IPAC IRSA ↗</a></footer>
  </main>;
}
