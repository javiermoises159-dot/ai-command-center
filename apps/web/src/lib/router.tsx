/**
 * A ~60-line hash router.
 *
 * Hash routing rather than history routing so the built app works from any
 * static host (and from an iOS home-screen launch) with no server rewrite
 * rules. The app has three routes; a routing library would be more code than
 * this and one more dependency to keep current.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Route =
  | { name: 'dashboard' }
  | { name: 'missions' }
  | { name: 'mission'; id: string }
  | { name: 'not-found'; path: string };

function parse(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/';
  if (path === '/' || path === '') return { name: 'dashboard' };
  if (path === '/missions') return { name: 'missions' };

  const mission = /^\/missions\/([^/]+)$/.exec(path);
  if (mission?.[1] !== undefined) return { name: 'mission', id: decodeURIComponent(mission[1]) };

  return { name: 'not-found', path };
}

export function href(route: Route): string {
  switch (route.name) {
    case 'dashboard':
      return '#/';
    case 'missions':
      return '#/missions';
    case 'mission':
      return `#/missions/${encodeURIComponent(route.id)}`;
    case 'not-found':
      return '#/';
  }
}

interface RouterValue {
  route: Route;
  navigate(route: Route): void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));

  useEffect(() => {
    const onChange = () => {
      setRoute(parse(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    window.location.hash = href(next);
  }, []);

  const value = useMemo(() => ({ route, navigate }), [route, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (value === null) throw new Error('useRouter must be used inside a RouterProvider.');
  return value;
}
