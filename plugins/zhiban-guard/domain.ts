/**
 * zhiban-guard 的 DSH 领域存储（#37）。
 *
 * tables:
 * - rules  风险规则（内置 + 租户自定义）
 * - alerts 告警（只存规则名与等级，不存消息正文）
 * - audit  审计事件
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

import type { AuditEvent } from '../../src/c2/types.ts';
import type {
  GuardAlertRecord,
  GuardBackend,
  RiskRuleRecord,
} from '../../src/p1/guard.ts';

export const guardDomain = defineDomain({
  name: 'zhiban_guard',
  version: 1,
  tables: {
    rules: domainTable(z.object({ id: z.string().min(1), kind: z.string().min(1) }).passthrough()),
    alerts: domainTable(z.object({ id: z.string().min(1) }).passthrough()),
    audit: domainTable(z.object({ at: z.number(), action: z.string().min(1) }).passthrough()),
  },
});

export type GuardDomainHandle = Domain<typeof guardDomain>;

interface AnyTable {
  entries(): IterableIterator<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export class DomainGuardBackend implements GuardBackend {
  private readonly rules: AnyTable;
  private readonly alerts: AnyTable;
  private readonly audits: AnyTable;

  constructor(domain: GuardDomainHandle) {
    this.rules = domain.table('rules') as unknown as AnyTable;
    this.alerts = domain.table('alerts') as unknown as AnyTable;
    this.audits = domain.table('audit') as unknown as AnyTable;
  }

  loadRules(): RiskRuleRecord[] {
    return [...this.rules.entries()].map(([, value]) => value as RiskRuleRecord);
  }

  loadAlerts(): GuardAlertRecord[] {
    return [...this.alerts.entries()].map(([, value]) => value as GuardAlertRecord);
  }

  putRule(rule: RiskRuleRecord): Promise<void> {
    return this.rules.put(rule.id, rule);
  }

  deleteRule(id: string): Promise<void> {
    return this.rules.delete(id).then(() => undefined);
  }

  putAlert(alert: GuardAlertRecord): Promise<void> {
    return this.alerts.put(alert.id, alert);
  }

  /** 审计事件落盘；调用方负责转发到全局事件流 */
  appendAudit(event: AuditEvent): Promise<void> {
    const key = `${event.at}_${event.action}_${event.target}`;
    return this.audits.put(key, event).then(() => undefined);
  }
}
