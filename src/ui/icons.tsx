/** Custom icons, drawn on a 24 grid with 1.6 strokes. */

const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const NukeIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" {...s}>
    <path d="M6.5 9.2c0-2.6 2.4-4.7 5.5-4.7s5.5 2.1 5.5 4.7c0 1.9-1.6 3.2-3.6 3.2H10.1c-2 0-3.6-1.3-3.6-3.2Z" />
    <path d="M10.4 12.4 9.6 19.5M13.6 12.4l.8 7.1" />
    <path d="M5 19.5h14" />
  </svg>
)

export const WaveIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" {...s}>
    <path d="M3 17.5c2.2 0 2.9-1.4 4.6-1.4s2.4 1.4 4.4 1.4 2.7-1.4 4.4-1.4 2.4 1.4 4.6 1.4" />
    <path d="M4.5 13.6C6 8.4 10 5.5 14.4 5.5c2.3 0 4 1 4.7 2.3-2.9-.6-5.1 1-5.1 3.3 0 1.3.8 2.3 1.9 2.6" />
  </svg>
)

export const MeteorIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" {...s}>
    <circle cx="15.5" cy="15.5" r="4" />
    <path d="M12.6 12.6 4 4M15 11 9.5 5.5M11 15 5.5 9.5" />
  </svg>
)

export const RebuildIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" {...s}>
    <path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3L19.5 9" />
    <path d="M19.5 4.5V9H15" />
    <path d="M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4.5 15" />
    <path d="M4.5 19.5V15H9" />
  </svg>
)

export const SunIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
  </svg>
)

export const DuskIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
    <path d="M7.5 16a4.5 4.5 0 0 1 9 0" />
    <path d="M3 16h18M5.5 19.5h13M12 7v2.4M5.6 9.6l1.6 1.6M18.4 9.6l-1.6 1.6" />
  </svg>
)

export const MoonIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
    <path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z" />
  </svg>
)

export const SlowIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
    <circle cx="12" cy="13" r="7.5" />
    <path d="M12 9v4l2.6 1.6M9.5 2.8h5" />
  </svg>
)

export const SoundIcon = ({ muted }: { muted: boolean }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
    <path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z" />
    {muted ? <path d="m15.5 9.5 5 5M20.5 9.5l-5 5" /> : <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.6 7.6 0 0 1 0 11" />}
  </svg>
)

export const BackIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
    <path d="M14.5 6 8.5 12l6 6" />
  </svg>
)
