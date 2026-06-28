/**
 * Per-service instance-size selector — a compact S/M/L segmented control (NOT a
 * dropdown) shown beside adjustable capacity services in the cost list. Picking a
 * size re-scales that service's range client-side (see applySizeSelection) so every
 * price on the page updates instantly. Mirrors the IntakeForm chip/radiogroup
 * idiom, tightened to single-glyph square segments; arrow keys cycle for a11y.
 */
import type { SizeId, SizeLadder } from "../lib/sizeLadder.js";

export function SizeSelector({
  ladder,
  selectedId,
  onSelect,
  ariaLabel,
}: {
  ladder: SizeLadder;
  selectedId: SizeId;
  onSelect: (id: SizeId) => void;
  ariaLabel: string;
}): JSX.Element {
  const onKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    current: SizeId,
  ): void => {
    const order = ladder.sizes.map((s) => s.id);
    const idx = order.indexOf(current);
    let next: SizeId | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      next = order[(idx + 1) % order.length]!;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      next = order[(idx - 1 + order.length) % order.length]!;
    }
    if (next) {
      e.preventDefault();
      onSelect(next);
    }
  };

  const active =
    ladder.sizes.find((s) => s.id === selectedId) ?? ladder.sizes[1]!;

  return (
    <span
      className="size-selector"
      role="radiogroup"
      aria-label={`${ariaLabel} instance size`}
      title={`${active.instanceType} — click a size to reprice`}
    >
      {ladder.sizes.map((s) => {
        const isActive = s.id === selectedId;
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            className={`size-selector__chip${isActive ? " size-selector__chip--active" : ""}`}
            onClick={() => onSelect(s.id)}
            onKeyDown={(e) => onKeyDown(e, s.id)}
            title={s.instanceType}
          >
            {s.label}
          </button>
        );
      })}
    </span>
  );
}
