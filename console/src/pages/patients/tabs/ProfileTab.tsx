import { App, Button, Descriptions, Select, Space, Tag, Typography } from 'antd';
import { useState } from 'react';

import { daysSince, formatDateTime } from '../../../utils/format.ts';
import {
  CONSENT_LABELS,
  PATIENT_STATUS_LABELS,
  updatePatient,
  type PatientDetail,
} from '../../../mock/patients.ts';

const { Text } = Typography;

export interface ProfileTabProps {
  detail: PatientDetail;
  term: string;
  canWrite: boolean;
  onSaved: () => void;
}

export function ProfileTab({ detail, term, canWrite, onSaved }: ProfileTabProps) {
  const { message } = App.useApp();
  const { patient, advisor, groups } = detail;
  const [tags, setTags] = useState<string[]>(patient.tags);
  const [saving, setSaving] = useState(false);
  const changed = tags.join('|') !== patient.tags.join('|');

  const save = async () => {
    setSaving(true);
    try {
      await updatePatient(patient.id, { tags });
      message.success('标签已保存');
      onSaved();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <Descriptions
        bordered
        size="small"
        column={2}
        items={[
          { key: 'name', label: `${term}备注名`, children: patient.displayName },
          {
            key: 'status',
            label: '服务状态',
            children: <Tag bordered={false}>{PATIENT_STATUS_LABELS[patient.status]}</Tag>,
          },
          {
            key: 'consent',
            label: '存档同意',
            children: (
              <Tag
                bordered={false}
                color={patient.consent === 'agreed' ? 'green' : patient.consent === 'disagreed' ? 'red' : 'gold'}
              >
                {CONSENT_LABELS[patient.consent]}
              </Tag>
            ),
          },
          {
            key: 'advisor',
            label: '主责顾问',
            children: advisor ? `${advisor.name}${advisor.online ? '（在线）' : ''}` : '未分配',
          },
          {
            key: 'accompanied',
            label: '陪伴时长',
            children: `${daysSince(patient.accompaniedSince)} 天（${formatDateTime(patient.accompaniedSince)} 开始）`,
          },
          {
            key: 'lastActive',
            label: '最近互动',
            children: formatDateTime(patient.lastActiveAt),
          },
          {
            key: 'groups',
            label: '服务群',
            children:
              groups.length > 0
                ? groups.map((group) => (
                    <Tag key={group.id} bordered={false}>
                      {group.name}
                      {group.isPrimary ? '（主群）' : ''}
                    </Tag>
                  ))
                : '未绑定',
          },
          {
            key: 'demo',
            label: '数据来源',
            children: patient.demo ? (
              <Tag bordered={false} color="purple">
                演示环境记录
              </Tag>
            ) : (
              <Tag bordered={false}>真实服务数据</Tag>
            ),
          },
        ]}
      />

      <div>
        <Text strong style={{ display: 'block', marginBottom: 8 }}>
          {term}标签
        </Text>
        <Space.Compact style={{ width: '100%' }}>
          <Select
            mode="tags"
            style={{ flex: 1 }}
            value={tags}
            disabled={!canWrite}
            placeholder="输入标签后回车，例如：控糖、高血压"
            options={tags.map((tag) => ({ label: tag, value: tag }))}
            onChange={setTags}
          />
          <Button type="primary" disabled={!canWrite || !changed} loading={saving} onClick={() => void save()}>
            保存
          </Button>
        </Space.Compact>
        <Text type="secondary" style={{ fontSize: 12 }}>
          标签用于列表筛选与方案匹配；修改会记录到审计日志。
        </Text>
      </div>
    </Space>
  );
}
