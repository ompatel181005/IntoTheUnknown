import { useEffect, useState } from "react";

const EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;

/** True after `ms` without pointer or keyboard input, but only while `active`. */
export function useIdle(active: boolean, ms = 3000): boolean {
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    if (!active) return;
    let t = window.setTimeout(() => setIdle(true), ms);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(t);
      t = window.setTimeout(() => setIdle(true), ms);
    };
    EVENTS.forEach((e) => window.addEventListener(e, wake, { passive: true }));
    return () => {
      window.clearTimeout(t);
      EVENTS.forEach((e) => window.removeEventListener(e, wake));
      setIdle(false);
    };
  }, [active, ms]);

  return active && idle;
}
