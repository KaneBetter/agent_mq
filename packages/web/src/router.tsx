import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";

// Tiny dependency-free router: real URLs + back/forward, SPA-style.
interface RouterState {
  path: string;
  navigate: (to: string) => void;
}
const RouterContext = createContext<RouterState>({ path: "/", navigate: () => {} });

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname || "/");
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname || "/");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    if (to !== window.location.pathname) {
      window.history.pushState(null, "", to);
      setPath(to);
      window.scrollTo(0, 0);
    }
  }, []);
  return <RouterContext.Provider value={{ path, navigate }}>{children}</RouterContext.Provider>;
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
  const { navigate } = useRouter();
  const handle = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return; // let the browser open a new tab
    e.preventDefault();
    onClick?.();
    navigate(to);
  };
  return (
    <a href={to} className={className} style={style} onClick={handle}>
      {children}
    </a>
  );
}
