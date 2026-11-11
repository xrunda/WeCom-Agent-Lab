import { Alert, Descriptions, List, Space, Spin, Timeline, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { SampleDataTag } from '../../../components/SampleDataTag.tsx';
import { formatDate } from '../../../utils/format.ts';
import { isMockMode } from '../../../mock/http.ts';
import { getServicePlan, type ServicePlanSample } from '../../../mock/patients.ts';

const { Text } = Typography;

export function ServicePlanTab({ patientId, term }: { patientId: string; term: string }) {
  const [plan, setPlan] = useState<ServicePlanSample | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getServicePlan(patientId)
      .then((value) => {
        if (!cancelled) setPlan(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  if (loading) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center' }}>
        <Spin tip="正在加载服务计划…" />
      </div>
    );
  }

  if (error || !plan) {
    if (!isMockMode) {
      return (
        <Alert
          type="info"
          showIcon
          message="服务计划尚未接入真实数据"
          description="P1 只提供示例版服务计划；真实计划数据将在后续版本接入。真实模式下不展示示例内容，避免与真实客户混淆。"
        />
      );
    }
    return <Alert type="error" showIcon message={error ?? '暂无服务计划'} />;
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="warning"
        showIcon
        message={
          <Space size={8}>
            <span>服务计划为 B 档示例数据</span>
            <SampleDataTag compact />
          </Space>
        }
        description={`${term}的真实服务计划将在后续版本接入；当前数据仅用于展示布局。`}
      />
      <Descriptions
        bordered
        size="small"
        column={2}
        items={[
          { key: 'name', label: '计划名称', children: plan.planName },
          {
            key: 'period',
            label: '计划周期',
            children: `${formatDate(plan.startedAt)} 至 ${formatDate(plan.endsAt)}`,
          },
          {
            key: 'goals',
            label: '目标',
            children: (
              <List
                size="small"
                split={false}
                dataSource={plan.goals}
                renderItem={(goal) => <List.Item style={{ padding: 0 }}>· {goal}</List.Item>}
              />
            ),
          },
          {
            key: 'source',
            label: '数据来源',
            children: <Text type="secondary">预置示例数据，不来自真实链路</Text>,
          },
        ]}
      />
      <div>
        <Text strong style={{ display: 'block', marginBottom: 12 }}>
          计划节点
        </Text>
        <Timeline
          items={plan.sessions.map((session) => ({
            key: session.at,
            color: 'green',
            children: (
              <Space direction="vertical" size={0}>
                <Text strong>{session.title}</Text>
                <Text type="secondary">{formatDate(session.at)}</Text>
              </Space>
            ),
          }))}
        />
      </div>
    </Space>
  );
}
