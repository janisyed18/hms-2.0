import { useEffect, useRef, useState } from "react";

/**
 * Options fetched from the server as the person types, so a list is never cut off at the first page.
 * The fetcher is read through a ref, so passing a fresh closure each render does not refetch.
 */
export function useRemoteOptions<T>(
  fetcher: (query: string) => Promise<T[]>,
  enabled: boolean,
  debounceMs = 250
) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const latest = useRef(fetcher);
  useEffect(() => { latest.current = fetcher; });

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      latest.current(query)
        .then((result) => { if (active) setItems(result); })
        .catch(() => { if (active) setItems([]); })
        .finally(() => { if (active) setLoading(false); });
    }, query ? debounceMs : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [enabled, query, debounceMs]);

  return { items, loading, search: setQuery };
}
