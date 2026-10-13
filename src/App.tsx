import { lazy, Suspense } from 'react'
import { usePath } from './router'
import { Landing } from './landing/Landing'

const Play = lazy(() => import('./play/Play').then(m => ({ default: m.Play })))

export function App() {
  const path = usePath()
  if (path.startsWith('/play')) return <Suspense fallback={<div className="boot" />}><Play /></Suspense>
  return <Landing />
}
