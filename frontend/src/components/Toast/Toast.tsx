import { GlassPanel } from "../glass";
import s from "./Toast.module.css";

/** Always mounted so screen readers hear each message. */
export function Toast({ message }: { message: string | null }) {
  return (
    <div role="status" aria-live="polite">
      {message && (
        <GlassPanel strong pill className={s.toast}>
          {message}
        </GlassPanel>
      )}
    </div>
  );
}
