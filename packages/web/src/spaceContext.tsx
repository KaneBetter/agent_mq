import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { SpaceSummary } from "@agentmq/shared";
import { api } from "./api";

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

const LS_KEY = "agentmq.currentSpace";

export function SpaceProvider({ children }: { children: ReactNode }) {
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [currentSpaceId, setCurrentSpaceIdState] = useState<string | null>(
    () => localStorage.getItem(LS_KEY)
  );

  const refresh = useCallback(async () => {
    try {
      const s = await api.spaces();
      setSpaces(s);
      setCurrentSpaceIdState((cur) => {
        if (cur && s.some((x) => x.id === cur)) return cur;
        // default: the public space, else the first
        const pub = s.find((x) => x.visibility === "public");
        return (pub ?? s[0])?.id ?? null;
      });
    } catch {
      /* not authed / no spaces */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setCurrentSpaceId = useCallback((id: string) => {
    localStorage.setItem(LS_KEY, id);
    setCurrentSpaceIdState(id);
  }, []);

  const current = useMemo(
    () => spaces.find((s) => s.id === currentSpaceId) ?? null,
    [spaces, currentSpaceId]
  );

  return (
    <SpaceContext.Provider value={{ spaces, currentSpaceId, current, setCurrentSpaceId, refresh }}>
      {children}
    </SpaceContext.Provider>
  );
}
