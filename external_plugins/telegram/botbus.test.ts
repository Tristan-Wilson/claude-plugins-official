import { describe, expect, test } from 'bun:test'
import {
  BOTBUS_BROADCAST,
  BOTBUS_DROP,
  BOTBUS_ROLE_AGENT,
  BOTBUS_ROLE_HUMAN_ADMIN,
  botBusHeader,
  escapeMarkdownV2Literal,
  routeBotBus,
  type BotBusConfig,
  type BotBusInbound,
} from './botbus.ts'

function testConfig(): BotBusConfig {
  return {
    channelId: '-1009000',
    self: 'agent-b',
    agents: ['agent-a', 'agent-b', 'agent-c'],
    principals: {
      'user:1001': { name: 'agent-a', role: BOTBUS_ROLE_AGENT },
      'user:2001': { name: 'admin-one', role: BOTBUS_ROLE_HUMAN_ADMIN },
      'sender_chat:-9001': { name: 'admin-channel', role: BOTBUS_ROLE_HUMAN_ADMIN },
    },
    unaddressed: {
      [BOTBUS_ROLE_AGENT]: BOTBUS_BROADCAST,
      [BOTBUS_ROLE_HUMAN_ADMIN]: BOTBUS_BROADCAST,
    },
  }
}

describe('routeBotBus conformance', () => {
  const base: BotBusInbound = {
    chatId: '-1009000',
    fromId: '1001',
    text: '[botbus:v1 to=agent-b]\nhello',
  }

  test('delivers and strips single, multiple, and wildcard headers', () => {
    for (const [text, to] of [
      ['[botbus:v1 to=agent-b]\nhello', 'agent-b'],
      ['[botbus:v1 to=agent-a,agent-b]\r\nhello', 'agent-a,agent-b'],
      ['[botbus:v1 to=*]\nhello', '*'],
    ]) {
      expect(routeBotBus(testConfig(), { ...base, text })).toMatchObject({
        applies: true,
        deliver: true,
        content: 'hello',
        recipients: to,
        senderName: 'agent-a',
        senderRole: 'agent',
        fallback: false,
      })
    }
  })

  test('drops valid messages for other agents and unknown or duplicate recipients', () => {
    expect(routeBotBus(testConfig(), { ...base, text: '[botbus:v1 to=agent-c]\nhello' }).reason)
      .toBe('not-addressed')
    expect(routeBotBus(testConfig(), { ...base, text: '[botbus:v1 to=agent-z]\nhello' }).reason)
      .toBe('unknown-recipient')
    expect(routeBotBus(testConfig(), { ...base, text: '[botbus:v1 to=agent-b,agent-b]\nhello' }).reason)
      .toBe('duplicate-recipient')
  })

  test('malformed routing-looking headers never become fallback broadcasts', () => {
    const route = routeBotBus(testConfig(), { ...base, text: '[botbus:v1 to=agent-b\nhello' })
    expect(route).toMatchObject({ deliver: false, reason: 'malformed-header', fallback: false })
  })

  test('trusted humans and agents can use configured no-header broadcast fallback', () => {
    expect(routeBotBus(testConfig(), { ...base, fromId: '2001', text: 'manual post' })).toMatchObject({
      deliver: true,
      recipients: '*',
      senderName: 'admin-one',
      fallback: true,
    })
    expect(routeBotBus(testConfig(), { ...base, text: 'legacy agent post' })).toMatchObject({
      deliver: true,
      recipients: '*',
      senderName: 'agent-a',
      fallback: true,
    })
    const config = testConfig()
    config.unaddressed.agent = BOTBUS_DROP
    expect(routeBotBus(config, { ...base, text: 'legacy agent post' }).reason)
      .toBe('unaddressed-policy')
  })

  test('authenticates from.id first and uses sender_chat.id only when from is absent', () => {
    expect(routeBotBus(testConfig(), { ...base, fromId: '9999', senderChatId: '-9001' }).reason)
      .toBe('unknown-sender')
    expect(routeBotBus(testConfig(), { ...base, fromId: undefined, senderChatId: '-9001' }))
      .toMatchObject({ deliver: true, senderName: 'admin-channel' })
  })

  test('author_signature is display metadata and cannot authenticate', () => {
    expect(routeBotBus(testConfig(), {
      ...base,
      fromId: '9999',
      authorSignature: 'agent-a',
    })).toMatchObject({
      deliver: false,
      reason: 'unknown-sender',
      authorSignature: 'agent-a',
    })
  })

  test('suppresses the receiving agent own authenticated posts', () => {
    const config = testConfig()
    config.principals['user:1002'] = { name: 'agent-b', role: BOTBUS_ROLE_AGENT }
    expect(routeBotBus(config, { ...base, fromId: '1002' }).reason).toBe('self-message')
  })

  test('is fully backward compatible outside the configured bus', () => {
    const invalid = { ...base, fromId: '9999', text: '[botbus:not-valid' }
    expect(routeBotBus(undefined, invalid)).toMatchObject({ applies: false, deliver: true, content: invalid.text })
    const config = testConfig()
    config.channelId = '-1008000'
    expect(routeBotBus(config, invalid)).toMatchObject({ applies: false, deliver: true, content: invalid.text })
  })
})

describe('botBusHeader', () => {
  test('canonicalizes known recipients and wildcard', () => {
    expect(botBusHeader(testConfig(), '-1009000', [])).toBe('')
    expect(botBusHeader(testConfig(), '-1009000', ['agent-b'])).toBe('[botbus:v1 to=agent-b]')
    expect(botBusHeader(testConfig(), '-1009000', ['agent-a', 'agent-a', 'agent-b']))
      .toBe('[botbus:v1 to=agent-a,agent-b]')
    expect(botBusHeader(testConfig(), '-1009000', ['*'])).toBe('[botbus:v1 to=*]')
  })

  test('rejects unknown recipients, mixed wildcard, and non-bus chats', () => {
    expect(() => botBusHeader(testConfig(), '-1009000', ['agent-z'])).toThrow('unknown')
    expect(() => botBusHeader(testConfig(), '-1009000', ['*', 'agent-a'])).toThrow('wildcard')
    expect(() => botBusHeader(testConfig(), '-1008000', ['agent-a'])).toThrow('configured bot-bus')
  })

  test('escapes literal headers for MarkdownV2', () => {
    expect(escapeMarkdownV2Literal('[botbus:v1 to=agent-b]'))
      .toBe('\\[botbus:v1 to\\=agent\\-b\\]')
  })
})
