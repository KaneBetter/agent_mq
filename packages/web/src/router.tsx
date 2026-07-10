import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";

// Tiny dependency-free router: real URLs + back/forward, SPA-style.
// `navigate`/`href`/`path` deal in LOGICAL paths (no space prefix). The space
// layer (spaceContext) re-provides this context with the current space slug
// stripped from `path` and re-added by `navigate`/`href`, so callers never see
// it — the real URL stays /{spaceSlug}/…, callers keep using "/topics".
interface RouterState {
  path: string;
  navigate: (to: string, replace?: boolean) => void;
  href: (to: string) => string;
}
export const RouterContext = createContext<RouterState>({
  path: "/",
  navigate: () => {},
  href: (to) => to,
});

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname || "/");
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname || "/");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string, replace = false) => {
    if (to !== window.location.pathname) {
      window.history[replace ? "replaceState" : "pushState"](null, "", to);
      setPath(to);
      window.scrollTo(0, 0);
    }
  }, []);
  return (
    <RouterContext.Provider value={{ path, navigate, href: (to) => to }}>
      {children}
    </RouterContext.Provider>
  );
}

export function useRouter() {
  return useContext(RouterContext);
}

export function Link({
  to,
  className,
  style,
  children,
  onClick,
}: {
  to: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  onClick?: () => void;
}) {
  const { navigate, href } = useRouter();
  const handle = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return; // let the browser open a new tab
    e.preventDefault();
    onClick?.();
    navigate(to);
  };
  return (
    <a href={href(to)} className={className} style={style} onClick={handle}>
      {children}
    </a>
  );
}
