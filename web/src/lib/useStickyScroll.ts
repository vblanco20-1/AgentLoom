import { useEffect, useRef } from "react";

// Returns a ref to attach to a scrollable element. Whenever `dep` changes
// (e.g. text length, item count), the element is scrolled to the bottom —
// but only if the user is already pinned near the bottom. If the user has
// scrolled up to read, we leave their position alone.
export function useStickyScroll<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const slack = 24;
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [dep]);

  return ref;
}
