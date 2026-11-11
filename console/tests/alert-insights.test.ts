import { describe, expect, it } from 'vitest';

import { ALERT_KIND_LABELS, type Alert } from '../src/mock/alerts.ts';
import {
  alertGuidance,
  alertReason,
  alertSourceLabel,
  relatedFlowTarget,
} from '../src/pages/alerts/alert-insights.ts';

function alertOf(patch: Partial<Alert>): Alert {
  return { kind: 'misroute', ...patch } as Alert;
}

describe('告警详情关联目标', () => {
  it('有关联草稿时直接打开该草稿详情', () => {
    const target = relatedFlowTarget(alertOf({ draftId: 'draft_1007', patientId: 'pat_03' }));

    expect(target).toMatchObject({ kind: 'draft', id: 'draft_1007' });
    expect(target?.path).toBe('/service-flow?draftId=draft_1007');
  });

  it('没有草稿但有患者时按患者筛选', () => {
    const target = relatedFlowTarget(alertOf({ draftId: null, patientId: 'pat_03' }));

    expect(target).toMatchObject({ kind: 'patient', id: 'pat_03' });
    expect(target?.path).toBe('/service-flow?patientId=pat_03');
  });

  it('既没有草稿也没有患者时返回 null，由界面说明无法定位', () => {
    expect(relatedFlowTarget(alertOf({ draftId: null, patientId: null }))).toBeNull();
  });
});

describe('告警原因与处理建议', () => {
  it('每种告警类型都有原因说明和处理建议', () => {
    for (const kind of Object.keys(ALERT_KIND_LABELS) as Alert['kind'][]) {
      expect(alertReason(kind).length).toBeGreaterThan(0);
      expect(alertGuidance(kind).length).toBeGreaterThan(0);
    }
  });

  it('未知类型有兜底文案，不会显示空白', () => {
    const unknown = 'future_kind' as Alert['kind'];
    expect(alertReason(unknown)).toContain('告警');
    expect(alertGuidance(unknown)).toContain('处理');
  });

  it('员工发言红线用员工视角的说明与处理建议，不按草稿文案提示', () => {
    expect(alertReason('redline', 'staff')).toContain('员工');
    expect(alertReason('redline', 'staff')).not.toContain('发送前');
    expect(alertGuidance('redline', 'staff')).toContain('撤回或更正');
    expect(alertGuidance('redline', 'draft')).toContain('拦截');
  });
});

describe('告警来源标签', () => {
  it('区分员工群发言、AI 草稿与系统事件', () => {
    expect(alertSourceLabel({ source: 'staff', draftId: null })).toBe('员工群发言');
    expect(alertSourceLabel({ source: 'draft', draftId: null })).toBe('AI 草稿');
    expect(alertSourceLabel({ source: null, draftId: 'draft_1' })).toBe('AI 草稿');
    expect(alertSourceLabel({ source: null, draftId: null })).toBe('系统事件');
  });
});
