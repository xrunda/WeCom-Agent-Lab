/**
 * #59 证据链 / 服务记录导出与数据安全页口径的单测。
 *
 * 只测数据装配与 PDF 结构，不启动宿主、不连接企微、不读真实消息正文。
 * PDF 中文字体依赖部署机：找不到字体时跳过渲染断言，单独验证 502 所需的错误类型。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { requirePdfFont, renderEvidencePdf, renderRecordsPdf, resolvePdfFont } from '../plugins/zhiban-console/pdf.ts';
import { ConsoleError } from '../src/p1/console-error.ts';
import {
  EvidenceService,
  RECORDS_DEFAULT_WINDOW_MS,
  RECORDS_LIMIT,
} from '../src/p1/evidence.ts';
import type { EvidenceDraftSource, EvidenceWecomPort } from '../src/p1/evidence.ts';
import { buildSecurityOverview } from '../src/p1/security.ts';
import type { ConsoleAuditEvent } from '../src/p1/console-types.ts';

const NOW = 1_700_000_000_000;

function source(overrides: Partial<EvidenceDraftSource> = {}): EvidenceDraftSource {
  return {
    id: 'draft_1',
    advisorId: 'adv_1',
    advisorName: '陈顾问',
    groupRoomId: 'room_1',
    groupName: '康养服务群',
    customerName: '张女士',
    inboundSummary: '客户询问晚餐怎么吃',
    inboundMessageIds: ['m_in_1'],
    mediaIds: [],
    body: '晚餐清淡一点，避开海鲜。',
    version: 1,
    revisions: [
      { version: 1, body: '晚餐清淡一点，避开海鲜。', createdBy: 'agent', createdAt: NOW },
    ],
    status: 'VERIFIED',
    riskLevel: 'low',
    sentVersion: 1,
    verification: {
      outcome: 'VERIFIED',
      matchedMsgId: 'm_sent_1',
      matchedRoomId: 'room_1',
      similarity: 1,
      checkedAt: NOW + 60_000,
    },
    createdAt: NOW,
    citedMemoryIds: [],
    citedKnowledgeIds: [],
    inbound: [],
    sent: { msgid: 'm_sent_1', text: '晚餐清淡一点，避开海鲜。', msgtime: NOW + 60_000 },
    ...overrides,
  };
}

function service(
  options: {
    wecom?: EvidenceWecomPort;
    patient?: {
      getPatientGroups(id: string):
        | {
            patient: { id: string; displayName: string };
            groups: Array<{ id: string; name: string; roomId: string }>;
          }
        | undefined;
    };
  } = {},
): EvidenceService {
  return new EvidenceService({
    tenantName: '安康健康管理中心',
    now: () => NOW,
    wecom: () => options.wecom,
    patient: () => options.patient,
  });
}

test('单条证据：缺失 id / 插件未就绪 / 草稿不存在分别报错', async () => {
  await assert.rejects(
    service().draftEvidence('  ', '林主管'),
    (error: unknown) =>
      error instanceof ConsoleError && error.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    service().draftEvidence('draft_1', '林主管'),
    (error: unknown) =>
      error instanceof ConsoleError && error.code === 'UPSTREAM_UNAVAILABLE',
  );
  const missing = service({ wecom: { getDraftEvidence: async () => undefined, listDraftsByRooms: async () => [] } });
  await assert.rejects(
    missing.draftEvidence('draft_404', '林主管'),
    (error: unknown) => error instanceof ConsoleError && error.code === 'NOT_FOUND',
  );
});

test('单条证据：导出人、租户名与导出时间由服务层补齐', async () => {
  const bundle = await service({
    wecom: {
      getDraftEvidence: async (id) => (id === 'draft_1' ? source() : undefined),
      listDraftsByRooms: async () => [],
    },
  }).draftEvidence(' draft_1 ', '林主管');

  assert.equal(bundle.tenantName, '安康健康管理中心');
  assert.equal(bundle.exportedBy, '林主管');
  assert.equal(bundle.exportedAt, NOW);
  assert.equal(bundle.draft.id, 'draft_1');
});

test('患者服务记录：默认最近 30 天、按时间倒序、按群过滤', async () => {
  const calls: Array<{ roomIds: string[]; from: number; to: number }> = [];
  const wecom: EvidenceWecomPort = {
    getDraftEvidence: async () => undefined,
    async listDraftsByRooms(roomIds, from, to) {
      calls.push({ roomIds, from, to });
      return [
        source({ id: 'draft_old', createdAt: NOW - 10_000 }),
        source({ id: 'draft_new', createdAt: NOW - 1_000 }),
        source({ id: 'draft_other', groupRoomId: 'room_other', createdAt: NOW - 500 }),
      ];
    },
  };
  const patient = {
    getPatientGroups: (id: string) =>
      id === 'pat_1'
        ? {
            patient: { id: 'pat_1', displayName: '张女士' },
            groups: [
              { id: 'grp_1', name: '康养服务群', roomId: 'room_1' },
              { id: 'grp_2', name: '复诊群', roomId: 'room_2' },
            ],
          }
        : undefined,
  };

  const bundle = await service({ wecom, patient }).patientRecords('pat_1', '林主管');
  assert.deepEqual(calls, [
    { roomIds: ['room_1', 'room_2'], from: NOW - RECORDS_DEFAULT_WINDOW_MS, to: NOW },
  ]);
  assert.deepEqual(
    bundle.records.map((record) => record.id),
    ['draft_new', 'draft_old'],
  );
  assert.equal(bundle.truncated, false);
  assert.equal(bundle.groups.length, 2);
});

test('患者服务记录：时间范围校验、患者不存在、未绑定群', async () => {
  const patient = {
    getPatientGroups: (id: string) =>
      id === 'pat_1'
        ? {
            patient: { id: 'pat_1', displayName: '张女士' },
            groups: [],
          }
        : undefined,
  };

  await assert.rejects(
    service({ wecom: { getDraftEvidence: async () => undefined, listDraftsByRooms: async () => [] }, patient })
      .patientRecords('pat_1', '林主管', { from: NOW, to: NOW }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    service({ patient }).patientRecords('pat_404', '林主管'),
    (error: unknown) => error instanceof ConsoleError && error.code === 'NOT_FOUND',
  );

  const bundle = await service({
    wecom: {
      getDraftEvidence: async () => undefined,
      listDraftsByRooms: async () => {
        throw new Error('未绑定时不应查询存档');
      },
    },
    patient,
  }).patientRecords('pat_1', '林主管');
  assert.deepEqual(bundle.records, []);
  assert.equal(bundle.truncated, false);
});

test(`患者服务记录：超过 ${RECORDS_LIMIT} 条时截断并标记`, async () => {
  const records = Array.from({ length: RECORDS_LIMIT + 5 }, (_, index) =>
    source({ id: `draft_${index}`, createdAt: NOW - index }),
  );
  const bundle = await service({
    wecom: { getDraftEvidence: async () => undefined, listDraftsByRooms: async () => records },
    patient: {
      getPatientGroups: () => ({
        patient: { id: 'pat_1', displayName: '张女士' },
        groups: [{ id: 'grp_1', name: '康养服务群', roomId: 'room_1' }],
      }),
    },
  }).patientRecords('pat_1', '林主管');

  assert.equal(bundle.records.length, RECORDS_LIMIT);
  assert.equal(bundle.truncated, true);
  assert.equal(bundle.records[0]!.id, 'draft_0');
});

function audit(overrides: Partial<ConsoleAuditEvent> = {}): ConsoleAuditEvent {
  return {
    id: `audit_${Math.random().toString(36).slice(2)}`,
    tenantId: 'tn_1',
    actorType: 'account',
    actorId: 'acc_1',
    actorName: '林主管',
    action: 'tenant.update',
    targetType: 'tenant',
    targetId: 'tn_1',
    result: 'success',
    at: NOW,
    sandbox: false,
    ...overrides,
  };
}

test('数据安全页：近 30 天事件与导出计数、最近导出时间、传输口径', () => {
  const overview = buildSecurityOverview({
    dataRegion: '中国大陆境内',
    modelRegion: '中国大陆境内',
    modelService: 'DeepSeek（境内）',
    cookieSecure: true,
    mediaRootDir: '/srv/zhiban/media',
    modelName: 'deepseek-chat',
    retentionNotice: '按合同约定；当前演示环境不自动删除',
    consent: { agreed: 3, unknown: 1, disagreed: 0, total: 4 },
    roles: [{ role: 'viewer', label: '只读', permissions: ['tenant.read'] }],
    audits: [
      audit({ action: 'evidence.export', at: NOW - 1_000 }),
      audit({ action: 'records.export', at: NOW - 2_000 }),
      audit({ action: 'audit.export', at: NOW - 30 * 24 * 60 * 60 * 1000 - 1 }),
      audit({ action: 'tenant.update', at: NOW }),
      audit({ action: 'patient.update', at: NOW - 40 * 24 * 60 * 60 * 1000 }),
    ],
    now: NOW,
    pdfFontConfigured: true,
  });

  assert.match(overview.deployment.transport, /^HTTPS/);
  assert.ok(overview.deployment.dataStores.some((store) => store.includes('/srv/zhiban/media')));
  assert.equal(overview.retention.notice, '按合同约定；当前演示环境不自动删除');
  assert.equal(overview.retention.autoDelete, false);
  assert.deepEqual(overview.consent, { agreed: 3, unknown: 1, disagreed: 0, total: 4 });
  assert.equal(overview.audit.events30d, 3);
  assert.equal(overview.audit.exports30d, 2);
  assert.equal(overview.audit.lastExportAt, NOW - 1_000);
  assert.equal(overview.pdf.fontConfigured, true);
});

test('数据安全页：HTTP 部署明确标注仅本地调试', () => {
  const overview = buildSecurityOverview({
    dataRegion: '中国大陆境内',
    modelRegion: '中国大陆境内',
    modelService: 'DeepSeek（境内）',
    cookieSecure: false,
    mediaRootDir: '',
    modelName: 'deepseek-chat',
    retentionNotice: '按合同约定；当前演示环境不自动删除',
    consent: null,
    roles: [],
    audits: [],
    now: NOW,
    pdfFontConfigured: false,
  });
  assert.match(overview.deployment.transport, /仅本地调试/);
  assert.equal(overview.consent, null);
  assert.equal(overview.audit.lastExportAt, null);
});

test('PDF：缺少字体时抛 UPSTREAM_UNAVAILABLE；有字体时生成合法 PDF', async () => {
  assert.throws(
    () => requirePdfFont(undefined),
    (error: unknown) => error instanceof ConsoleError && error.code === 'UPSTREAM_UNAVAILABLE',
  );

  const font = resolvePdfFont({});
  if (!font) return; // 部署机无中文字体：只验证 502 路径，不伪造渲染成功

  const evidencePdf = await renderEvidencePdf(
    {
      tenantName: '安康健康管理中心',
      exportedBy: '林主管',
      exportedAt: NOW,
      draft: source({
        inbound: [
          { msgid: 'm_in_1', from: 'wx_customer', text: '晚上能吃海鲜吗？', msgtime: NOW },
        ],
        revisions: [
          { version: 1, body: '晚餐清淡一点。', createdBy: 'agent', createdAt: NOW },
          {
            version: 2,
            body: '晚餐清淡一点，避开海鲜。',
            instruction: '加上忌口提醒',
            createdBy: 'staff',
            createdAt: NOW + 1_000,
          },
        ],
        version: 2,
      }),
    },
    font,
  );
  assert.match(evidencePdf.subarray(0, 8).toString('latin1'), /^%PDF-1\./);
  assert.equal(evidencePdf.subarray(-6).toString('latin1').includes('%%EOF'), true);

  const recordsPdf = await renderRecordsPdf(
    {
      tenantName: '安康健康管理中心',
      exportedBy: '林主管',
      exportedAt: NOW,
      patient: { id: 'pat_1', displayName: '张女士' },
      groups: [{ id: 'grp_1', name: '康养服务群', roomId: 'room_1' }],
      from: NOW - RECORDS_DEFAULT_WINDOW_MS,
      to: NOW,
      records: [source()],
      truncated: false,
    },
    font,
  );
  assert.match(recordsPdf.subarray(0, 8).toString('latin1'), /^%PDF-1\./);
  assert.equal(recordsPdf.subarray(-6).toString('latin1').includes('%%EOF'), true);
});
