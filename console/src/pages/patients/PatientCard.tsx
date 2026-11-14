import { ClockCircleOutlined, HeartOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Avatar, Badge, Card, Space, Tag, Tooltip, Typography } from 'antd';

import { daysSince, formatRelative } from '../../utils/format.ts';
import {
  CONSENT_HINTS,
  CONSENT_LABELS,
  PATIENT_STATUS_LABELS,
  type Patient,
} from '../../mock/patients.ts';

const { Paragraph, Text } = Typography;

export interface PatientCardProps {
  patient: Patient;
  term: string;
  online: boolean;
  advisorName: string;
  onOpen: () => void;
}

export function PatientCard({ patient, term, online, advisorName, onOpen }: PatientCardProps) {
  const initial = patient.displayName.slice(0, 1);

  return (
    <Card hoverable className="patient-card" onClick={onOpen}>
      <div className="patient-card-head">
        <Badge dot color={online ? '#16a34a' : '#cbd5e1'} offset={[-4, 30]}>
          <Avatar size={48} style={{ background: '#0f766e', fontSize: 18 }}>
            {initial}
          </Avatar>
        </Badge>
        <div className="patient-card-title">
          <Space size={6} align="center">
            <Text strong style={{ fontSize: 16 }}>
              {patient.displayName}
            </Text>
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {online ? '专属 Agent 在线' : '专属 Agent 离线'} · 顾问 {advisorName}
          </Text>
        </div>
        {patient.consent === 'disagreed' ? (
          <Tooltip title={CONSENT_HINTS.disagreed}>
            <Tag bordered={false} color="red" className="tag-tight">
              {CONSENT_LABELS.disagreed}
            </Tag>
          </Tooltip>
        ) : null}
      </div>

      <Space size={[6, 6]} wrap style={{ marginTop: 14 }}>
        {patient.identityStatus === 'pending' ? (
          <Tooltip title="系统按群内发言推测患者，可能不是本人；打开详情确认身份">
            <Tag bordered={false} color="gold" className="tag-tight">
              身份待确认
            </Tag>
          </Tooltip>
        ) : null}
        {patient.tags.map((tag) => (
          <Tag key={tag} bordered={false}>
            {tag}
          </Tag>
        ))}
        <Tag bordered={false} color={patient.status === 'serving' ? 'processing' : 'default'}>
          {PATIENT_STATUS_LABELS[patient.status]}
        </Tag>
      </Space>

      <div className="patient-card-stats">
        <div>
          <HeartOutlined />
          <span>陪伴 {daysSince(patient.accompaniedSince)} 天</span>
        </div>
        <div>
          <ThunderboltOutlined />
          <span>记忆 {patient.memoryCount} 条</span>
        </div>
        <div>
          <ClockCircleOutlined />
          <span>待执行 {patient.pendingPlanCount} 个</span>
        </div>
      </div>

      <Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
        最近互动：{formatRelative(patient.lastActiveAt)} · 点击查看 {term}的 Agent
      </Paragraph>
    </Card>
  );
}
