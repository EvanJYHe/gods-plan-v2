import { useSyncExternalStore } from 'react'

/** A two-route client router: `/` (the landing page) and `/play`. */

const listeners = new Set<() => void>()
window.addEventListener('popstate', () => listeners.forEach(l => l()))

export function navigate(path: string) {
  if (location.pathname === path) return
  const go = () => {
    history.pushState(null, '', path)
    listeners.forEach(l => l())
    window.scrollTo(0, 0)
  }
  // cross-fade between pages where the browser supports it
  const doc = document as Document & { startViewTransition?: (cb: () => void) => void }
  if (doc.startViewTransition) doc.startViewTransition(go)
  else go()
}

export function usePath() {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb) }, () => location.pathname)
}
