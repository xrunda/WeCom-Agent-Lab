/**
 * #59 「数据与安全」页的数据口径。
 *
 * 页面上的每一条都必须能在实现里找到出处：
 * - 部署事实来自插件配置 / 当前连接状态，不在前端写死；
 * - 留存口径来自 tenant.settings.retentionNotice（P1 不做自动删除）；
 * - 同意状态来自患者领域实时统计；
 * - 审计与导出记录来自控制台审计表。
 *
 * 响应字段在 docs/P1-api.md 的 `GET /settings/security` 基础上做了向后兼容的扩展
 * （新增 `modelService`、`dataStores`、`access`、近 30 天计数与 `pdf`）。
 */
import type { ConsoleAuditEvent } from './console-types.ts';

export interface SecurityOverview {
  deployment: {
    dataRegion: string;
    modelRegion: string;
    modelService: string;
    transport: string;
    retentionNotice: string;
    dataStores: string[];
  };
  retention: {
    notice: string;
    autoDelete: false;
  };
  roles: string[];
  access: {
    roles: Array<{ role: string; label: string; permissions: string[] }>;
  };
  audit: {
    enabled: true;
    exportable: true;
    retention: string;
    events30d: number;
    exports30d: number;
    lastExportAt: number | null;
  };
  consent: {
    agreed: number;
    unknown: number;
    disagreed: number;
    total: number;
  } | null;
  pdf: {
    fontConfigured: boolean;
  };
  generatedAt: number;
}

export interface SecurityOverviewInput {
  dataRegion: string;
  modelRegion: string;
  modelService: string;
  cookieSecure: boolean;
  mediaRootDir: string;
  modelName: string;
  retentionNotice: string;
  consent: SecurityOverview['consent'];
  roles: SecurityOverview['access']['roles'];
  audits: ConsoleAuditEvent[];
  now: number;
  pdfFontConfigured: boolean;
}

const EXPORT_ACTIONS = new Set(['evidence.export', 'records.export', 'audit.export']);
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const ROLE_ORDER = ['admin', 'supervisor', 'viewer'] as const;

export function buildSecurityOverview(input: SecurityOverviewInput): SecurityOverview {
  const since = input.now - THIRTY_DAYS;
  const recent = input.audits.filter((event) => event.at >= since);
  const exportsRecent = recent.filter((event) => EXPORT_ACTIONS.has(event.action));
  const lastExport = input.audits
    .filter((event) => EXPORT_ACTIONS.has(event.action))
    .sort((a, b) => b.at - a.at)[0];

  return {
    deployment: {
      dataRegion: input.dataRegion,
      modelRegion: input.modelRegion,
      modelService: input.modelService,
      transport: input.cookieSecure ? 'HTTPS（Secure Cookie）' : 'HTTP（仅本地调试，生产必须 HTTPS）',
      retentionNotice: input.retentionNotice,
      dataStores: [
        'DSH 领域存储（业务数据与审计）',
        input.mediaRootDir ? `沙盒与图片文件：${input.mediaRootDir}` : '沙盒与图片文件：本机 mediaRootDir',
        '企微会话存档（原文与实发核验）',
      ],
    },
    retention: {
      notice: input.retentionNotice,
      autoDelete: false,
    },
    roles: [...ROLE_ORDER],
    access: { roles: input.roles },
    audit: {
      enabled: true,
      exportable: true,
      retention: '不自动删除',
      events30d: recent.length,
      exports30d: exportsRecent.length,
      lastExportAt: lastExport?.at ?? null,
    },
    consent: input.consent,
    pdf: { fontConfigured: input.pdfFontConfigured },
    generatedAt: input.now,
  };
}
