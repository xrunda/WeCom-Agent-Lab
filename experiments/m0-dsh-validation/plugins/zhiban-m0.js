/**
 * M0 底座验证插件（#29 / #30）。
 *
 * 只做验证，不含业务逻辑。四条实验通道：
 *   1. 插件向指定长期会话注入用户消息并触发回合（session-controller / followup 两条路径）
 *   2. 插件注册 HTTP 路由：Web 原生路由（可被 curl 直接调用）与 Connection Fetch 路由（owner 认证）
 *   3. 插件直接调用 ctx.schedule 创建 / 列出 / 删除提醒
 *   4. 插件读取 DSH 插件清单
 *
 * 所有消息正文只出现在 HTTP 响应与内存中，不写日志。
 */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'zhiban-m0'

export const inject = [
  'webServer',
  'connection',
  'sessionController',
  'sessions',
  'tools',
  'schedule',
  'loader',
]

const MAX_EVENTS = 2000
const DEFAULT_TURN_TIMEOUT_MS = 180_000

/** 每个会话的回合观测器。 */
const collectors = new Map()
const startedAt = Date.now()

function collector(sessionId) {
  const key = String(sessionId)
  let found = collectors.get(key)
  if (found === undefined) {
    found = {
      events: [],
      assistant: [],
      users: [],
      drafts: [],
      turnStarts: [],
      turnEnds: [],
      openTurn: null,
    }
    collectors.set(key, found)
  }
  return found
}

function capture(sessionId, event) {
  const c = collector(sessionId)
  const type = event.type
  const turn = event.data?.turn ?? c.openTurn
  c.events.push({ type, seq: Number(event.seq), time: event.time, turn })
  if (c.events.length > MAX_EVENTS) c.events.splice(0, c.events.length - MAX_EVENTS)

  if (type === 'turn/start') {
    c.openTurn = event.data.turn
    c.turnStarts.push({ turn: event.data.turn, at: event.time })
  }
  if (type === 'turn/end') {
    c.openTurn = null
    c.turnEnds.push({
      turn: event.data.turn,
      reason: event.data.reason?.kind ?? 'unknown',
      at: event.time,
    })
  }
  if (type === 'assistant/message') {
    const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
    const text = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
    c.assistant.push({
      turn,
      step: event.data?.step ?? null,
      text,
      at: event.time,
      usage: event.data?.usage ?? null,
    })
  }
  if (type === 'user/message') {
    const blocks = Array.isArray(event.data?.content) ? event.data.content : []
    const text = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
    c.users.push({ turn, source: event.data?.source?.kind ?? 'unknown', text, at: event.time })
  }
}

function summarize(sessionId, since) {
  const c = collector(sessionId)
  const after = (row) => row.at >= since
  const turns = c.turnEnds.filter(after).map((end) => ({
    ...end,
    assistantText: c.assistant
      .filter((m) => m.turn === end.turn)
      .map((m) => m.text)
      .join('\n')
      .trim(),
    drafts: c.drafts.filter((d) => d.turn === end.turn).map((d) => d.args),
  }))
  return {
    sessionId: String(sessionId),
    since,
    now: Date.now(),
    durationMs: Date.now() - since,
    turns,
    turnStarts: c.turnStarts.filter(after),
    userMessages: c.users.filter(after).map((u) => ({ turn: u.turn, source: u.source, text: u.text })),
    assistantMessages: c.assistant
      .filter(after)
      .map((a) => ({ turn: a.turn, step: a.step, text: a.text, usage: a.usage })),
    replyDrafts: c.drafts.filter(after).map((d) => ({ turn: d.turn, args: d.args, isError: d.isError })),
  }
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function readJson(req, limit = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const value = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return value
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(text)
}

function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined)
        return
      }
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export function apply(ctx, config = {}) {
  const cwd = config.cwd ?? join(homedir(), '.dsh', 'workspaces', 'zhiban-m0')
  const defaultTimeout = Number(config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS)
  const sseSeconds = Number(config.sseSeconds ?? 60)

  /** 记录会话事件，不打印正文。 */
  ctx.on('session/event', (session, event) => {
    capture(session.id, event)
  })

  /** 记录 reply_draft 的工具调用参数。 */
  ctx.on('tools/result', (exec, result) => {
    if (exec?.name !== 'reply_draft') return
    const sessionId = exec.agent?.id
    if (sessionId === undefined) return
    const c = collector(sessionId)
    c.drafts.push({
      turn: c.openTurn,
      args: exec.arguments,
      isError: result?.isError === true,
      at: Date.now(),
    })
  })

  /** 验证工具：模型调它时，参数会被上面的 tools/result 记录。 */
  const disposeTool = ctx.tools.register({
    name: 'reply_draft',
    description:
      '记录一条给顾问的回复草稿。M0 验证专用：收到用户消息后，必须调用本工具提交草稿，不要直接把草稿写在回复正文里。',
    parameters: {
      type: 'object',
      properties: {
        body: { type: 'string', description: '给顾问的回复草稿正文' },
        riskLevel: { type: 'string', enum: ['low', 'medium', 'high'], description: '风险级别' },
        citedMemoryIds: { type: 'array', items: { type: 'string' }, description: '引用的记忆 id' },
      },
      required: ['body'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          draftId: { type: 'string' },
        },
        required: ['ok', 'draftId'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: `草稿已记录（${value.draftId}）` }]
      },
    },
    async execute() {
      return { ok: true, draftId: `draft_${randomUUID()}` }
    },
  })
  ctx.effect(() => disposeTool)

  async function ensureSession(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') return sessionId
    await mkdir(cwd, { recursive: true })
    const created = await ctx.sessionController.create({ cwd, agentPreset: config.agentPreset })
    return String(created.sessionId)
  }

  async function resolveAgent(sessionId) {
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if (resolved.error !== undefined) {
      throw new Error(`resolveAgent 失败：${resolved.error.code ?? 'unknown'} ${resolved.error.message ?? ''}`.trim())
    }
    return resolved.agent
  }

  /** 路径 A：sessionController.prompt（公开、幂等、会话冷启动由它负责）。 */
  async function promptTurn(sessionId, message, requestId) {
    const since = Date.now()
    const agent = await resolveAgent(sessionId)
    await ctx.sessionController.prompt(
      {
        requestId: requestId ?? randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: message }],
      },
      AbortSignal.timeout(defaultTimeout + 5_000),
    )
    await withTimeout(agent.whenIdle(), defaultTimeout, '等待回合结束')
    await ctx.sessions.flush(agent.session).catch(() => undefined)
    return summarize(sessionId, since)
  }

  /** 路径 B：resolveAgent + agent.followup，与 dsh-schedule 的投递方式一致。 */
  async function followupTurn(sessionId, message) {
    const since = Date.now()
    const agent = await resolveAgent(sessionId)
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: message }],
      source: { kind: 'zhiban-patient' },
    })
    await withTimeout(agent.whenIdle(), defaultTimeout, '等待回合结束')
    await ctx.sessions.flush(agent.session).catch(() => undefined)
    return summarize(sessionId, since)
  }

  const routes = [
    {
      kind: 'exact',
      path: '/zhiban-m0/health',
      handler: route(async (_req, res) => {
        let model = null
        try {
          model = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
        } catch {
          model = null
        }
        let plugins = 0
        for (const _entry of ctx.loader.entries()) plugins += 1
        sendJson(res, 200, {
          ok: true,
          plugin: name,
          pid: process.pid,
          uptimeMs: Date.now() - startedAt,
          node: process.version,
          model,
          plugins,
          cwd,
        })
      }),
    },
    {
      kind: 'exact',
      path: '/zhiban-m0/session',
      handler: route(async (req, res) => {
        if (req.method !== 'POST') return sendText(res, 405, 'POST only')
        const body = await readJson(req)
        const sessionId = await ensureSession(body.sessionId)
        sendJson(res, 200, { ok: true, sessionId })
      }),
    },
    {
      kind: 'exact',
      path: '/zhiban-m0/turn',
      handler: route(async (req, res) => {
        if (req.method !== 'POST') return sendText(res, 405, 'POST only')
        const body = await readJson(req)
        if (typeof body.message !== 'string' || body.message.trim() === '') {
          return sendJson(res, 400, { ok: false, error: 'message 不能为空' })
        }
        const sessionId = await ensureSession(body.sessionId)
        const result = await promptTurn(sessionId, body.message, body.requestId)
        sendJson(res, 200, { ok: true, ...result })
      }),
    },
    {
      kind: 'exact',
      path: '/zhiban-m0/turn-raw',
      handler: route(async (req, res) => {
        if (req.method !== 'POST') return sendText(res, 405, 'POST only')
        const body = await readJson(req)
        if (typeof body.message !== 'string' || body.message.trim() === '') {
          return sendJson(res, 400, { ok: false, error: 'message 不能为空' })
        }
        const sessionId = await ensureSession(body.sessionId)
        const result = await followupTurn(sessionId, body.message)
        sendJson(res, 200, { ok: true, ...result })
      }),
    },
    {
      kind: 'exact',
      path: '/zhiban-m0/burst',
      handler: route(async (req, res) => {
        if (req.method !== 'POST') return sendText(res, 405, 'POST only')
        const body = await readJson(req)
        const messages = Array.isArray(body.messages) ? body.messages : []
        if (messages.length === 0 || messages.some((m) => typeof m !== 'string')) {
          return sendJson(res, 400, { ok: false, error: 'messages 必须是非空字符串数组' })
        }
        const sessionId = await ensureSession(body.sessionId)
        const since = Date.now()
        const agent = await resolveAgent(sessionId)
        const acceptedAt = []
        for (const message of messages) {
          await ctx.sessionController.prompt(
            {
              requestId: randomUUID(),
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: message }],
            },
            AbortSignal.timeout(defaultTimeout + 5_000),
          )
          acceptedAt.push(Date.now())
        }
        await withTimeout(agent.whenIdle(), defaultTimeout, '等待排队回合结束')
        await ctx.sessions.flush(agent.session).catch(() => undefined)
        sendJson(res, 200, { ok: true, acceptedAt, ...summarize(sessionId, since) })
      }),
    },
    {
      kind: 'exact',
      path: '/zhiban-m0/image-turn',
      handler: route(async (req, res) => {
        if (req.method !== 'POST') return sendText(res, 405, 'POST only')
        const body = await readJson(req, 25 << 20)
        if (typeof body.imageBase64 !== 'string' || body.imageBase64 === '') {
          return sendJson(res, 400, { ok: false, error: 'imageBase64 不能为空' })
        }
        const mediaType = typeof body.mediaType === 'string' ? body.mediaType : 'image/jpeg'
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(mediaType)) {
          return sendJson(res, 400, { ok: false, error: `不支持的 mediaType：${mediaType}` })
        }
        const question =
          typeof body.question === 'string' && body.question.trim() !== ''
            ? body.question
            : '请描述这张图片。'
        const sessionId = await ensureSession(body.sessionId)
        const since = Date.now()
        const agent = await resolveAgent(sessionId)
        await ctx.sessionController.prompt(
          {
            requestId: randomUUID(),
            sessionId,
            mode: 'queue',
            content: [
              { type: 'text', text: question },
              {
                type: 'image',
                mediaType,
                data: body.imageBase64,
                ...(typeof body.imageName === 'string' ? { name: body.imageName } : {}),
              },
            ],
          },
          AbortSignal.timeout(defaultTimeout + 5_000),
        )
        await withTimeout(agent.whenIdle(), defaultTimeout, '等待视觉回合结束')
        await ctx.sessions.flush(agent.session).catch(() => undefined)
        sendJson(res, 200, { ok: true, ...summarize(sessionId, since) })
      }),
    },
    {
      kind: 'exact',
      path: '/zhiban-m0/session-events',
      handler: route(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')
        const since = Number(url.searchParams.get('since') ?? 0)
        if (sessionId === null) return sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
        const c = collector(sessionId)
        sendJson(res, 200, {
          ok: true,
          sessionId,
          events: c.events.filter((e) => e.time >= since),
          turnStarts: c.turnStarts.filter((e) => e.at >= since),
          turns: c.turnEnds.filter((e) => e.at >= since),
          userMessages: c.users.filter((e) => e.at >= since),
          assistantMessages: c.assistant.filter((e) => e.at >= since),
          drafts: c.drafts.filter((e) => e.at >= since).map((d) => ({ turn: d.turn, args: d.args, at: d.at })),
        })
      }),
    },
    {
      kind: 'exact',
      path: '/zhiban-m0/wait-turn',
      handler: route(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')
        const since = Number(url.searchParams.get('since') ?? Date.now())
        const timeoutMs = Math.max(1_000, Math.min(Number(url.searchParams.get('timeoutMs') ?? 30_000), 180_000))
        if (sessionId === null) return sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          if (collector(sessionId).turnEnds.some((end) => end.at >= since)) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        sendJson(res, 200, { ok: true, ...summarize(sessionId, since) })
      }),
    },
    {
      kind: 'exact',
      path: '/zhiban-m0/schedule',
      handler: route(async (req, res) => {
        if (req.method !== 'POST') return sendText(res, 405, 'POST only')
        const body = await readJson(req)
        const action = body.action
        if (action === 'catalog') {
          return sendJson(res, 200, { ok: true, records: await ctx.schedule.catalog() })
        }
        const sessionId = await ensureSession(body.sessionId)
        if (action === 'create') {
          const request = {
            prompt: String(body.prompt ?? ''),
            title: String(body.title ?? ''),
          }
          if (body.afterSeconds !== undefined) request.after_seconds = Number(body.afterSeconds)
          if (body.everySeconds !== undefined) request.every_seconds = Number(body.everySeconds)
          if (body.cron !== undefined) request.cron = body.cron
          if (body.daily !== undefined) request.daily = body.daily
          if (body.weekly !== undefined) request.weekly = body.weekly
          if (body.at !== undefined) request.at = body.at
          const record = await ctx.schedule.create(sessionId, request)
          return sendJson(res, 200, { ok: true, sessionId, record })
        }
        if (action === 'list') {
          const records = await ctx.schedule.list({ sessionId })
          return sendJson(res, 200, { ok: true, sessionId, records })
        }
        if (action === 'delete') {
          const result = await ctx.schedule.delete({ sessionId, id: body.id })
          return sendJson(res, 200, { ok: true, sessionId, result })
        }
        if (action === 'history') {
          const result = await ctx.schedule.history({ sessionId, id: body.id, limit: Number(body.limit ?? 10) })
          return sendJson(res, 200, { ok: true, sessionId, result })
        }
        sendJson(res, 400, { ok: false, error: `未知 action：${String(action)}` })
      }),
    },
    {
      kind: 'exact',
      path: '/zhiban-m0/inventory',
      handler: route(async (_req, res) => {
        const rows = []
        for (const entry of ctx.loader.entries()) {
          rows.push({
            id: entry.id,
            name: entry.options?.name ?? null,
            disabled: entry.disabled === true,
            fiber: entry.fiber === undefined ? null : String(entry.fiber.state),
          })
        }
        sendJson(res, 200, { ok: true, total: rows.length, rows })
      }),
    },
    {
      kind: 'exact',
      path: '/zhiban-m0/model',
      handler: route(async (_req, res) => {
        const current = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
        let catalog = null
        try {
          catalog = await ctx.sessionController.modelCatalog()
        } catch (error) {
          catalog = { error: error instanceof Error ? error.message : String(error) }
        }
        sendJson(res, 200, { ok: true, current, catalog })
      }),
    },
    {
      kind: 'exact',
      path: '/zhiban-m0/sse',
      handler: route(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const seconds = Math.max(1, Math.min(Number(url.searchParams.get('seconds') ?? sseSeconds), 180))
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        let closed = false
        const cleanup = () => {
          if (closed) return
          closed = true
          clearInterval(tick)
          clearTimeout(stop)
        }
        const started = Date.now()
        const tick = setInterval(() => {
          if (closed) return
          const elapsed = Date.now() - started
          res.write(`event: tick\ndata: ${JSON.stringify({ elapsedMs: elapsed, at: Date.now() })}\n\n`)
        }, 5_000)
        const stop = setTimeout(() => {
          if (closed) return
          res.write(`event: done\ndata: ${JSON.stringify({ seconds, at: Date.now() })}\n\n`)
          cleanup()
          res.end()
        }, seconds * 1_000)
        res.write(`event: hello\ndata: ${JSON.stringify({ seconds, pid: process.pid, at: Date.now() })}\n\n`)
        req.on('close', cleanup)
        res.on('close', cleanup)
      }),
    },
  ]

  for (const r of routes) {
    ctx.effect(() => ctx.webServer.register(r))
  }

  /** Connection Fetch 路由：路径挂在 /api 之下，只有 owner Peer 能访问。 */
  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: '/api/zhiban-m0/cfetch/ping',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let body = null
        if (request.method === 'POST') {
          body = await request.json().catch(() => null)
        }
        return new Response(
          JSON.stringify({
            ok: true,
            transport: 'connection-fetch',
            path: '/api/zhiban-m0/cfetch/ping',
            method: request.method,
            body,
            at: Date.now(),
          }),
          { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
        )
      },
    }),
  )

  ctx.logger?.info?.('[zhiban-m0] validation routes ready: /zhiban-m0/{health,session,turn,turn-raw,burst,schedule,sse,inventory,model}')
}
