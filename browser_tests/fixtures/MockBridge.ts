/**
 * MockBridge — a scriptable, agent-free fake of the panel orchestrator ("bridge").
 *
 * The real Agent panel connects to a bridge WebSocket that fronts a Claude/Codex
 * agent. Those backends need auth, cost money, and are non-deterministic, so the
 * Tier 1 suite points the panel at THIS instead. It speaks exactly the frame
 * shapes the panel's `createBridgeClient` expects (see
 * web/js/comfyui-mcp-panel.js ~line 3412 onward).
 *
 * Frames the panel RECEIVES (server -> client) that we emit:
 *   - { type: "models", models: [{id,label,small?}], current?, backend? }
 *       The HANDSHAKE — receiving this is the ONLY thing that flips the panel's
 *       status pill to "connected".
 *   - { type: "commands", commands: [...] }                slash-command catalog
 *   - { type: "agent_status", context_pct?, cost_usd?, model? }
 *   - { type: "ack", kind: "ready"|"working"|"seen"|..., mid? }
 *   - { type: "say", text, id?, streamed? }                committed reply
 *   - { type: "stream", phase: "think"|"text"|"end", id, delta? }  live deltas
 *   - { type: "turn", state: "working"|"done" }            turn lifecycle
 *
 * Frames the panel SENDS (client -> server) that we parse:
 *   - { type: "hello", tab_id, title, resume? }            on connect
 *   - { type: "user_message", text, context?, images?, mid? }
 *   - { type: "title" | "set_options" | "interrupt" | ... }  control frames
 *   - { rid, ok, result|error }                            command replies
 */
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'

export interface MockModel {
  id: string
  label: string
  small?: string
}

export interface MockBridgeOptions {
  /** TCP port to bind. Default 0 = let the OS pick a free port (recommended for
   *  parallel tests — read the real port via `mockBridge.url`). */
  port?: number
  /** Model catalog sent on the handshake. */
  models?: MockModel[]
  /** Backend id reported on the handshake ("claude" | "codex"). */
  backend?: string
  /** Slash-command catalog sent on the handshake. */
  commands?: unknown[]
  /** Optional greeting `say` painted as an agent bubble right after handshake. */
  greeting?: string | null
  /** Auto-emit `ack { kind:"ready" }` after the handshake (default true). */
  ackReady?: boolean
  /** Auto-emit `ack { kind:"working", mid }` on every received user_message so
   *  the panel's 7s delivery timer is cancelled (default true). */
  autoAckWorking?: boolean
  /** Auto-respond to graph command requests ({rid,cmd}) with a generic ok reply
   *  so the panel never hangs awaiting a tool result (default true). */
  autoReplyCommands?: boolean
}

export interface UserMessage {
  text: string
  mid?: string
  context?: unknown
  images?: unknown[]
  raw: Record<string, unknown>
}

const DEFAULT_MODELS: MockModel[] = [
  { id: 'claude-mock-sonnet', label: 'Mock Sonnet', small: 'test' },
  { id: 'claude-mock-opus', label: 'Mock Opus', small: 'test' }
]

type UserMessageCb = (msg: UserMessage) => void
type FrameCb = (frame: Record<string, unknown>) => void

export class MockBridge {
  private wss: WebSocketServer | null = null
  private readonly opts: Required<Omit<MockBridgeOptions, 'greeting'>> & {
    greeting: string | null
  }
  private readonly sockets = new Set<WebSocket>()
  private readonly userMessageCbs = new Set<UserMessageCb>()
  private readonly frameCbs = new Set<FrameCb>()
  private readonly userMessages: UserMessage[] = []
  private readonly userMessageWaiters: Array<(m: UserMessage) => void> = []
  private streamSeq = 0

  constructor(options: MockBridgeOptions = {}) {
    this.opts = {
      port: options.port ?? 0,
      models: options.models ?? DEFAULT_MODELS,
      backend: options.backend ?? 'claude',
      commands: options.commands ?? [
        { cmd: '/compact', description: 'Compact the conversation' }
      ],
      greeting: options.greeting ?? 'Panel agent ready.',
      ackReady: options.ackReady ?? true,
      autoAckWorking: options.autoAckWorking ?? true,
      autoReplyCommands: options.autoReplyCommands ?? true
    }
  }

  /** Start listening. Resolves once the server is bound. */
  async start(): Promise<this> {
    if (this.wss) return this
    await new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.opts.port, host: '127.0.0.1' })
      wss.on('listening', () => resolve())
      wss.on('error', reject)
      wss.on('connection', (sock) => this.handleConnection(sock))
      this.wss = wss
    })
    return this
  }

  /** The ws:// URL the panel should connect to (host:port actually bound). */
  get url(): string {
    const addr = this.wss?.address() as AddressInfo | null
    if (!addr) throw new Error('MockBridge not started')
    return `ws://127.0.0.1:${addr.port}`
  }

  get port(): number {
    const addr = this.wss?.address() as AddressInfo | null
    if (!addr) throw new Error('MockBridge not started')
    return addr.port
  }

  private handleConnection(sock: WebSocket) {
    this.sockets.add(sock)
    sock.on('close', () => this.sockets.delete(sock))
    sock.on('message', (data) => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(data.toString())
      } catch {
        return
      }
      for (const cb of this.frameCbs) cb(frame)

      if (frame.type === 'hello') {
        this.sendHandshake(sock)
        return
      }
      if (frame.type === 'user_message') {
        const msg: UserMessage = {
          text: typeof frame.text === 'string' ? frame.text : '',
          mid: typeof frame.mid === 'string' ? frame.mid : undefined,
          context: frame.context,
          images: Array.isArray(frame.images) ? frame.images : undefined,
          raw: frame
        }
        this.userMessages.push(msg)
        if (this.opts.autoAckWorking && msg.mid) this.ack(msg.mid, 'working')
        for (const cb of this.userMessageCbs) cb(msg)
        const waiter = this.userMessageWaiters.shift()
        if (waiter) waiter(msg)
        return
      }
      // Graph command request: { rid, cmd, ... } -> reply { rid, ok, result }.
      if (
        this.opts.autoReplyCommands &&
        typeof frame.rid === 'string' &&
        typeof frame.cmd === 'string'
      ) {
        this.send({ rid: frame.rid, ok: true, result: { mock: true } }, sock)
      }
    })
  }

  /** The full HELLO handshake the panel expects: models (flips to "connected"),
   *  the command catalog, an agent_status, and optionally a greeting + ready ack. */
  private sendHandshake(sock: WebSocket) {
    this.send(
      {
        type: 'models',
        models: this.opts.models,
        current: this.opts.models[0]?.id,
        backend: this.opts.backend
      },
      sock
    )
    this.send({ type: 'commands', commands: this.opts.commands }, sock)
    this.send({ type: 'agent_status', context_pct: 0.01, cost_usd: 0 }, sock)
    if (this.opts.ackReady) this.send({ type: 'ack', kind: 'ready' }, sock)
    if (this.opts.greeting) {
      this.send({ type: 'say', text: this.opts.greeting }, sock)
    }
  }

  /** Register a callback invoked for every parsed user_message frame. */
  onUserMessage(cb: UserMessageCb): () => void {
    this.userMessageCbs.add(cb)
    return () => this.userMessageCbs.delete(cb)
  }

  /** Register a callback invoked for EVERY parsed inbound frame (debug/control). */
  onFrame(cb: FrameCb): () => void {
    this.frameCbs.add(cb)
    return () => this.frameCbs.delete(cb)
  }

  /** Resolve with the NEXT user_message the panel sends. */
  waitForUserMessage(timeoutMs = 10_000): Promise<UserMessage> {
    return new Promise<UserMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.userMessageWaiters.indexOf(wrapped)
        if (i >= 0) this.userMessageWaiters.splice(i, 1)
        reject(new Error('MockBridge.waitForUserMessage timed out'))
      }, timeoutMs)
      const wrapped = (m: UserMessage) => {
        clearTimeout(timer)
        resolve(m)
      }
      this.userMessageWaiters.push(wrapped)
    })
  }

  /** Number of user_messages received so far. */
  get receivedCount(): number {
    return this.userMessages.length
  }

  /** Low-level: send a raw frame to one socket, or broadcast to all. */
  send(frame: Record<string, unknown>, sock?: WebSocket): void {
    const payload = JSON.stringify(frame)
    const targets = sock ? [sock] : [...this.sockets]
    for (const s of targets) {
      if (s.readyState === WebSocket.OPEN) s.send(payload)
    }
  }

  /** Mark the turn as in-flight: { type:"turn", state:"working" }. */
  emitWorking(): void {
    this.send({ type: 'turn', state: 'working' })
  }

  /** Alias for emitWorking() — start a turn. */
  startTurn(): void {
    this.emitWorking()
  }

  /** Mark the turn finished: { type:"turn", state:"done" }. */
  turnDone(): void {
    this.send({ type: 'turn', state: 'done' })
  }

  /** Structured ack ({ type:"ack", kind, mid }). */
  ack(mid: string, kind: 'working' | 'seen' | 'ready' = 'working'): void {
    this.send({ type: 'ack', kind, mid })
  }

  /** "seen" ack — the agent dequeued this message (drains a pending bubble). */
  markSeen(mid: string): void {
    this.ack(mid, 'seen')
  }

  /** Commit a non-streamed agent reply. */
  say(text: string, opts: { id?: string; streamed?: boolean } = {}): void {
    this.send({
      type: 'say',
      text,
      ...(opts.id ? { id: opts.id } : {}),
      ...(opts.streamed ? { streamed: true } : {})
    })
  }

  /**
   * Emit a full streamed reply, exactly as the real orchestrator does:
   *   stream(text delta) -> say(streamed) -> stream(end) -> turn(done)
   * Returns the message id used (auto-generated if not supplied).
   */
  replyStreamed(text: string, opts: { id?: string } = {}): string {
    const id = opts.id ?? `mock-${Date.now().toString(36)}-${++this.streamSeq}`
    this.send({ type: 'stream', phase: 'text', id, delta: text })
    this.send({ type: 'say', text, id, streamed: true })
    this.send({ type: 'stream', phase: 'end', id })
    this.send({ type: 'turn', state: 'done' })
    return id
  }

  /**
   * Drive a graph command the way the real orchestrator does: send
   * { rid, cmd, ...args } to the panel and resolve with the panel's reply frame
   * ({ rid, ok, result } | { rid, ok:false, error }). Used by the connect-matcher
   * suite to exercise GRAPH_TOOL_EXECUTORS against the live LiteGraph graph.
   */
  command(
    cmd: string,
    args: Record<string, unknown> = {},
    timeoutMs = 10_000
  ): Promise<{ rid: string; ok: boolean; result?: any; error?: string }> {
    const rid = `cmd-${Date.now().toString(36)}-${++this.streamSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`MockBridge.command("${cmd}") timed out`))
      }, timeoutMs)
      const off = this.onFrame((frame) => {
        if (frame.rid === rid && (frame.ok !== undefined || frame.error !== undefined)) {
          clearTimeout(timer)
          off()
          resolve(frame as { rid: string; ok: boolean; result?: any; error?: string })
        }
      })
      this.send({ rid, cmd, ...args })
    })
  }

  /** Close all sockets and the server. */
  async close(): Promise<void> {
    for (const s of this.sockets) {
      try {
        s.close()
      } catch {
        // already closing
      }
    }
    this.sockets.clear()
    const wss = this.wss
    this.wss = null
    if (!wss) return
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }
}
