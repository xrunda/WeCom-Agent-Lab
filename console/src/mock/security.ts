/**
 * #59 数据与安全页。mock 模式返回虚构演示数据；
 * 真实模式的口径全部来自 `GET /settings/security`，前端不写死部署事实。
 */
import { getTenant } from './api.ts';
import { apiRequest, isMockMode } from './http.ts';
import { listPatients } from './patients.ts';
import { getPermissionMatrix, listAudit } from './settings.ts';
import type { SecurityOverview } from '../types.ts';

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const EXPORT_ACTIONS = new Set(['evidence.export', 'records.export', 'audit.export']);

/** mock 模式页头提示：避免把演示数据当成当前部署事实 */
export const MOCK_SECURITY_NOTICE =
  '演示模式：以下为虚构演示数据；真实部署的存放位置、模型服务与留存口径由服务端返回。';

/** GET /settings/security */
export async function getSecurityOverview(): Promise<SecurityOverview> {
  if (!isMockMode) return apiRequest('/settings/security');

  const [tenant, patients, matrix, audit] = await Promise.all([
    getTenant(),
    listPatients({ pageSize: 1000 }),
    getPermissionMatrix(),
    listAudit({ pageSize: 1000 }),
  ]);
  const now = Date.now();
  const recent = audit.items.filter((event) => event.at >= now - THIRTY_DAYS);
  const exportsRecent = recent.filter((event) => EXPORT_ACTIONS.has(event.action));
  const lastExport = audit.items
    .filter((event) => EXPORT_ACTIONS.has(event.action))
    .sort((a, b) => b.at - a.at)[0];

  const consent = { agreed: 0, unknown: 0, disagreed: 0, total: 0 };
  for (const patient of patients.items) {
    consent.total += 1;
    consent[patient.consent] += 1;
  }

  return {
    deployment: {
      dataRegion: '中国大陆境内',
      modelRegion: '中国大陆境内',
      modelService: `DeepSeek 专有部署（${tenant.settings.modelName}）`,
      transport: 'HTTP（仅本地调试，生产必须 HTTPS）',
      retentionNotice: tenant.settings.retentionNotice,
      dataStores: [
        'DSH 领域存储（业务数据与审计）',
        '沙盒与图片文件：/srv/zhiban/media（演示路径）',
        '企微会话存档（原文与实发核验）',
      ],
    },
    retention: {
      notice: tenant.settings.retentionNotice,
      autoDelete: false,
    },
    roles: matrix.roles.map((role) => role.role),
    consent,
    access: { roles: matrix.roles },
    audit: {
      enabled: true,
      exportable: true,
      retention: '不自动删除',
      events30d: recent.length,
      exports30d: exportsRecent.length,
      lastExportAt: lastExport?.at ?? null,
    },
    // 演示模式不生成服务端 PDF；字体状态只在真实部署有意义
    pdf: { fontConfigured: false },
    generatedAt: now,
  };
}
