import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { SpaceSummary } from "@agentmq/shared";
import { api } from "./api";
import { RouterContext, useRouter } from "./router";

interface SpaceState {
  spaces: SpaceSummary[];
  currentSpaceId: string | null;
  current: SpaceSummary | null;
  setCurrentSpaceId: (id: string) => void;
  refresh: () => Promise<void>;
}

const SpaceContext = createContext<SpaceState>({
  spaces: [],
  currentSpaceId: null,
  current: null,
  setCurrentSpaceId: () => {},
  refresh: async () => {},
});

export function useSpaces() {
  return useContext(SpaceContext);
}

// Remembers the last space slug so a bare "/" entry lands where you left off.
const LS_KEY = "agentmq.currentSpace";

export function SpaceProvider({ children }: { children: ReactNode }) {
  // The RAW router from the parent RouterProvider — the real pathname, which
  // now carries the space slug as its first segment (/{slug}/{…logical}).
  const { path: rawPath, navigate: rawNavigate } = useRouter();
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);

  const refresh = useCallback(async () => {
    try {
      setSpaces(await api.spaces());
    } catch {
      /* not authed / no spaces */
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Split "/{slug}/{…rest}" into the space slug and the logical path.
  const segs = rawPath.split("/").filter(Boolean);
  const urlSlug = segs[0] ?? null;
  const matched = urlSlug ? spaces.find((s) => s.slug === urlSlug) ?? null : null;

  // Default space when the URL carries no valid slug yet: last-used, else the
  // public space, else the first one available.
  const fallback = useMemo<SpaceSummary | null>(() => {
    if (spaces.length === 0) return null;
    const remembered = spaces.find((s) => s.slug === localStorage.getItem(LS_KEY));
    return remembered ?? spaces.find((s) => s.visibility === "public") ?? spaces[0] ?? null;
  }, [spaces]);

  const current = matched ?? fallback;
  const currentSlug = current?.slug ?? null;

  // The logical route (what the app's routing understands) is the path minus a
  // matched space slug. If the first segment isn't a known space, treat the
  // whole path as logical — the normalize effect below will prefix it.
  const logical = matched ? "/" + segs.slice(1).join("/") : rawPath || "/";

  // Once spaces are known, keep the URL canonical: /{currentSlug}{logical}.
  useEffect(() => {
    if (spaces.length === 0 || !currentSlug) return;
    if (matched && urlSlug === currentSlug) return; // already canonical
    const rest = logical === "/" ? "" : logical;
    rawNavigate(`/${currentSlug}${rest}`, true); // replace — don't spam history
  }, [spaces.length, currentSlug, matched, urlSlug, logical, rawNavigate]);

  // Remember the active space for the next bare-URL entry.
  useEffect(() => {
    if (currentSlug) localStorage.setItem(LS_KEY, currentSlug);
  }, [currentSlug]);

  const setCurrentSpaceId = useCallback(
    (id: string) => {
      const target = spaces.find((s) => s.id === id);
      if (!target) return;
      const rest = logical === "/" ? "" : logical;
      rawNavigate(`/${target.slug}${rest}`);
    },
    [spaces, logical, rawNavigate]
  );

  // Re-provide the router to descendants with the space slug handled for them:
  // `path` is logical, `navigate`/`href` re-add the current slug. Every existing
  // <Link to="/topics"> and navigate("/topics") keeps working unchanged while
  // the real URL stays /{slug}/topics.
  const childRouter = useMemo(
    () => ({
      path: logical,
      navigate: (to: string, replace = false) => {
        const rest = to === "/" ? "" : to;
        rawNavigate(currentSlug ? `/${currentSlug}${rest}` : rest || "/", replace);
      },
      href: (to: string) => {
        const rest = to === "/" ? "" : to;
        return currentSlug ? `/${currentSlug}${rest}` : rest || "/";
      },
    }),
    [logical, currentSlug, rawNavigate]
  );

  const value = useMemo<SpaceState>(
    () => ({
      spaces,
      currentSpaceId: current?.id ?? null,
      current,
      setCurrentSpaceId,
      refresh,
    }),
    [spaces, current, setCurrentSpaceId, refresh]
  );

  return (
    <SpaceContext.Provider value={value}>
      <RouterContext.Provider value={childRouter}>{children}</RouterContext.Provider>
    </SpaceContext.Provider>
  );
}
