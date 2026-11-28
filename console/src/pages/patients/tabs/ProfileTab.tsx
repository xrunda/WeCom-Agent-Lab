import { App, Button, Descriptions, InputNumber, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { useState } from 'react';

import { daysSince, formatDateTime } from '../../../utils/format.ts';
import {
  CONSENT_HINTS,
  CONSENT_LABELS,
  PATIENT_STATUS_LABELS,
  updatePatient,
  type PatientDetail,
  type PatientSex,
} from '../../../mock/patients.ts';

const { Text } = Typography;

const SEX_LABELS: Record<PatientSex, string> = { male: '男', female: '女', unspecified: '未说明' };

/** 只有出生年：按年份差算年龄，和事实卡口径一致 */
function ageText(birthYear: number): string {
  return `${Math.max(0, new Date().getFullYear() - birthYear)} 岁`;
}

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
  const [birthYear, setBirthYear] = useState<number | null>(patient.birthYear ?? null);
  const [sex, setSex] = useState<PatientSex | null>(patient.sex ?? null);
  const [saving, setSaving] = useState(false);
  const [savingBasics, setSavingBasics] = useState(false);
  const changed = tags.join('|') !== patient.tags.join('|');
  const basicsChanged =
    (birthYear ?? null) !== (patient.birthYear ?? null) || (sex ?? null) !== (patient.sex ?? null);

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

  const saveBasics = async () => {
    setSavingBasics(true);
    try {
      // null 表示清空：回到「档案没有这项」，而不是留一个猜出来的值
      await updatePatient(patient.id, { birthYear, sex });
      message.success('基础信息已保存');
      onSaved();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSavingBasics(false);
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
            key: 'identity',
            label: '患者身份',
            children:
              patient.identityStatus === 'pending' ? (
                <Tooltip title="系统按群内发言推测，可能不是本人；请在详情顶部确认身份">
                  <Tag bordered={false} color="gold">
                    待确认
                  </Tag>
                </Tooltip>
              ) : (
                <Tooltip title={patient.identitySource === 'manual' ? '顾问已在控制台确认' : undefined}>
                  <Tag bordered={false} color="green">
                    已确认
                  </Tag>
                </Tooltip>
              ),
          },
          {
            key: 'status',
            label: '服务状态',
            children: <Tag bordered={false}>{PATIENT_STATUS_LABELS[patient.status]}</Tag>,
          },
          {
            key: 'consent',
            label: '存档同意',
            children: (
              <Tooltip title={CONSENT_HINTS[patient.consent]}>
                <Tag
                  bordered={false}
                  color={patient.consent === 'agreed' ? 'green' : patient.consent === 'disagreed' ? 'red' : 'gold'}
                >
                  {CONSENT_LABELS[patient.consent]}
                </Tag>
              </Tooltip>
            ),
          },
          {
            key: 'basics',
            label: '年龄 / 性别',
            children:
              patient.birthYear || patient.sex ? (
                <Space size={6} wrap>
                  {patient.birthYear ? (
                    <Tag bordered={false}>
                      {ageText(patient.birthYear)}（{patient.birthYear} 年生）
                    </Tag>
                  ) : null}
                  {patient.sex ? <Tag bordered={false}>{SEX_LABELS[patient.sex]}</Tag> : null}
                </Space>
              ) : (
                '未填'
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
            key: 'dataSource',
            label: '数据来源',
            children: <Tag bordered={false}>真实服务数据</Tag>,
          },
        ]}
      />

      <div>
        <Text strong style={{ display: 'block', marginBottom: 8 }}>
          基础信息（年龄 / 性别）
        </Text>
        <Space wrap>
          <InputNumber
            min={1900}
            max={new Date().getFullYear()}
            precision={0}
            placeholder="出生年，例如 1958"
            style={{ width: 160 }}
            value={birthYear ?? undefined}
            disabled={!canWrite}
            onChange={(value) => setBirthYear(typeof value === 'number' ? value : null)}
          />
          <Select
            allowClear
            style={{ width: 140 }}
            placeholder="性别"
            value={sex ?? undefined}
            disabled={!canWrite}
            options={(Object.keys(SEX_LABELS) as PatientSex[]).map((value) => ({
              value,
              label: SEX_LABELS[value],
            }))}
            onChange={(value?: PatientSex) => setSex(value ?? null)}
          />
          <Button
            type="primary"
            disabled={!canWrite || !basicsChanged}
            loading={savingBasics}
            onClick={() => void saveBasics()}
          >
            保存基础信息
          </Button>
        </Space>
        <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          只存出生年，年龄按当年换算；清空即视为档案未填，不会推断。会随事实卡注入患者与顾问 Agent。
        </Text>
      </div>

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
