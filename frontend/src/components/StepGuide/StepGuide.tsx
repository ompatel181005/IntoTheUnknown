import { GlassButton, Icon } from "../glass";
import s from "./StepGuide.module.css";

const STEPS = ["Pick a target", "Press play", "Watch for movement"] as const;

interface StepGuideProps {
  /** Completed flags, one per step. */
  done: [boolean, boolean, boolean];
  onDismiss: () => void;
}

export function StepGuide({ done, onDismiss }: StepGuideProps) {
  const current = done.findIndex((d) => !d);
  return (
    <div className={s.guide} role="group" aria-label="Getting started">
      <ol className={s.list}>
        {STEPS.map((label, i) => {
          const state = done[i] ? "done" : i === current ? "current" : "next";
          return (
            <li key={label} className={s.step} data-state={state} aria-current={state === "current" ? "step" : undefined}>
              {i > 0 && (
                <span className={s.sep} aria-hidden="true">
                  <Icon name="chevron" size={14} />
                </span>
              )}
              <span className={s.mark} aria-hidden="true">
                {state === "done" && <Icon name="check" size={14} />}
              </span>
              <span className={s.label}>
                {label}
                {state === "done" && <span className="sr-only"> (done)</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <GlassButton variant="ghost" icon="close" label="Hide setup steps" onClick={onDismiss} />
    </div>
  );
}
