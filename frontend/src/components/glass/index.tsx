import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import s from "./glass.module.css";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

import { NOT_AVAILABLE } from "./classes";


type PanelProps = HTMLAttributes<HTMLDivElement> & { strong?: boolean; pill?: boolean; flat?: boolean };

export function GlassPanel({ strong, pill, flat, className, ...rest }: PanelProps) {
  return <div {...rest} className={cx(s.panel, strong && s.strong, pill && s.pill, flat && s.flat, className)} />;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost";
  icon?: IconName;
  /** Icon-only buttons must pass a label. */
  label?: string;
};

export function GlassButton({ variant = "outline", icon, label, children, className, title, ...rest }: ButtonProps) {
  const iconOnly = !children;
  return (
    <button
      type="button"
      {...rest}
      aria-label={iconOnly ? label : rest["aria-label"]}
      title={rest.disabled && !title ? NOT_AVAILABLE : (title ?? (iconOnly ? label : undefined))}
      className={cx(s.button, variant === "primary" && s.primary, variant === "ghost" && s.ghost, iconOnly && s.icon, className)}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

type ChipProps = ButtonHTMLAttributes<HTMLButtonElement> & { pressed?: boolean };

export function Chip({ pressed, className, ...rest }: ChipProps) {
  return <button type="button" aria-pressed={pressed} {...rest} className={cx(s.chip, className)} />;
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (v: T) => void;
  className?: string;
}

/** A radio group drawn as a pill. Arrow keys move between options. */
export function Segmented<T extends string>({ label, value, options, onChange, className }: SegmentedProps<T>) {
  const enabled = options.filter((o) => !o.disabled);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    e.stopPropagation();
    const i = enabled.findIndex((o) => o.value === value);
    const next = enabled[(i + (e.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length];
    if (next) onChange(next.value);
  };
  return (
    <div role="radiogroup" aria-label={label} className={cx(s.segmented, className)} onKeyDown={onKey}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          disabled={o.disabled}
          title={o.disabled ? (o.title ?? NOT_AVAILABLE) : o.title}
          className={s.segment}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface TabsProps<T extends string> {
  label: string;
  value: T;
  tabs: { value: T; label: string; panelId: string }[];
  onChange: (v: T) => void;
}

export function Tabs<T extends string>({ label, value, tabs, onChange }: TabsProps<T>) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.value === value);
    let nextIndex = i;
    if (e.key === "ArrowRight") nextIndex = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") nextIndex = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = tabs.length - 1;
    const next = tabs[nextIndex];
    if (next) {
      onChange(next.value);
      const nextBtn = document.getElementById(`tab-${next.value}`);
      nextBtn?.focus();
    }
  };

  return (
    <div role="tablist" aria-label={label} className={s.tabs} onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          id={`tab-${t.value}`}
          aria-selected={t.value === value}
          aria-controls={t.panelId}
          tabIndex={t.value === value ? 0 : -1}
          className={s.tab}
          onClick={() => onChange(t.value)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export { Icon };

export function Switch({ label, pressed, disabled, hint, onToggle }: { label: string; pressed: boolean; disabled?: boolean; hint?: string; onToggle: () => void }) {
  const id = `sw-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className={s.switchRow}>
      <span id={id}>{label}</span>
      <span className={s.switchHit}>
        <button
          type="button"
          className={s.switch}
          aria-pressed={pressed && !disabled}
          aria-labelledby={id}
          disabled={disabled}
          title={disabled ? (hint ?? NOT_AVAILABLE) : hint}
          onClick={onToggle}
        />
      </span>
    </div>
  );
}
