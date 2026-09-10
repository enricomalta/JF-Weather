export interface WeatherData {
  temperature: number
  humidity: number
  precipitation: number
  precipitationProbability: number
  windSpeed: number
  windDirection: number
  cloudCover: number
  timestamp: number
}
export interface TimelinePoint { time: number; precipitation: number; probability: number }
export interface WeatherTile { id?: string; name?: string; lat: number; lon: number; data: WeatherData | null; timeline: TimelinePoint[]; error?: string }
export interface GridResponse {
  tiles: WeatherTile[]
  timeline: TimelinePoint[]
  timestamp: number
  updateTimestamp: number
  nextUpdate: number
  status: 'success' | 'partial' | 'error'
  message?: string
}
export interface GeoBounds { north: number; south: number; east: number; west: number }
export interface GeoFeature { type: 'Feature'; id?: string | number; geometry: { type: string; coordinates: any }; properties: Record<string, any> }
export interface GeoFeatureCollection { type: 'FeatureCollection'; features: GeoFeature[] }
export interface CityMarker { name: string; lat: number; lon: number; state?: string; isCapital?: boolean; isFocus?: boolean }
export interface CacheEntry<T> { data: T; timestamp: number; ttl: number }
export interface WeatherProviderConfig { apiKey: string; refreshInterval: number; cacheInterval: number; gridResolution: number }
export interface ProviderStatus { isAvailable: boolean; lastUpdate?: number; nextUpdate?: number; error?: string }


export interface RainViewerFrame {
  time: number;
  url: string;
}

export interface RainViewerHistory {
  frames: RainViewerFrame[];
  updatedAt: number;
}