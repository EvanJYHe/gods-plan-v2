import type { ReactNode } from 'react'
import './desktop.css'

/**
 * The hero film in a window on a desktop wallpaper, after cluely.com's product frame (measured at 1440px: a 1152 x 678
 * screen with 13px corners and a blurred copy of the wallpaper behind it). Only the wallpaper and the centred window:
 * no menu bar, dock or toolbar. The wallpaper is an original ChatGPT painting, not Apple's.
 */
export function Desktop({ children }: { children: ReactNode }) {
  return (
    <div className="dk">
      <img className="dk-glow" src="/media/desktop-wallpaper-glow.jpg" alt="" aria-hidden="true" />
      <div className="dk-screen">
        <img className="dk-wall" src="/media/desktop-wallpaper.webp" alt="" aria-hidden="true" decoding="async" />
        <div className="dk-window">
          <div className="dk-titlebar" aria-hidden="true">
            <i className="dk-light dk-close" /><i className="dk-light dk-min" /><i className="dk-light dk-max" />
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}
