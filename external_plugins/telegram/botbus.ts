export const BOTBUS_ROLE_AGENT = 'agent' as const
export const BOTBUS_ROLE_HUMAN_ADMIN = 'human-admin' as const
export const BOTBUS_BROADCAST = 'broadcast' as const
export const BOTBUS_DROP = 'drop' as const

export type BotBusRole = typeof BOTBUS_ROLE_AGENT | typeof BOTBUS_ROLE_HUMAN_ADMIN
export type BotBusFallback = typeof BOTBUS_BROADCAST | typeof BOTBUS_DROP

export type BotBusPrincipal = {
  name: string
  role: BotBusRole
}

export type BotBusConfig = {
  channelId: string
  self: string
  agents: string[]
  principals: Record<string, BotBusPrincipal>
  unaddressed: Partial<Record<BotBusRole, BotBusFallback>>
}

export type BotBusInbound = {
  chatId: string
  fromId?: string
  senderChatId?: string
  text: string
  authorSignature?: string
}

export type BotBusRoute = {
  applies: boolean
  deliver: boolean
  content: string
  reason?: string
  senderKey?: string
  senderName?: string
  senderRole?: BotBusRole
  recipients?: string
  authorSignature?: string
  senderChatId?: string
  fallback: boolean
}

const AGENT_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const PRINCIPAL_KEY_RE = /^(user|sender_chat):-?[0-9]+$/
const HEADER_RE = /^\[botbus:v1 to=(\*|[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:,[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*)\]$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ID_RE.test(value)
}

function validateBotBusConfig(config: BotBusConfig): Set<string> {
  if (!config || typeof config.channelId !== 'string' || config.channelId === '') {
    throw new Error('botBus.channelId is required')
  }
  if (!validAgentId(config.self)) throw new Error(`invalid botBus.self ${JSON.stringify(config.self)}`)
  if (!Array.isArray(config.agents)) throw new Error('botBus.agents must be an array')

  const agents = new Set<string>()
  for (const id of config.agents) {
    if (!validAgentId(id)) throw new Error(`invalid botBus agent ${JSON.stringify(id)}`)
    if (agents.has(id)) throw new Error(`duplicate botBus agent ${JSON.stringify(id)}`)
    agents.add(id)
  }
  if (!agents.has(config.self)) {
    throw new Error(`botBus.self ${JSON.stringify(config.self)} is not listed in agents`)
  }

  const principals = config.principals ?? {}
  if (!isRecord(principals)) throw new Error('botBus.principals must be an object')
  for (const [key, raw] of Object.entries(principals)) {
    if (!PRINCIPAL_KEY_RE.test(key)) throw new Error(`invalid botBus principal key ${JSON.stringify(key)}`)
    if (!isRecord(raw) || !validAgentId(raw.name)) {
      throw new Error(`invalid botBus principal name for ${JSON.stringify(key)}`)
    }
    if (raw.role === BOTBUS_ROLE_AGENT) {
      if (!agents.has(raw.name)) {
        throw new Error(`agent principal ${JSON.stringify(raw.name)} is not listed in agents`)
      }
    } else if (raw.role !== BOTBUS_ROLE_HUMAN_ADMIN) {
      throw new Error(`invalid botBus role ${JSON.stringify(raw.role)}`)
    }
  }

  const unaddressed = config.unaddressed ?? {}
  if (!isRecord(unaddressed)) throw new Error('botBus.unaddressed must be an object')
  for (const [role, policy] of Object.entries(unaddressed)) {
    if (role !== BOTBUS_ROLE_AGENT && role !== BOTBUS_ROLE_HUMAN_ADMIN) {
      throw new Error(`invalid botBus unaddressed role ${JSON.stringify(role)}`)
    }
    if (policy !== BOTBUS_BROADCAST && policy !== BOTBUS_DROP) {
      throw new Error(`invalid botBus unaddressed policy ${JSON.stringify(policy)}`)
    }
  }
  return agents
}

function firstLine(text: string): [string, string] {
  const newline = text.indexOf('\n')
  if (newline < 0) return [text.endsWith('\r') ? text.slice(0, -1) : text, '']
  const rawLine = text.slice(0, newline)
  return [rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine, text.slice(newline + 1)]
}

/**
 * Apply authenticated sender lookup and v1 address filtering. Telegram's
 * author_signature is returned as display metadata only and never grants
 * trust. If fromId exists it is authoritative; senderChatId is considered
 * only when Telegram omitted from entirely.
 */
export function routeBotBus(config: BotBusConfig | undefined, inbound: BotBusInbound): BotBusRoute {
  const route: BotBusRoute = {
    applies: false,
    deliver: true,
    content: inbound.text,
    authorSignature: inbound.authorSignature,
    senderChatId: inbound.senderChatId,
    fallback: false,
  }
  if (!config || inbound.chatId !== config.channelId) return route

  route.applies = true
  route.deliver = false
  let agents: Set<string>
  try {
    agents = validateBotBusConfig(config)
  } catch {
    route.reason = 'invalid-config'
    return route
  }

  route.senderKey = inbound.fromId
    ? `user:${inbound.fromId}`
    : inbound.senderChatId
      ? `sender_chat:${inbound.senderChatId}`
      : undefined
  if (!route.senderKey) {
    route.reason = 'missing-sender'
    return route
  }

  const principal = config.principals?.[route.senderKey]
  if (!principal) {
    route.reason = 'unknown-sender'
    return route
  }
  route.senderName = principal.name
  route.senderRole = principal.role
  if (principal.role === BOTBUS_ROLE_AGENT && principal.name === config.self) {
    route.reason = 'self-message'
    return route
  }

  const [line, body] = firstLine(inbound.text)
  const match = HEADER_RE.exec(line)
  if (!match) {
    if (line.startsWith('[botbus:')) {
      route.reason = 'malformed-header'
      return route
    }
    if (config.unaddressed?.[principal.role] !== BOTBUS_BROADCAST) {
      route.reason = 'unaddressed-policy'
      return route
    }
    route.deliver = true
    route.fallback = true
    route.recipients = '*'
    return route
  }

  route.content = body
  route.recipients = match[1]!
  if (route.recipients === '*') {
    route.deliver = true
    return route
  }

  let addressed = false
  const seen = new Set<string>()
  for (const id of route.recipients.split(',')) {
    if (seen.has(id)) {
      route.reason = 'duplicate-recipient'
      return route
    }
    seen.add(id)
    if (!agents.has(id)) {
      route.reason = 'unknown-recipient'
      return route
    }
    if (id === config.self) addressed = true
  }
  if (!addressed) {
    route.reason = 'not-addressed'
    return route
  }
  route.deliver = true
  return route
}

/** Build and validate an outbound routing header. Empty recipients is legacy/unaddressed. */
export function botBusHeader(
  config: BotBusConfig | undefined,
  chatId: string,
  recipients: string[],
): string {
  if (recipients.length === 0) return ''
  if (!config || chatId !== config.channelId) {
    throw new Error('recipients require the configured bot-bus channel')
  }
  const agents = validateBotBusConfig(config)
  const clean: string[] = []
  const seen = new Set<string>()
  for (const id of recipients) {
    if (id === '*') {
      if (recipients.length !== 1) throw new Error('bot-bus wildcard must be the only recipient')
      return '[botbus:v1 to=*]'
    }
    if (!validAgentId(id) || !agents.has(id)) {
      throw new Error(`unknown bot-bus recipient ${JSON.stringify(id)}`)
    }
    if (!seen.has(id)) {
      seen.add(id)
      clean.push(id)
    }
  }
  return `[botbus:v1 to=${clean.join(',')}]`
}

/** Make a literal routing header safe inside a MarkdownV2 message. */
export function escapeMarkdownV2Literal(text: string): string {
  return text.replace(/([_\-*\[\]()~`>#+=|{}.!\\])/g, '\\$1')
}
