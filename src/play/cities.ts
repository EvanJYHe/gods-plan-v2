/** Every destination on the globe. Only Toronto is live; the rest are locked, each with a one-line tease. */

export interface City {
  id: string
  name: string
  lat: number
  lon: number
  live: boolean
  /** one line, on-voice */
  tease: string
  /** which way its globe label hangs off the pin (default up-right) */
  side?: 'ne' | 'se' | 'nw' | 'sw'
}

export const CITIES: City[] = [
  { id: 'toronto', name: 'Toronto', lat: 43.6426, lon: -79.3871, live: true, tease: 'Started from the bottom. We can put it back there.' },
  { id: 'new-york', name: 'New York', lat: 40.7128, lon: -74.006, live: false, side: 'se', tease: 'Godzilla has dibs. We are in talks.' },
  { id: 'london', name: 'London', lat: 51.5072, lon: -0.1276, live: false, tease: 'Already raining. We are adding a meteor.' },
  { id: 'paris', name: 'Paris', lat: 48.8566, lon: 2.3522, live: false, side: 'sw', tease: 'On strike. Back soon, probably.' },
  { id: 'tokyo', name: 'Tokyo', lat: 35.6762, lon: 139.6503, live: false, tease: 'The kaiju union wants royalties.' },
  { id: 'san-francisco', name: 'San Francisco', lat: 37.7749, lon: -122.4194, live: false, side: 'nw', tease: 'Waiting on a building permit. Since 1906.' },
  { id: 'dubai', name: 'Dubai', lat: 25.2048, lon: 55.2708, live: false, tease: 'Still building a taller tower for you to knock over.' },
  { id: 'singapore', name: 'Singapore', lat: 1.3521, lon: 103.8198, live: false, tease: 'Littering is a fine. A tsunami is a bigger fine.' },
  { id: 'sydney', name: 'Sydney', lat: -33.8688, lon: 151.2093, live: false, tease: 'Everything there already wants you dead.' },
  { id: 'sao-paulo', name: 'São Paulo', lat: -23.5558, lon: -46.6396, live: false, tease: 'Stuck in a 180 km traffic jam. ETA unknown.' },
]
