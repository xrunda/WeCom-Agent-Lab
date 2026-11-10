import { FilePdfOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Modal,
  Space,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../../auth/AuthContext.tsx';
import {
  MOCK_EXPORT_NOTICE,
  exportPatientRecordsPdf,
  isMockOnly,
} from '../../mock/exports.ts';
import { isMockMode } from '../../mock/http.ts';
import { daysSince, formatDateTime } from '../../utils/format.ts';
import {
  CONSENT_HINTS,
  CONSENT_LABELS,
  getPatientDetail,
  PATIENT_STATUS_LABELS,
  type PatientDetail,
} from '../../mock/patients.ts';
import { ActionsTab } from './tabs/ActionsTab.tsx';
import { CarePlansTab } from './tabs/CarePlansTab.tsx';
import { DietTab } from './tabs/DietTab.tsx';
import { HealthProfileTab } from './tabs/HealthProfileTab.tsx';
import { MemoriesTab } from './tabs/MemoriesTab.tsx';
import { ProfileTab } from './tabs/ProfileTab.tsx';
import { ServicePlanTab } from './tabs/ServicePlanTab.tsx';
import { TimelineTab } from './tabs/TimelineTab.tsx';

const { Text, Title } = Typography;

export interface AgentDrawerProps {
  patientId: string | null;
  term: string;
  onClose: () => void;
  onChanged: () => void;
}

export function AgentDrawer({ patientId, term, onClose, onChanged }: AgentDrawerProps) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const [detail, setDetail] = useState<PatientDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportRange, setExportRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!patientId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getPatientDetail(patientId)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) message.error(error instanceof Error ? error.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [patientId, refreshKey, message]);

  const reload = useCallback(() => {
    setRefreshKey((value) => value + 1);
    onChanged();
  }, [onChanged]);

  const patient = detail?.patient;

  const openExport = useCallback(() => {
    setExportRange([dayjs().subtract(29, 'day').startOf('day'), dayjs().endOf('day')]);
    setExportOpen(true);
  }, []);

  const submitExport = useCallback(async () => {
    if (!patient) return;
    if (!exportRange) {
      message.warning('请选择时间范围');
      return;
    }
    const from = exportRange[0].startOf('day').valueOf();
    const to = exportRange[1].endOf('day').valueOf();
    if (from >= to) {
      message.warning('开始日期必须早于结束日期');
      return;
    }
    setExporting(true);
    try {
      await exportPatientRecordsPdf(patient.id, { from, to });
      message.success('已开始下载服务记录 PDF');
      setExportOpen(false);
    } catch (error) {
      if (isMockOnly(error)) message.info(MOCK_EXPORT_NOTICE);
      else message.error(error instanceof Error ? error.message : '导出失败');
    } finally {
      setExporting(false);
    }
  }, [exportRange, message, patient]);

  return (
    <>
    <Drawer
      open={Boolean(patientId)}
      onClose={onClose}
      width={920}
      destroyOnHidden
      extra={
        patient && can('draft.export') ? (
          <Button icon={<FilePdfOutlined />} onClick={openExport}>
            导出服务记录
          </Button>
        ) : undefined
      }
      title={
        patient ? (
          <Space size={10} wrap>
            <Title level={5} style={{ margin: 0 }}>
              {patient.displayName}
            </Title>
            <Tag bordered={false} color={patient.status === 'serving' ? 'processing' : 'default'}>
              {PATIENT_STATUS_LABELS[patient.status]}
            </Tag>
            {patient.consent === 'disagreed' ? (
              <Tooltip title={CONSENT_HINTS.disagreed}>
                <Tag bordered={false} color="red">
                  {CONSENT_LABELS.disagreed}
                </Tag>
              </Tooltip>
            ) : null}
            <Text type="secondary" style={{ fontSize: 12 }}>
              陪伴 {daysSince(patient.accompaniedSince)} 天 · 记忆 {patient.memoryCount} 条 ·
              待执行 {patient.pendingPlanCount} 个
            </Text>
          </Space>
        ) : (
          `${term} Agent`
        )
      }
    >
      {loading || !detail ? (
        <div style={{ padding: '80px 0', textAlign: 'center' }}>
          <Spin tip={`正在加载${term}的 Agent…`} />
        </div>
      ) : (
        <>
          <Descriptions
            size="small"
            column={3}
            style={{ marginBottom: 8 }}
            items={[
              {
                key: 'advisor',
                label: '主责顾问',
                children: detail.advisor
                  ? `${detail.advisor.name}${detail.advisor.online ? '（在线）' : ''}`
                  : '未分配',
              },
              {
                key: 'groups',
                label: '服务群',
                children:
                  detail.groups.length > 0
                    ? detail.groups.map((group) => group.name).join('、')
                    : '未绑定',
              },
              {
                key: 'lastActive',
                label: '最近互动',
                children: formatDateTime(detail.patient.lastActiveAt),
              },
            ]}
          />

          <Tabs
            items={[
              {
                key: 'memories',
                label: '记忆',
                children: (
                  <MemoriesTab patientId={detail.patient.id} canWrite={can('patient.write')} onChanged={reload} />
                ),
              },
              {
                key: 'plans',
                label: '主动计划',
                children: (
                  <CarePlansTab patientId={detail.patient.id} canWrite={can('patient.write')} onChanged={reload} />
                ),
              },
              {
                key: 'actions',
                label: '办事记录',
                children: <ActionsTab patientId={detail.patient.id} />,
              },
              {
                key: 'timeline',
                label: '对话时间线',
                children: <TimelineTab patientId={detail.patient.id} />,
              },
              {
                key: 'diet',
                label: '饮食记录',
                children: <DietTab patientId={detail.patient.id} />,
              },
              {
                key: 'profile',
                label: '基本信息',
                children: (
                  <ProfileTab
                    detail={detail}
                    term={term}
                    canWrite={can('patient.write')}
                    onSaved={reload}
                  />
                ),
              },
              {
                key: 'health',
                label: '健康档案',
                children: <HealthProfileTab patientId={detail.patient.id} term={term} />,
              },
              {
                key: 'service-plan',
                label: '服务计划',
                children: <ServicePlanTab patientId={detail.patient.id} term={term} />,
              },
            ]}
          />
        </>
      )}
    </Drawer>

    <Modal
      open={exportOpen}
      title="导出服务记录 PDF"
      okText="导出"
      cancelText="取消"
      confirmLoading={exporting}
      onOk={() => void submitExport()}
      onCancel={() => setExportOpen(false)}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <span>选择时间范围（默认最近 30 天）；导出的记录包含草稿正文、核验结果与操作人。</span>
        <DatePicker.RangePicker
          allowClear={false}
          value={exportRange}
          onChange={(value) => {
            if (value?.[0] && value[1]) setExportRange([value[0], value[1]]);
          }}
        />
        {isMockMode ? (
          <Alert type="info" showIcon message="演示模式不生成 PDF" description={MOCK_EXPORT_NOTICE} />
        ) : null}
      </Space>
    </Modal>
    </>
  );
}
