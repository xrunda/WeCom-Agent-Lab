/**
 * 种子合作方案的对外口径。定价页与 llms.txt 共用这一份，
 * 避免官网文案与给 Agent 读的文件各写一个价格。
 */
export const PLAN = {
  name: '种子合作方案',
  /** 月费展示值，不含货币符号 */
  priceLabel: '19,800',
  /** 方案覆盖的顾问席位数 */
  seats: 10,
  /** 企微会话存档人均年费（第三方收费，单位：元） */
  archiveFee: 900,
} as const;

/** 10 位顾问的企微存档费示例：900 × 10 = 9,000 */
export const ARCHIVE_EXAMPLE_TOTAL = (PLAN.seats * PLAN.archiveFee).toLocaleString('zh-CN');
