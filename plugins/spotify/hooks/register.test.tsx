import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'spotify',
  component: 'Pane',
  requestId: 'spotify',
  props: {
    title: 'Spotify',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const PLAYER = {
  is_playing: true,
  progress_ms: 61000,
  device: { name: 'MacBook' },
  context: { uri: 'spotify:playlist:abc' },
  item: {
    name: 'Bohemian Rhapsody',
    duration_ms: 354000,
    artists: [{ name: 'Queen' }],
    album: { name: 'A Night at the Opera' },
  },
}

const PLAYLISTS = {
  items: [
    { uri: 'spotify:playlist:abc', name: 'Clásicos', tracks: { total: 42 } },
    { uri: 'spotify:playlist:def', name: 'Para codear', tracks: { total: 120 } },
  ],
}

test('connected: shows the track, skips ahead and changes playlist on every surface', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  mock.store(on, {
    clientId: 'abcdef0123456789abcdef0123456789',
    tokens: { access: 'tok', refresh: 'ref', expiresAt: 10_000_000 },
  })
  const calls: string[] = []
  on('http.fetch', (_, e) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.replace('https://api.spotify.com/v1', '')
    calls.push(`${method} ${path}${e.init?.body ? ' ' + e.init.body : ''}`)
    if (path === '/me/player') return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(PLAYER) } }
    if (path.startsWith('/me/playlists'))
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(PLAYLISTS) } }
    return { value: { status: 204, ok: true, headers: {}, text: '' } }
  })
  on('command.register', () => ({ value: { command: 'spotify' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Bohemian Rhapsody/ }))?.text).toBe('Bohemian Rhapsody')
    expect(await ui.find({ type: 'Text', text: /^1:01$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /MacBook/ })).toBeDefined()

    calls.length = 0
    await ui.press({ key: 'next' })
    expect(calls).toContain('POST /me/player/next')

    calls.length = 0
    await ui.select({ key: 'playlist', value: 'spotify:playlist:def' })
    expect(calls).toContain('PUT /me/player/play {"context_uri":"spotify:playlist:def"}')
    await ui.unmount()
  }

  // Mobile has no Select: the playlists are buttons.
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  calls.length = 0
  await ui.press({ key: 'pl-spotify:playlist:def' })
  expect(calls).toContain('PUT /me/player/play {"context_uri":"spotify:playlist:def"}')
  await ui.unmount()
})

test('not connected: asks for the Client ID, then offers the login', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'spotify' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'client-id', text: 'abcdef0123456789abcdef0123456789' })
  expect(await ui.find({ key: 'login' })).toBeDefined()
  await ui.press({ key: 'login' })
  expect(await ui.find({ key: 'auth-code' })).toBeDefined()
  await ui.unmount()
})
