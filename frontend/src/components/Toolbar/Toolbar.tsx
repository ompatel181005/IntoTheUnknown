import { NOT_AVAILABLE } from "../glass/classes";
import { Icon, type IconName } from "../glass/Icon";
import s from "./Toolbar.module.css";

export interface ToolbarItem {
  id: string;
  label: string;
  icon: IconName;
  /** Toggles pass a boolean; actions pass undefined. */
  pressed?: boolean;
  /** For buttons that open the drawer. */
  expanded?: boolean;
  disabled?: boolean;
  shortcut?: string;
  onClick: () => void;
}

/** Vertical rail of round icon buttons on the right edge (Stellarium style). */
export function Toolbar({ groups }: { groups: ToolbarItem[][] }) {
  return (
    <nav className={s.rail} aria-label="View tools" data-fade data-flight-hide style={{ ["--flight-hide-x" as string]: "32px" }} data-tour="tools">
      {groups.map((items, gi) => (
        <div key={gi} className={s.group}>
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              className={s.button}
              aria-label={it.label}
              aria-pressed={it.pressed}
              aria-expanded={it.expanded}
              aria-controls={it.expanded !== undefined ? "drawer" : undefined}
              disabled={it.disabled}
              data-tip={it.disabled ? `${it.label}: ${NOT_AVAILABLE}` : it.shortcut ? `${it.label} (${it.shortcut})` : it.label}
              onClick={it.onClick}
            >
              <Icon name={it.icon} size={18} />
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
