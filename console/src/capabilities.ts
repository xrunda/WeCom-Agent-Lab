/**
 * P1 已启用的 Agent 能力。
 *
 * 能力以 DSH 插件形式随服务包安装，机构不能自助安装；控制台只做只读展示。
 * 新增能力时同步更新这里与 docs/P1-scope.md §4.10。
 */
export const ENABLED_CAPABILITIES = [
  '企微服务通道',
  '患者路由',
  '长期记忆',
  '主动关怀',
  '健康红线',
  '知识问答',
  '餐食图片识别',
] as const;
