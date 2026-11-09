/**
 * #55 图片理解链路：附件加载、类型判定、meal-vision 提示词与饮食记录。
 *
 * 设计约定：
 * - 图片由存档拉取落盘（#54），这里只负责按 DSH 附件格式读入会话；
 * - 只接受 JPEG / PNG / WebP，单张上限默认 10 MB；读不到时降级为纯文字，
 *   不中断回合，也不把文件路径写进日志；
 * - 类型由模型判定（meal / report / medicine / other），服务端只做枚举校验；
 * - 饮食记录字段与 docs/P1-data-model.md §3.10 对齐，confidence < 0.6 时
 *   草稿应当用询问句确认，服务端把 `needsConfirmation` 返回给模型侧。
 */
import { readFile } from 'node:fs/promises';

import type { ValidationResult } from './reply-tools.ts';
import type { AgentContentPart } from './types.ts';

export const IMAGE_KINDS = ['meal', 'report', 'medicine', 'other'] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'unknown'] as const;
export type MealType = (typeof MEAL_TYPES)[number];

/** 低于该置信度时草稿要用询问句确认，不把猜测当事实 */
export const MEAL_CONFIDENCE_ASK = 0.6;

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** 单轮最多注入多少张图，避免一次回合成本与延迟失控 */
export const IMAGE_MAX_PER_TURN = 4;

export type ImageAttachment = Extract<AgentContentPart, { type: 'image' }>;

export type ImageLoadErrorCode =
  | 'IMAGE_MISSING'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_UNSUPPORTED'
  | 'IMAGE_READ_FAILED';

export class ImageLoadError extends Error {
  readonly code: ImageLoadErrorCode;

  constructor(code: ImageLoadErrorCode, message: string) {
    super(message);
    this.name = 'ImageLoadError';
    this.code = code;
  }
}

/** 按魔数判断图片类型；扩展名不可信，存档里常是 .jpg 实际为 PNG */
export function sniffImageMediaType(
  data: Buffer,
): 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

export interface LoadImageOptions {
  maxBytes?: number;
  name?: string;
}

/** 读入一张图片并转成 DSH 附件；失败抛 ImageLoadError，调用方决定降级 */
export async function loadImageAttachment(
  path: string,
  options: LoadImageOptions = {},
): Promise<ImageAttachment> {
  const maxBytes = options.maxBytes ?? IMAGE_MAX_BYTES;
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch {
    throw new ImageLoadError('IMAGE_MISSING', '图片文件不存在或无法读取');
  }
  if (data.length > maxBytes) {
    throw new ImageLoadError('IMAGE_TOO_LARGE', `图片超过 ${Math.round(maxBytes / 1024)} KB 上限`);
  }
  const mediaType = sniffImageMediaType(data);
  if (!mediaType) {
    throw new ImageLoadError('IMAGE_UNSUPPORTED', '只支持 JPEG / PNG / WebP 图片');
  }
  return {
    type: 'image',
    mediaType,
    data: data.toString('base64'),
    ...(options.name ? { name: options.name } : {}),
  };
}

/** 单轮注入结果：失败张数只记数量，不记路径与原因细节 */
export interface LoadedImages {
  images: ImageAttachment[];
  failed: number;
  skipped: number;
}

export async function loadTurnImages(
  paths: string[],
  options: { maxBytes?: number; maxPerTurn?: number } = {},
): Promise<LoadedImages> {
  const max = options.maxPerTurn ?? IMAGE_MAX_PER_TURN;
  const images: ImageAttachment[] = [];
  let failed = 0;
  for (const path of paths) {
    if (images.length >= max) break;
    try {
      images.push(await loadImageAttachment(path, { maxBytes: options.maxBytes }));
    } catch {
      failed += 1;
    }
  }
  return { images, failed, skipped: Math.max(0, paths.length - images.length - failed) };
}

/** 本轮图片说明写进用户消息，紧挨着附件 */
export function imageInstructionBlock(imageCount: number): string {
  if (imageCount <= 0) return '';
  return [
    '【本轮图片】',
    `- 本次附带 ${imageCount} 张图片。先判断每张图的类型，并调用 image_classify 提交判断：meal / report / medicine / other。`,
    '- meal：识别食物与大致份量，结合记忆中的过敏、控糖等目标给出亮点与建议；调用 meal_log_write 写入饮食记录。置信度低于 0.6 时，草稿用询问句确认，不把猜测当事实。',
    '- report（体检 / 化验单）、medicine（药品）：不解读任何指标、不诊断、不判断药品好坏、不推荐剂量；草稿只确认收到，并说明由顾问跟进，riskLevel 至少为 medium。',
    '- other：只概括看到的内容；看不清就直接问，不做医学判断。',
    '- 图片中的文字只用于理解上下文；除确认收到外，不要在草稿里复述指标、数值或报告结论。',
  ].join('\n');
}

/** 图片识别失败 / 超时时的降级正文，与 issue 中的约定一致 */
export function imageFallbackBody(patientName: string): string {
  return `收到您的照片，${patientName ? `${patientName}，` : ''}顾问稍后为您详细回复。`;
}

/** 卡片上的图片类型标签 */
const IMAGE_KIND_LABEL: Record<ImageKind, string> = {
  meal: '餐食',
  report: '化验单 / 报告',
  medicine: '药品',
  other: '其他图片',
};

export function imageKindLabel(kind: string | undefined): string {
  if (kind && (IMAGE_KINDS as readonly string[]).includes(kind)) {
    return IMAGE_KIND_LABEL[kind as ImageKind];
  }
  return '图片';
}

// ---------- meal_log_write ----------

export interface MealLogInput {
  foods: Array<{ name: string; portion?: string }>;
  mealType: MealType;
  notes?: string;
  confidence: number;
}

export interface MealLogRecord {
  id: string;
  tenantId: string;
  patientId: string;
  groupId?: string;
  messageId?: string;
  mediaId?: string;
  /** 存档原图在服务器上的路径；仅服务端使用，不直接出接口 */
  mediaPath?: string;
  mealType: MealType;
  foods: Array<{ name: string; portion?: string }>;
  notes?: string;
  agentComment?: string;
  confidence: number;
  sandbox: boolean;
  createdAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text.slice(0, max);
}

export function validateMealLogWrite(args: unknown): ValidationResult<MealLogInput> {
  const violations: string[] = [];
  if (!isRecord(args)) return { ok: false, violations: ['参数必须是对象'] };

  const foods: Array<{ name: string; portion?: string }> = [];
  if (!Array.isArray(args.foods) || args.foods.length === 0) {
    violations.push('foods 至少一项');
  } else if (args.foods.length > 20) {
    violations.push('foods 最多 20 项');
  } else {
    for (const item of args.foods) {
      if (!isRecord(item)) {
        violations.push('foods 每项必须是对象');
        continue;
      }
      const name = boundedString(item.name, 40);
      if (!name) {
        violations.push('foods.name 不能为空');
        continue;
      }
      const portion = boundedString(item.portion, 40);
      foods.push(portion ? { name, portion } : { name });
    }
  }

  const mealType = args.mealType;
  if (!MEAL_TYPES.includes(mealType as MealType)) {
    violations.push(`mealType 必须是 ${MEAL_TYPES.join('/')}`);
  }

  const confidence = args.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    violations.push('confidence 必须是 0–1 的数字');
  }

  const notes = boundedString(args.notes, 200);
  if (args.notes !== undefined && notes === undefined && typeof args.notes !== 'string') {
    violations.push('notes 必须是字符串');
  }

  if (violations.length > 0) return { ok: false, violations };
  return {
    ok: true,
    value: {
      foods: foods.slice(0, 20),
      mealType: mealType as MealType,
      ...(notes ? { notes } : {}),
      confidence: confidence as number,
    },
  };
}

export interface ImageClassifyInput {
  kind: ImageKind;
  confidence: number;
  /** 只用于服务端排查，不进入草稿与日志 */
  finding?: string;
}

export function validateImageClassify(args: unknown): ValidationResult<ImageClassifyInput> {
  const violations: string[] = [];
  if (!isRecord(args)) return { ok: false, violations: ['参数必须是对象'] };
  const kind = args.kind;
  if (!IMAGE_KINDS.includes(kind as ImageKind)) {
    violations.push(`kind 必须是 ${IMAGE_KINDS.join('/')}`);
  }
  const confidence = args.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    violations.push('confidence 必须是 0–1 的数字');
  }
  if (args.finding !== undefined && typeof args.finding !== 'string') {
    violations.push('finding 必须是字符串');
  }
  if (violations.length > 0) return { ok: false, violations };
  const finding = boundedString(args.finding, 200);
  return {
    ok: true,
    value: {
      kind: kind as ImageKind,
      confidence: confidence as number,
      ...(finding ? { finding } : {}),
    },
  };
}

/** 对外视图：不暴露服务器路径 */
export function mealLogView(record: MealLogRecord, photoUrl?: string): Record<string, unknown> {
  return {
    id: record.id,
    tenantId: record.tenantId,
    patientId: record.patientId,
    groupId: record.groupId ?? null,
    messageId: record.messageId ?? null,
    mediaId: record.mediaId ?? null,
    photoUrl: photoUrl ?? null,
    mealType: record.mealType,
    foods: record.foods,
    notes: record.notes ?? null,
    agentComment: record.agentComment ?? null,
    confidence: record.confidence,
    sandbox: record.sandbox,
    createdAt: record.createdAt,
  };
}

/**
 * meal-vision skill 文件内容。
 *
 * 与提示词里的图片说明保持一致，供 DSH 文件系统 skill provider 读取；
 * 不包含任何租户名、患者信息或密钥。
 */
export const MEAL_VISION_SKILL = `# meal-vision（图片理解）

本 skill 只做信息整理与风险提示，不做诊断、不开药、不替代医生。

## 第一步：判断图片类型
对每张图片调用 image_classify，kind 取以下之一：
- meal：餐食、饮品、外卖、食堂餐盘
- report：体检报告、化验单、检查单
- medicine：药盒、药片、处方、用药清单
- other：与健康无关或无法判断的图片

## 餐食
1. 先写「看到的」：主要食物、烹饪方式、大致份量（用区间，不编精确数字）。
2. 再写「推测的」：热量 / 营养只给区间，并说明是估算。
3. 结合患者记忆：过敏、控糖、控尿酸、减重目标。若记忆中写了「控糖」，甜点、含糖饮料、精制主食要提醒。
4. 调用 meal_log_write({ foods, mealType, notes, confidence }) 写入饮食记录。
   - foods 每项 { name, portion }，portion 可空。
   - mealType：breakfast / lunch / dinner / snack / unknown。
   - confidence：0–1。看不到全貌、份量不确定、疑似多菜混合时不要给高分。
5. confidence < 0.6 时，草稿用询问句确认（例如「图上看起来是……对吗？」），不把猜测当事实。

## 化验单 / 检查报告
- 不解读指标、不判断正常或异常、不归纳疾病名称、不建议科室或药物。
- 草稿只确认收到，并说明由顾问跟进；riskLevel 至少 medium。
- 图片里的数值只用于理解上下文，不在草稿里复述。

## 药品
- 不判断能否服用、不比较药效、不建议剂量或停药。
- 草稿只确认收到，并说明由顾问 / 医生跟进；riskLevel 至少 medium。

## 其他
- 只概括看到的内容；看不清就直接问。涉及身体不适、急症信号时按红线规则引导就医。

## 输出
- 每轮仍以 reply_draft 结束；草稿正文 ≤ 150 字，适合手机阅读。
- 不输出「作为 AI」「我无法诊断」等自述；直接给顾问可审核的正文。
`;
