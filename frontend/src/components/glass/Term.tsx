import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { getTermDefinition } from "./glossary";
import s from "./Term.module.css";

export interface TermProps {
  /** The term key to look up in the glossary */
  term?: string;
  /** Explicit definition override */
  definition?: ReactNode;
  /** Optional custom class for the trigger */
  className?: string;
  /** Display label (defaults to term) */
  children?: ReactNode;
  /** Optional custom title */
  title?: string;
}

/**
 * A small accessible Term component: dotted-underline term that shows a short definition
 * on hover, keyboard focus, and tap (aria-describedby, Escape closes, works on touch, zero layout shift).
 */
export function Term({ term, definition, className, children, title }: TermProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; placeAbove: boolean }>({
    top: 0,
    left: 0,
    placeAbove: false,
  });
  const triggerRef = useRef<HTMLSpanElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const leaveTimerRef = useRef<number | null>(null);
  const id = useId();

  const termKey = term ?? (typeof children === "string" ? children : "");
  const resolvedDef = definition ?? (termKey ? getTermDefinition(termKey) : "");

  const updateCoords = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const pad = 12;
    const tooltipWidth = 260;
    const minCenter = tooltipWidth / 2 + pad;
    const maxCenter = window.innerWidth - tooltipWidth / 2 - pad;
    const triggerCenter = rect.left + rect.width / 2;

    const left =
      minCenter <= maxCenter
        ? Math.max(minCenter, Math.min(maxCenter, triggerCenter))
        : window.innerWidth / 2;

    // Prefer below unless it extends past viewport bottom and there is space above
    const placeAbove = rect.bottom + 110 > window.innerHeight && rect.top > 100;
    const top = placeAbove ? rect.top - 8 : rect.bottom + 8;

    setCoords({ top, left, placeAbove });
  }, []);

  const show = useCallback(() => {
    if (leaveTimerRef.current) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    updateCoords();
    setOpen(true);
  }, [updateCoords]);

  const hide = useCallback(() => {
    leaveTimerRef.current = window.setTimeout(() => {
      setOpen(false);
    }, 140);
  }, []);

  const toggle = useCallback(() => {
    if (leaveTimerRef.current) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    setOpen((prev) => {
      if (!prev) updateCoords();
      return !prev;
    });
  }, [updateCoords]);

  const handleKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };

  // Keep position accurate and handle outside dismiss
  useEffect(() => {
    if (!open) return;
    updateCoords();

    const onScroll = () => updateCoords();
    const onResize = () => updateCoords();

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        triggerRef.current?.contains(target) ||
        popupRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };

    const onWindowKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onWindowKey);

    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onWindowKey);
    };
  }, [open, updateCoords]);

  const label = children ?? term ?? "Term";

  return (
    <>
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-describedby={open ? id : undefined}
        title={title}
        className={`${s.term}${className ? ` ${className}` : ""}`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={toggle}
        onKeyDown={handleKeyDown}
      >
        {label}
      </span>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popupRef}
            id={id}
            role="tooltip"
            aria-live="polite"
            className={s.popup}
            style={{
              top: `${coords.top}px`,
              left: `${coords.left}px`,
              ["--translate-y" as string]: coords.placeAbove ? "-100%" : "0",
            }}
            onMouseEnter={show}
            onMouseLeave={hide}
          >
            {termKey && <span className={s.termName}>{termKey}</span>}
            <div className={s.termDef}>{resolvedDef}</div>
          </div>,
          document.body,
        )}
    </>
  );
}
