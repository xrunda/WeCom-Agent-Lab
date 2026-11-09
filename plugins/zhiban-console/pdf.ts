/**
 * #59 服务端 PDF：证据链与服务记录。
 *
 * 仅依赖 pdfkit；中文字体必须在部署机提供（仓库不打包字体，避免许可证与体积问题）。
 * 字体查找顺序：显式配置 → 环境变量 → 常见系统字体路径。
 * 找不到字体时抛 `PDF_FONT_UNAVAILABLE`，由路由转成 502 并提示运维安装字体。
 *
 * 注意：本模块不写日志，不把消息正文带到任何错误信息里。
 */
import { existsSync } from 'node:fs';

import PDFDocument from 'pdfkit';

import type { EvidenceBundle, EvidenceDraftSource, RecordsBundle } from '../../src/p1/evidence.ts';
import { ConsoleError } from '../../src/p1/console-error.ts';

export interface PdfFontConfig {
  path?: string;
  family?: string;
}

export interface PdfFont {
  path: string;
  family?: string;
}

/** 常见中文字体；TTC 需要给出集合内的 PostScript 名（pdfkit / fontkit 要求） */
const FONT_CANDIDATES: PdfFont[] = [
  { path: '/System/Library/Fonts/Supplemental/Songti.ttc', family: 'STSong' },
  { path: '/System/Library/Fonts/Supplemental/Arial Unicode.ttf' },
  { path: '/System/Library/Fonts/STHeiti Light.ttc', family: 'STHeitiSC-Light' },
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'NotoSansCJKsc-Regular' },
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf' },
  { path: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', family: 'WenQuanYiZenHei' },
  { path: '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', family: 'WenQuanYiMicroHei' },
];

export function resolvePdfFont(
  config: PdfFontConfig = {},
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): PdfFont | undefined {
  const configured = config.path?.trim();
  if (configured) {
    const family = config.family?.trim();
    return { path: configured, ...(family ? { family } : {}) };
  }
  const envPath = env.ZHIBAN_PDF_FONT?.trim();
  if (envPath) {
    const family = env.ZHIBAN_PDF_FONT_FAMILY?.trim();
    return { path: envPath, ...(family ? { family } : {}) };
  }
  return FONT_CANDIDATES.find((candidate) => exists(candidate.path));
}

export function requirePdfFont(font: PdfFont | undefined): PdfFont {
  if (!font) {
    throw new ConsoleError(
      'UPSTREAM_UNAVAILABLE',
      '服务端缺少中文字体，无法生成 PDF；请安装 fonts-noto-cjk 或配置 pdf.fontPath',
    );
  }
  return font;
}

const OUTCOME_LABEL: Record<string, string> = {
  VERIFIED: '核验通过（照原文发送）',
  EDIT_SENT: '改写后发送',
  MISROUTE_ALERT: '发错群',
  UNVERIFIED: '未核验',
  RELEASED: '管理员释放队列',
};

const STATUS_LABEL: Record<string, string> = {
  QUEUED: '排队中',
  PUSHED: '已推送',
  ACKED: '已确认',
  ACKNOWLEDGED: '已确认',
  VERIFIED: '已核验',
  EDIT_SENT: '改写发送',
  MISROUTE_ALERT: '发错群',
  UNVERIFIED: '未核验',
  DEAD_LETTER: '死信',
  SKIPPED: '已忽略',
  RELEASED: '已释放',
};

const RISK_LABEL: Record<string, string> = { low: '低', medium: '中', high: '高' };

function formatTime(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at)) return '—';
  return new Date(at).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

function textOf(
  doc: PDFKit.PDFDocument,
  text: string,
  color = '#1f2329',
  options: PDFKit.Mixins.TextOptions = {},
): void {
  doc.fontSize(10).fillColor(color).text(text, options);
}

function sectionTitle(doc: PDFKit.PDFDocument, title: string): void {
  doc.moveDown(0.6);
  doc.fontSize(12).fillColor('#1f2329').text(title);
  const y = doc.y + 2;
  doc
    .save()
    .lineWidth(0.6)
    .strokeColor('#d9dde3')
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .stroke()
    .restore();
  doc.moveDown(0.4);
}

function kv(doc: PDFKit.PDFDocument, key: string, value: string): void {
  doc.fontSize(10).fillColor('#646a73').text(`${key}：`, { continued: true });
  doc.fillColor('#1f2329').text(value || '—');
}

function renderFooter(doc: PDFKit.PDFDocument, bundle: { exportedBy: string; exportedAt: number }): void {
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    doc
      .fontSize(8)
      .fillColor('#8a8f99')
      .text(
        `第 ${index + 1} / ${range.count} 页 · 导出人：${bundle.exportedBy} · 生成时间：${formatTime(bundle.exportedAt)}`,
        doc.page.margins.left,
        doc.page.height - 34,
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'center', lineBreak: false },
      );
  }
}

function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function createDoc(font: PdfFont, title: string): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 50,
    bufferPages: true,
    info: {
      Title: title,
      Producer: 'zhiban-console',
      Creator: '知伴健康 Agent',
    },
  });
  try {
    doc.registerFont('cjk', font.path, font.family);
  } catch {
    throw new ConsoleError('UPSTREAM_UNAVAILABLE', 'PDF 字体无法加载，请检查 pdf.fontPath / pdf.fontFamily');
  }
  doc.font('cjk');
  return doc;
}

function renderHeader(doc: PDFKit.PDFDocument, tenantName: string, title: string): void {
  doc.fontSize(16).fillColor('#1f2329').text(`${tenantName} · ${title}`, {
    width: doc.page.width - 100,
  });
}

function renderImages(doc: PDFKit.PDFDocument, paths: string[]): void {
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue;
      doc.moveDown(0.2);
      doc.image(path, { fit: [220, 160] });
    } catch {
      // 单张图片损坏不影响整份 PDF
    }
  }
}

function renderEvidenceSections(
  doc: PDFKit.PDFDocument,
  draft: EvidenceDraftSource,
  options: { detail: boolean },
): void {
  const inbound = draft.inbound ?? [];
  sectionTitle(doc, '客户原话');
  if (inbound.length === 0) {
    textOf(doc, `（未取到存档原文）摘要：${draft.inboundSummary}`);
  } else {
    for (const message of inbound) {
      textOf(doc, `${formatTime(message.msgtime)} · ${message.from}${message.msgtype === 'image' ? ' · 图片' : ''}`);
      textOf(doc, message.text || '（图片消息）');
      if (message.mediaPath) renderImages(doc, [message.mediaPath]);
      doc.moveDown(0.3);
    }
  }
  if (options.detail && draft.mediaIds.length > 0) {
    doc.moveDown(0.2);
    textOf(doc, `随消息附件 ${draft.mediaIds.length} 个`, '#646a73');
    renderImages(doc, draft.mediaIds);
  }

  sectionTitle(doc, '草稿版本');
  for (const revision of draft.revisions ?? []) {
    textOf(
      doc,
      `v${revision.version} · ${revision.createdBy === 'staff' ? '顾问修订' : 'Agent 生成'} · ${formatTime(revision.createdAt)}`,
      '#646a73',
    );
    if (revision.instruction) {
      textOf(doc, `改稿要求：${revision.instruction}`, '#646a73');
    }
    textOf(doc, revision.body);
    if (draft.sentVersion === revision.version) {
      textOf(doc, '（本版本为核验对应的发送版本）', '#646a73');
    }
    doc.moveDown(0.3);
  }
  if ((draft.revisions ?? []).length === 0) {
    textOf(doc, draft.body);
  }

  sectionTitle(doc, '实发与核验');
  const verification = draft.verification;
  kv(doc, '核验结果', verification ? (OUTCOME_LABEL[verification.outcome] ?? verification.outcome) : '尚未核验');
  if (verification) {
    kv(doc, '核验时间', formatTime(verification.checkedAt));
    kv(doc, '存档 msgid', verification.matchedMsgId ?? '—');
    kv(doc, '匹配群', verification.matchedRoomId ?? '—');
    if (verification.similarity !== undefined) {
      kv(doc, '相似度', verification.similarity.toFixed(2));
    }
  }
  if (draft.sent) {
    kv(doc, '实发时间', formatTime(draft.sent.msgtime));
    textOf(doc, draft.sent.text || '（图片消息）');
  } else if (draft.sentVersion !== undefined) {
    const revision = (draft.revisions ?? []).find((item) => item.version === draft.sentVersion);
    if (revision) {
      textOf(doc, '（未取到存档原文，以下为核验对应的发送版本正文）', '#646a73');
      textOf(doc, revision.body);
    }
  }
  if (draft.ackAction) {
    kv(doc, '顾问操作', draft.ackAction === 'sent' ? `已发送（${formatTime(draft.ackAt)}）` : '忽略');
  }

  sectionTitle(doc, '引用与操作人');
  kv(doc, '引用记忆', draft.citedMemoryIds.join(', ') || '无');
  kv(doc, '引用知识', draft.citedKnowledgeIds.join(', ') || '无');
  kv(doc, '顾问', draft.advisorName ?? draft.advisorId);
}

export function renderEvidencePdf(bundle: EvidenceBundle, font: PdfFont): Promise<Buffer> {
  const draft = bundle.draft;
  const doc = createDoc(font, `证据链 ${draft.id}`);
  renderHeader(doc, bundle.tenantName, '服务证据链');
  doc.moveDown(0.4);
  kv(doc, '草稿编号', draft.id);
  kv(doc, '患者 / 客户', draft.customerName);
  kv(doc, '服务群', draft.groupName);
  kv(doc, '顾问', draft.advisorName ?? draft.advisorId);
  kv(doc, '风险等级', RISK_LABEL[draft.riskLevel] ?? draft.riskLevel);
  kv(doc, '草稿状态', STATUS_LABEL[draft.status] ?? draft.status);
  kv(doc, '创建时间', formatTime(draft.createdAt));
  kv(doc, '推送时间', formatTime(draft.pushedAt));
  kv(doc, '导出人', bundle.exportedBy);
  kv(doc, '导出时间', formatTime(bundle.exportedAt));

  renderEvidenceSections(doc, draft, { detail: true });
  renderFooter(doc, bundle);
  return toBuffer(doc);
}

export function renderRecordsPdf(bundle: RecordsBundle, font: PdfFont): Promise<Buffer> {
  const doc = createDoc(font, `服务记录 ${bundle.patient.id}`);
  renderHeader(doc, bundle.tenantName, '患者服务记录');
  doc.moveDown(0.4);
  kv(doc, '患者 / 客户', bundle.patient.displayName);
  kv(doc, '患者编号', bundle.patient.id);
  kv(doc, '时间范围', `${formatTime(bundle.from)} 至 ${formatTime(bundle.to)}`);
  kv(doc, '服务群', bundle.groups.map((group) => group.name).join('、') || '未绑定');
  kv(doc, '记录数', String(bundle.records.length) + (bundle.truncated ? '（已截断）' : ''));
  kv(doc, '导出人', bundle.exportedBy);
  kv(doc, '导出时间', formatTime(bundle.exportedAt));

  sectionTitle(doc, '服务记录');
  if (bundle.records.length === 0) {
    textOf(doc, '所选时间范围内没有服务记录。');
  }
  for (const draft of bundle.records) {
    const verification = draft.verification;
    textOf(doc, `${formatTime(draft.createdAt)} · ${draft.groupName} · ${STATUS_LABEL[draft.status] ?? draft.status}`);
    kv(doc, '草稿编号', draft.id);
    if (verification) {
      kv(
        doc,
        '核验',
        `${OUTCOME_LABEL[verification.outcome] ?? verification.outcome} · msgid ${verification.matchedMsgId ?? '—'} · ${formatTime(verification.checkedAt)}`,
      );
    }
    textOf(doc, draft.body);
    doc.moveDown(0.5);
  }

  renderFooter(doc, bundle);
  return toBuffer(doc);
}
