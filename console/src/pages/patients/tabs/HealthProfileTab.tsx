import { Alert, Descriptions, Space, Spin, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { SampleDataTag } from '../../../components/SampleDataTag.tsx';
import { formatDateTime } from '../../../utils/format.ts';
import { getHealthProfile, type HealthProfile } from '../../../mock/patients.ts';

const { Text } = Typography;

export function HealthProfileTab({ patientId, term }: { patientId: string; term: string }) {
  const [profile, setProfile] = useState<HealthProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getHealthProfile(patientId)
      .then((value) => {
        if (!cancelled) setProfile(value);
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
        <Spin tip="正在加载健康档案…" />
      </div>
    );
  }

  if (error || !profile) {
    return <Alert type="error" showIcon message={error ?? '暂无健康档案'} />;
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="warning"
        showIcon
        message={
          <Space size={8}>
            <span>健康档案为 B 档示例数据</span>
            <SampleDataTag compact />
          </Space>
        }
        description={`${term}的真实健康档案将在后续版本接入；当前数据仅用于展示布局与口径。`}
      />
      <Descriptions
        bordered
        size="small"
        column={2}
        items={[
          { key: 'height', label: '身高', children: `${profile.heightCm} cm` },
          { key: 'weight', label: '体重', children: `${profile.weightKg} kg` },
          { key: 'bmi', label: 'BMI', children: profile.bmi.toFixed(1) },
          { key: 'bp', label: '血压', children: `${profile.bloodPressure} mmHg` },
          {
            key: 'conditions',
            label: '慢病 / 关注点',
            children: profile.conditions.map((item) => (
              <Tag key={item} bordered={false}>
                {item}
              </Tag>
            )),
          },
          {
            key: 'medications',
            label: '用药',
            children: profile.medications.map((item) => (
              <Tag key={item} bordered={false} color="blue">
                {item}
              </Tag>
            )),
          },
          {
            key: 'updatedAt',
            label: '更新时间',
            children: formatDateTime(profile.updatedAt),
          },
          {
            key: 'source',
            label: '数据来源',
            children: <Text type="secondary">预置示例数据，不来自真实链路</Text>,
          },
        ]}
      />
    </Space>
  );
}
