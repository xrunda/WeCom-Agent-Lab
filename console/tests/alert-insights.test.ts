import { describe, expect, it } from 'vitest';

import { ALERT_KIND_LABELS, type Alert } from '../src/mock/alerts.ts';
import {
  alertGuidance,
  alertReason,
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
});
