/**
 * A tiny "is the visitor touching the globe right now?" signal. The city builds behind the globe in heavy synchronous
 * chunks; it waits for a quiet moment between chunks so the hitch never lands mid-drag or mid-hover.
 */
let lastBusy = 0

export const markBusy = () => { lastBusy = performance.now() }

/** Resolves once there has been no pointer activity for `quiet` ms (and the browser has an idle slot). */
export function whenIdle(quiet = 350): Promise<void> {
  return new Promise(resolve => {
    const check = () => {
      const wait = lastBusy + quiet - performance.now()
      if (wait > 0) { setTimeout(check, wait + 10); return }
      if ('requestIdleCallback' in window) requestIdleCallback(() => resolve(), { timeout: 400 })
      else setTimeout(resolve, 0)
    }
    check()
  })
}
