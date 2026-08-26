import { useEffect, useRef, useState } from "react";

/**
 * Tracks how wide each tab is on average inside a horizontally scrollable
 * tab strip, so tabs can progressively shed chrome (close button, filename)
 * as they compress toward the 40px icon-only floor before the strip scrolls.
 *
 * `ref` must be attached to the scrollable strip container; `tabCount` is the
 * number of tabs currently rendered inside it.
 */
export function useTabStripDensity(
  tabCount: number,
  hideCloseUnder = 100,
  hideNameUnder = 48,
) {
  const ref = useRef<HTMLDivElement>(null);
  const [avgWidth, setAvgWidth] = useState(Number.POSITIVE_INFINITY);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const n = tabCount;
      setAvgWidth(n > 0 ? el.clientWidth / n : Number.POSITIVE_INFINITY);
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tabCount]);

  return {
    ref,
    hideClose: avgWidth < hideCloseUnder,
    hideName: avgWidth < hideNameUnder,
  };
}