import { useEffect, useRef, useState } from "react";

/**
 * Tracks how much width each tab has on average, so tabs can progressively
 * shed chrome (close button, filename) as they compress toward the 40px
 * icon-only floor before the strip scrolls.
 *
 * `ref` must be attached to the full-width bar that CONTAINS the tab strip
 * (not the strip itself). Measuring the bar width keeps the metric free of
 * feedback: hiding the close button/filename must not permanently shrink the
 * measured width, or tabs would never restore after the window is enlarged.
 * `tabCount` is the number of tabs currently rendered.
 */
export function useTabStripDensity(
  tabCount: number,
  hideCloseUnder = 100,
  hideNameUnder = 48
) {
  const ref = useRef<HTMLDivElement>(null);
  const [widthPerTab, setWidthPerTab] = useState(Number.POSITIVE_INFINITY);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const n = tabCount;
      setWidthPerTab(n > 0 ? el.clientWidth / n : Number.POSITIVE_INFINITY);
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tabCount]);

  return {
    ref,
    hideClose: widthPerTab < hideCloseUnder,
    hideName: widthPerTab < hideNameUnder,
  };
}
