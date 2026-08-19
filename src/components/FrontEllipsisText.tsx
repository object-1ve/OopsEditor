/**
 * FrontEllipsisText - single-line text that, when overflowing, omits the
 * FRONT (head) and keeps the tail visible, e.g. "…src/sidebar/Sidebar.tsx".
 * Used for full file paths where the file name (the end) matters most.
 */
import { useLayoutEffect, useRef, useState } from "react";

interface FrontEllipsisTextProps {
  /** full text; kept intact in the `title` tooltip */
  text: string;
  className?: string;
}

const ELLIPSIS = "…";

export default function FrontEllipsisText({ text, className }: FrontEllipsisTextProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(text);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    let measuring = false;

    const apply = () => {
      if (cancelled || measuring) return;
      measuring = true;
      try {
        // Full text first: the flex item clamps to its container, so
        // clientWidth is the available space.
        el.textContent = text;
        const available = el.clientWidth;
        if (el.scrollWidth <= available) {
          setDisplay(text);
          return;
        }
        // Binary-search the longest suffix (prefixed by the ellipsis) that fits.
        let lo = 0;
        let hi = text.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          el.textContent = ELLIPSIS + text.slice(text.length - mid);
          if (el.scrollWidth <= available) {
            lo = mid;
          } else {
            hi = mid - 1;
          }
        }
        setDisplay(ELLIPSIS + text.slice(text.length - lo));
      } finally {
        measuring = false;
      }
    };

    apply();
    // Observe the PARENT: its width is the available space. Mutating our own
    // textContent changes our own shrink-to-fit box, which would re-trigger a
    // ResizeObserver on `el` and restart the search in a loop.
    const target = el.parentElement ?? el;
    const observer = new ResizeObserver(apply);
    observer.observe(target);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [text]);

  return (
    <span
      ref={ref}
      className={`${className ?? ""} block whitespace-nowrap overflow-hidden`}
      style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden" }}
      title={text}
    >
      {display}
    </span>
  );
}
