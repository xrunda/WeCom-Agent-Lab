import {
  DeleteOutlined,
  EditOutlined,
  MedicineBoxOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Col,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { formatDateTime } from '../../../utils/format.ts';
import {
  CHRONIC_CONDITION_PRESETS,
  CHRONIC_METRICS,
  CHRONIC_SOURCE_LABELS,
  chronicMetricSpec,
  formatChronicValue,
  getChronicProfile,
  updateChronicProfile,
  type ChronicMeasurement,
  type ChronicMeasurementInput,
  type ChronicMedicationInput,
  type ChronicMetric,
  type ChronicProfile,
  type ChronicSource,
} from '../../../mock/patients.ts';

const { Paragraph, Text } = Typography;

const METRIC_OPTIONS = (Object.keys(CHRONIC_METRICS) as ChronicMetric[]).map((key) => ({
  value: key,
  label: CHRONIC_METRICS[key].label,
}));

const SOURCE_COLOR: Record<ChronicSource, string> = {
  advisor: 'green',
  agent: 'blue',
};

interface MeasurementFormValues {
  metric: ChronicMetric;
  value: number;
  secondaryValue?: number;
  context?: string;
  measuredAt: Dayjs;
}

interface ProfileFormValues {
  conditions: string[];
  heightCm?: number | null;
  weightKg?: number | null;
  medications: ChronicMedicationInput[];
  notes?: string;
}

export interface HealthProfileTabProps {
  patientId: string;
  term: string;
  canWrite: boolean;
}

export function HealthProfileTab({ patientId, term, canWrite }: HealthProfileTabProps) {
  const { message } = App.useApp();
  const [profile, setProfile] = useState<ChronicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [measurementForm] = Form.useForm<MeasurementFormValues>();
  const [profileForm] = Form.useForm<ProfileFormValues>();
  const metric = Form.useWatch('metric', measurementForm);
  const metricSpec = metric ? chronicMetricSpec(metric) : undefined;

  const load = useCallback(
    (silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      getChronicProfile(patientId)
        .then(setProfile)
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : '加载失败');
        })
        .finally(() => setLoading(false));
    },
    [patientId],
  );

  useEffect(() => {
    load();
  }, [load]);

  // 抽屉打开期间静默刷新，Agent 从对话中提取的体征能及时出现
  useEffect(() => {
    const timer = setInterval(() => load(true), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const latest = useMemo(() => {
    if (!profile) return [];
    const seen = new Set<ChronicMetric>();
    return profile.measurements.filter((item) => {
      if (seen.has(item.metric)) return false;
      seen.add(item.metric);
      return true;
    });
  }, [profile]);

  const saveMeasurement = async () => {
    const values = await measurementForm.validateFields();
    setSaving(true);
    try {
      const input: ChronicMeasurementInput = {
        metric: values.metric,
        value: values.value,
        ...(values.secondaryValue !== undefined ? { secondaryValue: values.secondaryValue } : {}),
        ...(values.context ? { context: values.context } : {}),
        ...(values.measuredAt ? { measuredAt: values.measuredAt.valueOf() } : {}),
      };
      const next = await updateChronicProfile(patientId, { measurements: [input] });
      setProfile(next);
      setRecordOpen(false);
      measurementForm.resetFields();
      message.success('体征已记录');
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const saveProfile = async () => {
    const values = await profileForm.validateFields();
    setSaving(true);
    try {
      const next = await updateChronicProfile(patientId, {
        conditions: values.conditions ?? [],
        heightCm: values.heightCm ?? null,
        weightKg: values.weightKg ?? null,
        medications: (values.medications ?? []).filter((item) => item?.name?.trim()),
        notes: values.notes?.trim() ? values.notes.trim() : null,
      });
      setProfile(next);
      setProfileOpen(false);
      message.success('慢病档案已更新');
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center' }}>
        <Spin tip="正在加载慢病管理…" />
      </div>
    );
  }

  if (error || !profile) {
    return <Alert type="error" showIcon message={error ?? '暂无慢病管理数据'} />;
  }

  const bmi =
    profile.heightCm && profile.weightKg
      ? Number((profile.weightKg / (profile.heightCm / 100) ** 2).toFixed(1))
      : undefined;

  const columns = [
    {
      title: '指标',
      dataIndex: 'metric',
      width: 130,
      render: (value: ChronicMetric, record: ChronicMeasurement) => (
        <Space size={4}>
          <span>{chronicMetricSpec(value).label}</span>
          {record.context ? <Text type="secondary">（{record.context}）</Text> : null}
        </Space>
      ),
    },
    {
      title: '数值',
      dataIndex: 'value',
      width: 150,
      render: (_: unknown, record: ChronicMeasurement) => (
        <Text strong className="zb-num">
          {formatChronicValue(record)}
        </Text>
      ),
    },
    {
      title: '测量时间',
      dataIndex: 'measuredAt',
      width: 150,
      render: (value: number) => formatDateTime(value),
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 130,
      render: (value: ChronicSource, record: ChronicMeasurement) => (
        <Space size={4}>
          <Tag bordered={false} color={SOURCE_COLOR[value]}>
            {CHRONIC_SOURCE_LABELS[value]}
          </Tag>
          {record.recordedBy ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {record.recordedBy}
            </Text>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="zb-panel">
        <div className="zb-panel-head">
          <h3 className="zb-panel-title">
            慢病概览
            <span className="zb-panel-count">{profile.conditions.length} 个标签</span>
          </h3>
          <div className="zb-panel-extra">
            <Button size="small" icon={<ReloadOutlined />} onClick={() => load(true)}>
              刷新
            </Button>
            {canWrite ? (
              <Button size="small" icon={<EditOutlined />} onClick={() => setProfileOpen(true)}>
                编辑档案
              </Button>
            ) : null}
          </div>
        </div>
        <div className="zb-panel-body">
          <Descriptions
            size="small"
            column={3}
            colon={false}
            items={[
              {
                key: 'conditions',
                label: '慢病 / 合并症',
                span: 3,
                children:
                  profile.conditions.length > 0 ? (
                    <Space size={[4, 4]} wrap>
                      {profile.conditions.map((item) => (
                        <Tag key={item} color="volcano" bordered={false}>
                          {item}
                        </Tag>
                      ))}
                    </Space>
                  ) : (
                    <Text type="secondary">未登记；可在「编辑档案」中从常见慢病中选择</Text>
                  ),
              },
              {
                key: 'height',
                label: '身高',
                children: profile.heightCm ? `${profile.heightCm} cm` : '—',
              },
              {
                key: 'weight',
                label: '体重',
                children: profile.weightKg ? `${profile.weightKg} kg` : '—',
              },
              {
                key: 'bmi',
                label: 'BMI',
                children: bmi !== undefined ? bmi.toFixed(1) : '—',
              },
              {
                key: 'updatedAt',
                label: '最近更新',
                children: profile.updatedAt ? formatDateTime(profile.updatedAt) : '—',
              },
              {
                key: 'updatedBy',
                label: '更新人',
                children: profile.updatedBy ?? '—',
              },
              {
                key: 'sourceHint',
                label: '数据来源',
                children: (
                  <Text type="secondary">顾问手工录入 / Agent 从对话中提取</Text>
                ),
              },
            ]}
          />
        </div>
      </div>

      <div className="zb-panel">
        <div className="zb-panel-head">
          <h3 className="zb-panel-title">
            最新体征
            <span className="zb-panel-count">{latest.length} 项</span>
          </h3>
          {canWrite ? (
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setRecordOpen(true)}
            >
              录入体征
            </Button>
          ) : null}
        </div>
        <div className="zb-panel-body">
          {latest.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={`暂无体征记录${canWrite ? '，可手动录入或等 Agent 从对话中提取' : ''}`}
            />
          ) : (
            <Row gutter={[12, 12]}>
              {latest.map((item) => (
                <Col key={item.metric} xs={24} sm={12} lg={8} xl={6}>
                  <div className="chronic-metric-card">
                    <div className="chronic-metric-label">
                      {chronicMetricSpec(item.metric).label}
                      {item.context ? <span className="chronic-metric-context">{item.context}</span> : null}
                    </div>
                    <div className="chronic-metric-value zb-num">{formatChronicValue(item)}</div>
                    <div className="chronic-metric-meta">
                      {formatDateTime(item.measuredAt)}
                      <Tag bordered={false} color={SOURCE_COLOR[item.source]} style={{ marginLeft: 6 }}>
                        {CHRONIC_SOURCE_LABELS[item.source]}
                      </Tag>
                    </div>
                  </div>
                </Col>
              ))}
            </Row>
          )}
        </div>
      </div>

      <div className="zb-panel zb-panel-flush">
        <div className="zb-panel-head">
          <h3 className="zb-panel-title">
            体征记录
            <span className="zb-panel-count">{profile.measurements.length} 条</span>
          </h3>
        </div>
        <Table
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={profile.measurements.slice(0, 50)}
          pagination={profile.measurements.length > 50 ? { pageSize: 10, size: 'small' } : false}
          locale={{ emptyText: '暂无体征记录' }}
        />
      </div>

      <div className="zb-panel">
        <div className="zb-panel-head">
          <h3 className="zb-panel-title">
            用药
            <span className="zb-panel-count">{profile.medications.length} 条</span>
          </h3>
        </div>
        <div className="zb-panel-body">
          {profile.medications.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无用药记录" />
          ) : (
            <List
              size="small"
              dataSource={profile.medications}
              renderItem={(item) => (
                <List.Item>
                  <List.Item.Meta
                    avatar={<MedicineBoxOutlined style={{ fontSize: 18, color: '#0f766e' }} />}
                    title={
                      <Space size={8} wrap>
                        <span>{item.name}</span>
                        {item.dose ? <Tag bordered={false}>{item.dose}</Tag> : null}
                        {item.frequency ? <Tag bordered={false}>{item.frequency}</Tag> : null}
                      </Space>
                    }
                    description={
                      <Space direction="vertical" size={2}>
                        {item.note ? <Text type="secondary">{item.note}</Text> : null}
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {CHRONIC_SOURCE_LABELS[item.source]} · {formatDateTime(item.updatedAt)}
                          {item.updatedBy ? ` · ${item.updatedBy}` : ''}
                        </Text>
                      </Space>
                    }
                  />
                </List.Item>
              )}
            />
          )}
        </div>
      </div>

      {profile.notes ? (
        <div className="zb-panel">
          <div className="zb-panel-head">
            <h3 className="zb-panel-title">备注</h3>
          </div>
          <div className="zb-panel-body">
            <Paragraph style={{ marginBottom: 0 }}>{profile.notes}</Paragraph>
          </div>
        </div>
      ) : null}

      <Alert
        type="info"
        showIcon
        message="慢病管理只记录、不诊断"
        description={`这里保存顾问手工录入或 Agent 从${term}对话中明确说出的体征、慢病标签与用药，不替代病历和医嘱；报告图片里的数值请顾问核对后再录入。`}
      />

      <Modal
        title="录入体征"
        open={recordOpen}
        onCancel={() => setRecordOpen(false)}
        onOk={() => void saveMeasurement()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        destroyOnHidden
        afterOpenChange={(open) => {
          if (!open) return;
          measurementForm.resetFields();
          measurementForm.setFieldsValue({ metric: 'bp', measuredAt: dayjs() });
        }}
      >
        <Form form={measurementForm} layout="vertical" requiredMark={false}>
          <Form.Item name="metric" label="指标" rules={[{ required: true, message: '请选择指标' }]}>
            <Select
              options={METRIC_OPTIONS}
              onChange={() => measurementForm.setFieldsValue({ value: undefined, secondaryValue: undefined, context: undefined })}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={metricSpec?.dual ? 12 : 24}>
              <Form.Item
                name="value"
                label={metricSpec?.dual ? '收缩压' : metricSpec?.label ?? '数值'}
                rules={[{ required: true, message: '请填写数值' }]}
              >
                <InputNumber
                  style={{ width: '100%' }}
                  min={metricSpec?.min}
                  max={metricSpec?.max}
                  precision={metricSpec?.dual ? 0 : 1}
                  suffix={metricSpec?.unit}
                />
              </Form.Item>
            </Col>
            {metricSpec?.dual ? (
              <Col span={12}>
                <Form.Item
                  name="secondaryValue"
                  label={metricSpec.dual.label}
                  rules={[{ required: true, message: '请填写舒张压' }]}
                >
                  <InputNumber
                    style={{ width: '100%' }}
                    min={metricSpec.dual.min}
                    max={metricSpec.dual.max}
                    precision={0}
                    suffix="mmHg"
                  />
                </Form.Item>
              </Col>
            ) : null}
          </Row>
          {metricSpec?.contexts ? (
            <Form.Item name="context" label="测量情境">
              <Select
                allowClear
                placeholder="如：空腹"
                options={metricSpec.contexts.map((item) => ({ value: item, label: item }))}
              />
            </Form.Item>
          ) : null}
          <Form.Item
            name="measuredAt"
            label="测量时间"
            rules={[{ required: true, message: '请选择测量时间' }]}
          >
            <DatePicker
              showTime
              style={{ width: '100%' }}
              disabledDate={(current) => current.isAfter(dayjs(), 'day')}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="编辑慢病档案"
        open={profileOpen}
        onCancel={() => setProfileOpen(false)}
        onOk={() => void saveProfile()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        width={640}
        destroyOnHidden
        afterOpenChange={(open) => {
          if (!open || !profile) return;
          profileForm.resetFields();
          profileForm.setFieldsValue({
            conditions: profile.conditions,
            heightCm: profile.heightCm ?? null,
            weightKg: profile.weightKg ?? null,
            medications: profile.medications.map((item) => ({
              name: item.name,
              dose: item.dose,
              frequency: item.frequency,
              note: item.note,
            })),
            notes: profile.notes,
          });
        }}
      >
        <Form form={profileForm} layout="vertical" requiredMark={false}>
          <Form.Item
            name="conditions"
            label="慢病 / 合并症"
            extra="可直接输入其他诊断；留空表示未登记"
          >
            <Select
              mode="tags"
              placeholder="选择常见慢病，或输入其他诊断后回车"
              options={CHRONIC_CONDITION_PRESETS.map((item) => ({ value: item, label: item }))}
              maxTagCount="responsive"
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="heightCm" label="身高（cm）">
                <InputNumber style={{ width: '100%' }} min={80} max={250} precision={0} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="weightKg" label="体重（kg）">
                <InputNumber style={{ width: '100%' }} min={20} max={250} precision={1} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="用药">
            <Form.List name="medications">
              {(fields, { add, remove }) => (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {fields.map((field) => (
                    <Row gutter={8} key={field.key} align="top">
                      <Col span={8}>
                        <Form.Item
                          name={[field.name, 'name']}
                          rules={[{ required: true, message: '药品名不能为空' }]}
                          style={{ marginBottom: 0 }}
                        >
                          <Input placeholder="药品名，如：氨氯地平" aria-label="药品名" />
                        </Form.Item>
                      </Col>
                      <Col span={5}>
                        <Form.Item name={[field.name, 'dose']} style={{ marginBottom: 0 }}>
                          <Input placeholder="剂量" aria-label="剂量" />
                        </Form.Item>
                      </Col>
                      <Col span={6}>
                        <Form.Item name={[field.name, 'frequency']} style={{ marginBottom: 0 }}>
                          <Input placeholder="频次，如：每日一次" aria-label="频次" />
                        </Form.Item>
                      </Col>
                      <Col span={5}>
                        <Button
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          aria-label="删除这条用药"
                          onClick={() => remove(field.name)}
                        />
                      </Col>
                    </Row>
                  ))}
                  <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({})}>
                    添加用药
                  </Button>
                </Space>
              )}
            </Form.List>
          </Form.Item>
          <Form.Item name="notes" label="备注">
            <Input.TextArea
              rows={3}
              maxLength={500}
              showCount
              placeholder="如：近两周晨起血压偏高；对某类药物不耐受"
            />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
