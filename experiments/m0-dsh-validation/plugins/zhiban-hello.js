/**
 * M0 验证用最小插件：只注册一个 `hello` 工具，用来确认 DSH profile 的插件加载链路。
 *
 * 不依赖任何 @deepseek-ai/* 包，DSH 可以直接按绝对路径加载本文件。
 */
import { randomUUID } from 'node:crypto'

export const name = 'zhiban-hello'

export const inject = ['tools']

export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: 'hello',
    description: '向指定的人问好，返回一句中文问候。用于验证 zhiban profile 的插件加载链路。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要问候的人名，可省略' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          callId: { type: 'string' },
        },
        required: ['message', 'callId'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: value.message }]
      },
    },
    async execute(args) {
      const who = typeof args?.name === 'string' && args.name.trim() !== '' ? args.name.trim() : '世界'
      return { message: `你好，${who}。zhiban profile 的 hello 插件已加载。`, callId: randomUUID() }
    },
  })
  ctx.effect(() => dispose)
}
