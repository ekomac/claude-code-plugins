import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NowPlaying, Playlist, SpotifyView } from '../types'

const PANE = 'spotify'
const TITLE = 'Spotify'
const API = 'https://api.spotify.com/v1'
const ACCOUNTS = 'https://accounts.spotify.com'
const REDIRECT_URI = 'http://127.0.0.1:8888/callback'
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ')
const POLL_MS = 4000

const view = atom({ plugin: 'spotify', key: 'view' } as const, {
  phase: 'needs-client',
} as SpotifyView)
const player = atom(
  { plugin: 'spotify', key: 'player' } as const,
  null as NowPlaying | null,
)
const playlists = atom(
  { plugin: 'spotify', key: 'playlists' } as const,
  [] as Playlist[],
)

type $ = EngineInterface

// Stored across sessions in the plugin's own $.store.
type Tokens = { access: string; refresh: string; expiresAt: number }

class NotConnected extends Error {}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function base64url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63)
    if (i + 1 < bytes.length) out += B64.charAt((n >> 6) & 63)
    if (i + 2 < bytes.length) out += B64.charAt(n & 63)
  }
  return out
}

function form(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

async function setError($: $, error: string | undefined) {
  await update($, view, v => ({ ...v, error, isBusy: false }))
}

async function saveTokens($: $, body: string, previousRefresh?: string) {
  const json = JSON.parse(body) as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }
  const tokens: Tokens = {
    access: json.access_token,
    refresh: json.refresh_token ?? previousRefresh ?? '',
    expiresAt: (await $.clock.now()) + (json.expires_in - 60) * 1000,
  }
  await $.store.set('tokens', tokens)
  return tokens
}

let refreshing: Promise<string> | undefined

async function accessToken($: $, force = false): Promise<string> {
  const tokens = (await $.store.get('tokens')) as Tokens | undefined
  const clientId = (await $.store.get('clientId')) as string | undefined
  if (!tokens?.refresh || !clientId) throw new NotConnected()
  if (!force && tokens.expiresAt > (await $.clock.now())) return tokens.access
  refreshing ??= (async () => {
    const res = await $.http.fetch(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh,
        client_id: clientId,
      }),
    })
    if (!res.ok) {
      await $.store.delete('tokens')
      throw new NotConnected()
    }
    return (await saveTokens($, res.text, tokens.refresh)).access
  })().finally(() => {
    refreshing = undefined
  })
  return refreshing
}

async function api($: $, method: string, path: string, body?: unknown) {
  const call = async (token: string) =>
    $.http.fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  let res = await call(await accessToken($))
  if (res.status === 401) res = await call(await accessToken($, true))
  return res
}

function reason(status: number, text: string): string {
  if (status === 404) return 'No hay ningún dispositivo activo: abrí Spotify y dale play una vez.'
  if (status === 403) return 'Spotify rechazó el control (hace falta Premium para controlar la reproducción).'
  if (status === 429) return 'Demasiadas peticiones a Spotify; reintento en unos segundos.'
  try {
    const msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message
    if (msg) return `Spotify: ${msg}`
  } catch {}
  return `Spotify respondió ${status}.`
}

async function handle($: $, error: unknown) {
  if (error instanceof NotConnected) {
    await update($, view, v => ({ ...v, phase: 'needs-login' as const, isBusy: false }))
    await update($, player, () => null)
    return
  }
  await setError($, error instanceof Error ? error.message : String(error))
}

async function poll($: $) {
  const { phase } = await read($, view)
  if (phase !== 'ready') return
  try {
    const res = await api($, 'GET', '/me/player')
    if (res.status === 204 || !res.text) {
      await update($, player, () => null)
      return
    }
    if (!res.ok) return setError($, reason(res.status, res.text))
    const p = JSON.parse(res.text) as {
      is_playing: boolean
      progress_ms: number | null
      device?: { name: string }
      context?: { uri: string } | null
      item?: {
        name: string
        duration_ms: number
        artists?: { name: string }[]
        album?: { name: string }
        show?: { name: string }
      } | null
    }
    const lists = await read($, playlists)
    const contextUri = p.context?.uri
    await update($, player, () =>
      p.item
        ? {
            title: p.item.name,
            artists: (p.item.artists ?? []).map(a => a.name).join(', ') || (p.item.show?.name ?? ''),
            album: p.item.album?.name ?? '',
            durationMs: p.item.duration_ms,
            progressMs: p.progress_ms ?? 0,
            isPlaying: p.is_playing,
            device: p.device?.name,
            contextUri,
            contextName: lists.find(l => l.uri === contextUri)?.name,
          }
        : null,
    )
    const { error } = await read($, view)
    if (error) await setError($, undefined)
  } catch (error) {
    await handle($, error)
  }
}

async function loadPlaylists($: $) {
  try {
    const res = await api($, 'GET', '/me/playlists?limit=50')
    if (!res.ok) return setError($, reason(res.status, res.text))
    const json = JSON.parse(res.text) as {
      items: ({ uri: string; name: string; tracks?: { total: number } } | null)[]
    }
    await update($, playlists, () =>
      json.items
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map(p => ({ uri: p.uri, name: p.name, tracks: p.tracks?.total ?? 0 })),
    )
  } catch (error) {
    await handle($, error)
  }
}

async function control($: $, method: string, path: string, body?: unknown) {
  await update($, view, v => ({ ...v, isBusy: true }))
  try {
    const res = await api($, method, path, body)
    if (!res.ok && res.status !== 204) return setError($, reason(res.status, res.text))
    await update($, view, v => ({ ...v, isBusy: false, error: undefined }))
    // Spotify takes a moment to reflect the change.
    $.clock.after(700, () => fire($, poll($)))
  } catch (error) {
    await handle($, error)
  }
}

async function startLogin($: $) {
  const clientId = (await $.store.get('clientId')) as string | undefined
  if (!clientId) return
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  await $.store.set('verifier', verifier)
  const authUrl =
    `${ACCOUNTS}/authorize?` +
    form({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      code_challenge_method: 'S256',
      code_challenge: base64url(new Uint8Array(digest)),
      scope: SCOPES,
    })
  await update($, view, v => ({ ...v, authUrl, error: undefined }))
}

async function finishLogin($: $, pasted: string) {
  const text = pasted.trim()
  let code = text
  try {
    const url = new URL(text)
    const denied = url.searchParams.get('error')
    if (denied) return setError($, `Spotify no autorizó: ${denied}`)
    code = url.searchParams.get('code') ?? ''
  } catch {}
  if (!code) return setError($, 'No encontré el parámetro "code" en lo que pegaste.')
  const clientId = (await $.store.get('clientId')) as string
  const verifier = (await $.store.get('verifier')) as string
  await update($, view, v => ({ ...v, isBusy: true }))
  const res = await $.http.fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }),
  })
  if (!res.ok) return setError($, reason(res.status, res.text))
  await saveTokens($, res.text)
  await $.store.delete('verifier')
  await update($, view, () => ({ phase: 'ready' }))
  await loadPlaylists($)
  await poll($)
}

async function logout($: $) {
  await $.store.delete('tokens')
  await update($, view, () => ({ phase: 'needs-login' }))
  await update($, player, () => null)
  await update($, playlists, () => [])
}

async function forgetClient($: $) {
  await $.store.delete('tokens')
  await $.store.delete('clientId')
  await update($, view, () => ({ phase: 'needs-client' }))
  await update($, player, () => null)
  await update($, playlists, () => [])
}

// Runs work a press or a timer started, so a failure lands in the card
// instead of as an unhandled rejection.
function fire($: $, work: Promise<unknown>) {
  work.catch(error => handle($, error).catch(() => {}))
}

function bar(progress: number, width: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, progress)) * width)
  return '━'.repeat(filled) + '─'.repeat(Math.max(0, width - filled))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'spotify',
      description: 'Abre el panel de Spotify (qué suena, controles y playlists)',
    })
    const clientId = await $.store.get('clientId')
    const tokens = (await $.store.get('tokens')) as Tokens | undefined
    await update($, view, () => ({
      phase: !clientId ? 'needs-client' : tokens?.refresh ? 'ready' : 'needs-login',
    }))
    void $.ui.open({ id: PANE, title: TITLE })
    if (tokens?.refresh) {
      fire($, loadPlaylists($).then(() => poll($)))
    }
    $.clock.every(POLL_MS, () => fire($, poll($)))

    return started
  })

  on('command.run', { command: 'spotify' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    fire($, poll($))

    return { text: 'Panel de Spotify abierto.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Link } = els
    // Mobile draws neither a text field nor a picker.
    const Input = e.surface !== 'mobile' && 'Input' in els ? els.Input : undefined
    const Select = e.surface !== 'mobile' && 'Select' in els ? els.Select : undefined
    const v = await read($, view)
    const now = await read($, player)
    const lists = await read($, playlists)
    // The card's border and padding take 4 columns.
    const inner = Math.max(10, e.props.bodyColumns - 4)

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text color="success" weight="semibold">
          ● Spotify
        </Text>
        {v.isBusy ? <Text dimColor>…</Text> : now?.device ? <Text dimColor wrap="truncate">{now.device}</Text> : null}
      </Box>
    )
    const error = v.error ? (
      <Text color="error" wrap="wrap">
        {v.error}
      </Text>
    ) : null

    let body
    if (v.phase === 'needs-client') {
      body = (
        <Box flexDirection="column" gap="sm">
          <Text wrap="wrap">
            Para conectar, creá una app en developer.spotify.com/dashboard con la Redirect URI{' '}
            <Text weight="semibold">{REDIRECT_URI}</Text> y pegá su Client ID.
          </Text>
          <Link href="https://developer.spotify.com/dashboard" label="Abrir el dashboard de Spotify" />
          {Input ? (
            <Input
              key="client-id"
              placeholder="Client ID"
              submitLabel="guardar"
              onSubmit={(value: string) => {
                const id = value.trim()
                if (!/^[0-9a-zA-Z]{16,64}$/.test(id)) return fire($, setError($, 'Ese Client ID no parece válido.'))
                fire(
                  $,
                  $.store.set('clientId', id).then(() => update($, view, () => ({ phase: 'needs-login' as const }))),
                )
              }}
            />
          ) : (
            <Text dimColor>Configurá el Client ID desde la terminal o el escritorio.</Text>
          )}
        </Box>
      )
    } else if (v.phase === 'needs-login') {
      body = (
        <Box flexDirection="column" gap="sm">
          {!v.authUrl ? (
            <Button key="login" variant="primary" onPress={() => fire($, startLogin($))}>
              Conectar con Spotify
            </Button>
          ) : (
            <Box flexDirection="column" gap="sm">
              <Text wrap="wrap">1. Autorizá el acceso:</Text>
              <Link href={v.authUrl} label="Abrir Spotify y autorizar" />
              <Text wrap="wrap">
                2. El navegador va a terminar en una página que no carga ({REDIRECT_URI}…). Copiá esa URL
                completa y pegala acá:
              </Text>
              {Input && (
                <Input
                  key="auth-code"
                  placeholder="http://127.0.0.1:8888/callback?code=…"
                  submitLabel="conectar"
                  onSubmit={(value: string) => fire($, finishLogin($, value))}
                />
              )}
            </Box>
          )}
          <Button key="forget-client" plain dimColor onPress={() => fire($, forgetClient($))}>
            Cambiar Client ID
          </Button>
        </Box>
      )
    } else {
      const bars = Math.max(4, inner - 12)
      const playlistValue = now?.contextUri && lists.some(l => l.uri === now.contextUri) ? now.contextUri : undefined
      const play = (uri: string) => control($, 'PUT', '/me/player/play', { context_uri: uri })
      body = (
        <Box flexDirection="column" gap="sm">
          {now ? (
            <Box flexDirection="column">
              <Text weight="semibold" size="heading" wrap="truncate">
                {now.title}
              </Text>
              <Text wrap="truncate">{now.artists}</Text>
              {now.album ? (
                <Text dimColor wrap="truncate">
                  {now.album}
                </Text>
              ) : null}
            </Box>
          ) : (
            <Text dimColor wrap="wrap">
              Nada sonando. Abrí Spotify en algún dispositivo o elegí una playlist.
            </Text>
          )}
          {now ? (
            <Box flexDirection="row" gap={1}>
              <Text dimColor tabular>
                {clock(now.progressMs)}
              </Text>
              <Text color={now.isPlaying ? 'success' : 'subtle'}>{bar(now.progressMs / (now.durationMs || 1), bars)}</Text>
              <Text dimColor tabular>
                {clock(now.durationMs)}
              </Text>
            </Box>
          ) : null}
          <Box flexDirection="row" justifyContent="center" gap={1}>
            <Button key="prev" hotkey="p" onPress={() => fire($, control($, 'POST', '/me/player/previous'))}>
              ⏮
            </Button>
            <Button
              key="toggle"
              hotkey="k"
              variant="primary"
              onPress={() => fire($, control($, 'PUT', now?.isPlaying ? '/me/player/pause' : '/me/player/play'))}
            >
              {now?.isPlaying ? '⏸' : '▶'}
            </Button>
            <Button key="next" hotkey="n" onPress={() => fire($, control($, 'POST', '/me/player/next'))}>
              ⏭
            </Button>
          </Box>
          {lists.length > 0 &&
            (Select ? (
              <Select
                key="playlist"
                label="Playlist"
                value={playlistValue}
                options={lists.map(l => ({ value: l.uri, label: `${l.name} (${l.tracks})` }))}
                onSelect={(uri: string) => fire($, play(uri))}
              />
            ) : (
              <Box flexDirection="column">
                <Text dimColor>Playlists</Text>
                {lists.slice(0, 10).map(l => (
                  <Button key={`pl-${l.uri}`} plain onPress={() => fire($, play(l.uri))}>
                    {l.uri === now?.contextUri ? '♪ ' : ''}
                    {l.name}
                  </Button>
                ))}
              </Box>
            ))}
          <Box flexDirection="row" justifyContent="space-between">
            <Button
              key="refresh"
              plain
              dimColor
              onPress={() => fire($, loadPlaylists($).then(() => poll($)))}
            >
              Actualizar
            </Button>
            <Button key="logout" plain dimColor onPress={() => fire($, logout($))}>
              Desconectar
            </Button>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} gap="sm">
        {header}
        {error}
        {body}
      </Box>
    )
  })
}
