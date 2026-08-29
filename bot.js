'use strict'

const bedrock = require('bedrock-protocol')
const { Authflow, Titles } = require('prismarine-auth')

const HOST = "bagelsmp.org"
const PORT = 19132
const PROFILE_ID = process.argv[2]
const AUTH_CACHE_DIR = './auther/'+process.argv[2]

const KEEPALIVE_MS = 240000
const RECONNECT_INITIAL_MS = 5000
const RECONNECT_MAX_MS = 60000
const CONNECT_TIMEOUT_MS = 30000

let client = null
let keepaliveTimer = null
let reconnectTimer = null

let entityId = null
let anchorPosition = null
let movementTick = 0n

let connected = false
let connecting = false
let endingSession = false
let stopping = false
let reconnectDelay = RECONNECT_INITIAL_MS

const colors = {
  '0': '\x1b[30m',
  '1': '\x1b[34m',
  '2': '\x1b[32m',
  '3': '\x1b[36m',
  '4': '\x1b[31m',
  '5': '\x1b[35m',
  '6': '\x1b[33m',
  '7': '\x1b[37m',
  '8': '\x1b[90m',
  '9': '\x1b[94m',
  'a': '\x1b[92m',
  'b': '\x1b[96m',
  'c': '\x1b[91m',
  'd': '\x1b[95m',
  'e': '\x1b[93m',
  'f': '\x1b[97m',
  'k': '\x1b[5m',
  'l': '\x1b[1m',
  'm': '\x1b[9m',
  'n': '\x1b[4m',
  'o': '\x1b[3m',
  'r': '\x1b[0m'
};

function minecraftColor(message) {
  return message.replace(
    /§([0-9a-fk-or])/gi,
    (_, code) => colors[code.toLowerCase()] || ''
  ) + '\x1b[0m';
}

function log(...args) {
  console.log(
    PROFILE_ID,
    getDateTime(),
    ...args.map(arg => typeof arg === 'string' ? minecraftColor(arg) : arg)
  );
}

function getDateTime() {
  const now = new Date();

  const day = now.getDate();
  const hour = now.getHours();
  const minute = now.getMinutes();

  return `${day}/${hour}-${minute}`;
}

function readInteger(name, fallback, minimum) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number.parseInt(raw, 10)
  if (Number.isFinite(value) && value >= minimum) return value

  log(`Invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`)
  return fallback
}

function toJson(value) {
  if (value === undefined) return '(undefined)'

  try {
    return JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item
    )
  } catch (error) {
    return `[unable to serialize: ${error.message}]`
  }
}

function clearKeepalive() {
  if (!keepaliveTimer) return

  clearInterval(keepaliveTimer)
  keepaliveTimer = null
}

function clearReconnect() {
  if (!reconnectTimer) return

  clearTimeout(reconnectTimer)
  reconnectTimer = null
}

function resetSessionState() {
  entityId = null
  anchorPosition = null
  movementTick = 0n
  connected = false
  connecting = false
}

function closeClient(reason = 'Client closing') {
  if (!client) return

  const oldClient = client
  client = null

  try {
    oldClient.removeAllListeners()

    oldClient.on('error', (error) => {
      log('Ignored late client error:', error?.message || error)
    })
  } catch (_) {}

  try {
    if (
      oldClient.connection?.connected === true &&
      typeof oldClient.disconnect === 'function'
    ) {
      oldClient.disconnect(reason, true)
    } else if (typeof oldClient.close === 'function') {
      oldClient.close()
    }
  } catch (error) {
    log('Client close warning:', error?.message || error)
  }
}

function scheduleReconnect(reason) {
  if (stopping || reconnectTimer) return

  const delay = reconnectDelay
  log(`Reconnect scheduled in ${delay} ms (reason: ${reason})`)

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null

    startBot().catch((error) => {
      log('Reconnect failed:', error?.stack || error?.message || error)
      finishSession('reconnect-error')
    })
  }, delay)

  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
}

function finishSession(reason) {
  if (stopping || endingSession) return

  endingSession = true
  log(`Finishing session (reason: ${reason})`)

  clearKeepalive()
  resetSessionState()
  closeClient(`Session ended: ${reason}`)
  scheduleReconnect(reason)
}

function sendKeepalive(position) {
  if (!client || !connected || entityId === null) return

  movementTick += 1n

  client.queue('move_player', {
    runtime_entity_id: entityId,
    position,
    pitch: 0,
    yaw: 0,
    head_yaw: 0,
    mode: 0,
    on_ground: true,
    ridden_runtime_entity_id: 0n,
    teleport_cause: 0,
    teleport_source_entity_type: 0,
    tick: movementTick
  })
}

function startKeepalive() {
  clearKeepalive()

  let moved = false

  keepaliveTimer = setInterval(() => {
    if (!client || !connected || entityId === null || !anchorPosition) return

    try {
      moved = !moved

      const position = moved
        ? {
            x: anchorPosition.x + 0.03,
            y: anchorPosition.y,
            z: anchorPosition.z
          }
        : { ...anchorPosition }

      sendKeepalive(position)
      log(moved ? 'Moved slightly off anchor' : 'Returned to anchor')
    } catch (error) {
      log('Keepalive failed:', error?.stack || error?.message || error)
      finishSession('keepalive-error')
    }
  }, KEEPALIVE_MS)

  log(`Keepalive enabled every ${KEEPALIVE_MS} ms`)
}

function showMicrosoftCode(code) {
  const userCode = code?.user_code || null
  const verificationUri =
    code?.verification_uri || 'https://www.microsoft.com/link'

  let signInUrl = verificationUri

  if (userCode) {
    try {
      const url = new URL(verificationUri)
      url.searchParams.set('otc', userCode)
      signInUrl = url.toString()
    } catch (_) {
      signInUrl =
        `https://www.microsoft.com/link?otc=${encodeURIComponent(userCode)}`
    }
  }

  log('=== MICROSOFT SIGN-IN REQUIRED ===')
  log(`COPY/OPEN THIS LINK: ${signInUrl}`)

  if (userCode) {
    log(`Fallback code: ${userCode}`)
  }

  if (Number.isFinite(code?.expires_in)) {
    const minutes = Math.ceil(code.expires_in / 60)
    log(`This code expires in about ${minutes} minute(s).`)
  }

  log('Do not restart the bot while sign-in is pending.')
  log('=================================')
}

function attachClientHandlers(newClient) {
  // Keep only the targeted malformed-login diagnostic.
  newClient.on('packet', (packet) => {
    if (packet?.data?.name !== 'packet_violation_warning') return

    log('PACKET VIOLATION WARNING:', toJson(packet.data.params))
  })

  newClient.on('session', (profile) => {
    const name = profile?.name || 'unknown player'
    log(`Microsoft/Xbox authentication completed as ${name}`)
  })

  newClient.on('join', () => {
    connected = true
    connecting = false
    endingSession = false
    reconnectDelay = RECONNECT_INITIAL_MS
    clearReconnect()

    log('Joined server')
  })

  newClient.on('start_game', (packet) => {
    entityId = packet?.runtime_entity_id ?? newClient.entityId ?? null

    if (entityId !== null) {
      log(`Runtime entity ID set to ${String(entityId)}`)
    }

    if (packet?.player_position) {
      anchorPosition = {
        x: packet.player_position.x,
        y: packet.player_position.y,
        z: packet.player_position.z
      }

      log(
        `Anchor position set to ${anchorPosition.x}, ` +
        `${anchorPosition.y}, ${anchorPosition.z}`
      )
    }
  })

  newClient.on('spawn', () => {
    log('Spawned')
    startKeepalive()
  })

  newClient.on('text', (packet) => {
    const source = packet?.source_name || 'server'
    const message = packet?.message || ''
    const parameters =
      Array.isArray(packet?.parameters) && packet.parameters.length
        ? ` | parameters=${toJson(packet.parameters)}`
        : ''

    log(`[CHAT] ${source}: ${message}${parameters}`)
  })

  newClient.on('disconnect', (packet) => {
    log('Server disconnect:', toJson(packet))
  })

  newClient.on('kick', (reason) => {
    log('Kicked:', toJson(reason))
  })

  newClient.on('error', (error) => {
    log('Client error:', error?.stack || error?.message || error)

    if (!connected) {
      finishSession('client-error')
    }
  })

  newClient.on('end', () => {
    log('Connection ended')
    finishSession('end')
  })

  newClient.on('close', () => {
    log('Connection closed')
    finishSession('close')
  })
}

async function startBot() {
  if (stopping) return

  if (connecting || connected) {
    log('Connect skipped because a session is already active')
    return
  }

  clearReconnect()
  clearKeepalive()
  closeClient()
  resetSessionState()

  connecting = true
  endingSession = false

  log(`Connecting to ${HOST}:${PORT} with Microsoft/Xbox authentication`)
  log(`Using auth cache: ${AUTH_CACHE_DIR}`)
  log(`Using local auth profile ID: ${PROFILE_ID}`)
  log(`Post-authentication network timeout: ${CONNECT_TIMEOUT_MS} ms`)

  try {
    const authFlow = new Authflow(
      PROFILE_ID,
      AUTH_CACHE_DIR,
      {
        flow: 'live',
        authTitle: Titles.MinecraftNintendoSwitch,
        deviceType: 'Nintendo'
      },
      showMicrosoftCode
    )

    client = bedrock.createClient({
      host: HOST,
      port: PORT,
      authflow: authFlow,
      connectTimeout: CONNECT_TIMEOUT_MS,
      viewDistance: 1
    })

    attachClientHandlers(client)
  } catch (error) {
    log('Startup failed:', error?.stack || error?.message || error)
    finishSession('startup-error')
  }
}

function shutdown(signal) {
  if (stopping) return

  stopping = true
  log(`Received ${signal}; shutting down...`)

  clearReconnect()
  clearKeepalive()
  resetSessionState()
  closeClient('Bot shutting down')

  setTimeout(() => process.exit(0), 250)
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

process.on('uncaughtException', (error) => {
  log('Uncaught exception:', error?.stack || error?.message || error)
  finishSession('uncaught-exception')
})

process.on('unhandledRejection', (reason) => {
  log('Unhandled rejection:', reason?.stack || reason?.message || reason)
  finishSession('unhandled-rejection')
})

startBot().catch((error) => {
  log('Fatal startup error:', error?.stack || error?.message || error)
  finishSession('fatal-startup')
})
