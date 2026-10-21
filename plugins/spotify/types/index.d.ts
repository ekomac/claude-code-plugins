export type SpotifyPhase = 'needs-client' | 'needs-login' | 'ready'

export type SpotifyView = {
  phase: SpotifyPhase
  /** The authorize URL while a login waits for its code. */
  authUrl?: string
  error?: string
  isBusy?: boolean
}

export type NowPlaying = {
  title: string
  artists: string
  album: string
  durationMs: number
  progressMs: number
  isPlaying: boolean
  device?: string
  contextUri?: string
  contextName?: string
}

export type Playlist = { uri: string; name: string; tracks: number }

declare module 'claude-code' {
  interface PluginState {
    spotify: {
      view: SpotifyView
      player: NowPlaying | null
      playlists: Playlist[]
    }
  }
}
