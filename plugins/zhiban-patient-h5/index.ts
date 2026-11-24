/**
 * zhiban-patient-h5 插件（PH5-02 #231）。
 *
 * 患者端 H5 的身份、邀请、会话、分项授权与隐私申请服务。
 * - HTTP 挂在 `/zhiban/h5` 前缀（患者接口，独立 Cookie）
 * - 患者档案只读视图来自 `zhibanPatient`（顾问名册与患者状态），不重复建档
 * - 团队端接口由 plugins/zhiban-console/routes/ph5-invitations.ts 经
 *   `zhibanPatientH5` 调用（契约 api §12）
 *
 * 真实短信供应商未接入前 smsMode=unconfigured，真实登录阻塞（#229 待决项）；
 * smsMode=mock 仅限开发/测试，验证码固定 000000（契约 api §15）。
 */
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain';

import { idFactory } from '../../src/p1/ids.ts';
import {
  MemoryH5Backend,
  MOCK_SMS,
  PatientH5Service,
  UNCONFIGURED_SMS,
} from '../../src/p1/patient-h5.ts';
import type {
  ConsentScope,
  ConsentStatus,
  H5AuditRecord,
  H5BindingRecord,
  H5SessionRecord,
  InvitationRecord,
  PatientH5Backend,
  PrivacyRequestRecord,
  PrivacyRequestStatus,
} from '../../src/p1/patient-h5.ts';
import { parsePatientH5Config } from './config.ts';
import type { PatientH5Config } from './config.ts';
import { DomainPatientH5Backend, patientH5Domain } from './domain.ts';
import { registerPatientH5Http } from './http.ts';
import type { H5HttpRequest, H5HttpResponse } from './http.ts';

export const name = 'zhiban-patient-h5';

export const inject = ['storageDomain', 'webServer'];

export interface DshPatientH5Context {
  logger?: {
    info?(line: string): void;
    warn?(line: string): void;
    error?(line: string): void;
  };
  effect(fn: () => void | Promise<void>): unknown;
  emit(type: string, data: unknown): unknown;
  provide(name: string, value: unknown): unknown;
  get<T = unknown>(name: string): T | undefined;
  storageDomain: {
    open<S extends DomainSpec>(spec: S): Promise<Domain<S>>;
  };
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix';
      path: string;
      handler: (req: H5HttpRequest, res: H5HttpResponse) => unknown;
    }): unknown;
  };
}

/** 患者档案只读视图（来自 zhiban-patient） */
interface PatientViewLike {
  id: string;
  displayName: string;
  status: string;
  advisorId?: string;
}

interface PatientApiLike {
  getPatientAdmin?(id: string): PatientViewLike | undefined;
}

/** 暴露给控制台团队端路由的 API（契约 api §12.1/§12.7/§12.8） */
export interface PatientH5RuntimeApi {
  config: PatientH5Config;
  createInvitation(input: {
    patientId: string;
    phone: string;
    ttlHours?: number;
    note?: string;
    createdBy: string;
  }): Promise<InvitationRecord>;
  listInvitations(patientId: string): InvitationRecord[];
  invitationView(record: InvitationRecord): Omit<InvitationRecord, 'code' | 'phone'>;
  revokeInvitation(id: string, revokedBy: string): Promise<InvitationRecord>;
  getBinding(patientId: string): H5BindingRecord | undefined;
  listSessions(patientId: string): H5SessionRecord[];
  revokeSession(sessionId: string, by: 'account', accountId: string): Promise<void>;
  consentsView(patientId: string): Record<string, ConsentStatus>;
  consentStatus(patientId: string, scope: ConsentScope): ConsentStatus;
  listPrivacyRequests(status?: PrivacyRequestStatus): PrivacyRequestRecord[];
  handlePrivacyRequest(input: {
    id: string;
    result: 'handled' | 'rejected';
    note: string;
    handledBy: string;
  }): Promise<PrivacyRequestRecord>;
  meStatus(patientId: string): string;
  /** 供控制台展示邀请链接（一次性返回，不落日志；列表不再回 code） */
  invitationLink(record: InvitationRecord, publicBaseUrl: string): string;
}

const DEFAULT_H5_PUBLIC_BASE = 'https://h5.example.invalid';

export function apply(ctx: DshPatientH5Context, rawConfig: unknown): void {
  const config = parsePatientH5Config(rawConfig);
  const log = (line: string): void => ctx.logger?.info?.(`[zhiban-patient-h5] ${line}`);

  log(
    `加载配置：租户=${config.tenantId} 短信=${config.smsMode} ` +
      `登录模式=${config.patientLoginMode}`,
  );

  const sms =
    config.smsMode === 'mock'
      ? MOCK_SMS
      : UNCONFIGURED_SMS;
  if (config.smsMode !== 'mock') {
    log('短信通道未配置：真实登录阻塞（SMS_UNAVAILABLE），演示只能用虚构数据');
  }

  // 患者视图懒加载：zhiban-patient 晚于本插件就绪也能查
  const patientView = (patientId: string): PatientViewLike | undefined => {
    const api = ctx.get<PatientApiLike>('zhibanPatient');
    const patient = api?.getPatientAdmin?.(patientId);
    if (!patient) return undefined;
    return {
      id: patient.id,
      displayName: patient.displayName,
      status: patient.status,
      ...(patient.advisorId ? { advisorId: patient.advisorId } : {}),
    };
  };

  ctx.effect(async () => {
    let backend: PatientH5Backend;
    try {
      const domain = await ctx.storageDomain.open(patientH5Domain);
      backend = new DomainPatientH5Backend(domain, config.tenantId);
    } catch (error) {
      // 存储域不可用（如测试环境）：退回内存后端，并告警
      ctx.logger?.warn?.(
        `[zhiban-patient-h5] 领域存储打开失败，退回内存后端：${error instanceof Error ? error.name : 'UNKNOWN'}`,
      );
      backend = new MemoryH5Backend();
    }

    const service = new PatientH5Service({
      tenantId: config.tenantId,
      backend,
      sms,
      loadPatient: patientView,
      ids: idFactory(Date.now),
      invitationTtlMs: config.invitationTtlMs,
      sessionAbsoluteTtlMs: config.sessionAbsoluteTtlMs,
      sessionIdleTtlMs: config.sessionIdleTtlMs,
      verifyCodeTtlMs: config.verifyCodeTtlMs,
      patientLoginMode: config.patientLoginMode,
      consentTextsVersion: config.consentTextsVersion,
      retentionNotice: config.retentionNotice,
      onConsentChange: (patientId, scope, status) => {
        // 取消传播钩子（契约 §5）：PH5-09 提醒包接入后在此取消未发出提醒
        ctx.emit('h5.consent.change', { patientId, scope, status, at: Date.now() });
      },
      onAudit: (record: H5AuditRecord) => {
        ctx.emit('h5.audit', record);
      },
    });

    const api: PatientH5RuntimeApi = {
      config,
      createInvitation: (input) =>
        service.createInvitation({
          ...input,
          advisorId: patientView(input.patientId)?.advisorId ?? 'unknown',
        }),
      listInvitations: (patientId) => service.listInvitations(patientId),
      invitationView: (record) => service.invitationView(record),
      revokeInvitation: (id, revokedBy) => service.revokeInvitation(id, revokedBy),
      getBinding: (patientId) => service.getBinding(patientId),
      listSessions: (patientId) => service.listSessions(patientId),
      revokeSession: (sessionId, _by, accountId) =>
        service.revokeSession(sessionId, 'account', accountId),
      consentsView: (patientId) => service.consentsView(patientId),
      consentStatus: (patientId, scope) => service.consentStatus(patientId, scope),
      listPrivacyRequests: (status) => service.listPrivacyRequests(status),
      handlePrivacyRequest: (input) => service.handlePrivacyRequest(input),
      meStatus: (patientId) => {
        const patient = patientView(patientId);
        return patient ? service.meStatus(patient) : 'service_paused';
      },
      invitationLink: (record, publicBaseUrl) =>
        `${publicBaseUrl || DEFAULT_H5_PUBLIC_BASE}/h5/invite?code=${encodeURIComponent(record.code)}`,
    };
    ctx.provide('zhibanPatientH5', api);

    registerPatientH5Http(ctx.webServer, {
      service,
      allowedOrigins: config.allowedOrigins,
      log,
    });

    log('患者端 H5 接口已注册：/zhiban/h5');
  });
}
