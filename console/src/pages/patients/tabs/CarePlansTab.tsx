import { ClockCircleOutlined, PlusOutlined } from '@ant-design/icons';
import {
  App,
  Button,
  DatePicker,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useCallback, useEffect, useState } from 'react';

import { formatDateTime } from '../../../utils/format.ts';
import {
  CARE_PLAN_STATUS_LABELS,
  cancelCarePlan,
  createCarePlan,
  listCarePlans,
  type CarePlan,
  type CarePlanStatus,
} from '../../../mock/patients.ts';

const { Text } = Typography;

type PlanFilter = 'pending' | 'done' | 'all';

export interface CarePlansTabProps {
  patientId: string;
  canWrite: boolean;
  onChanged: () => void;
}

export function CarePlansTab({ patientId, canWrite, onChanged }: CarePlansTabProps) {
  const { message } = App.useApp();
  const [plans, setPlans] = useState<CarePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<PlanFilter>('pending');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<{ title: string; when: Dayjs }>();

  const load = useCallback(() => {
    setLoading(true);
    const status: CarePlanStatus | '' = filter === 'all' ? '' : filter;
    listCarePlans(patientId, status)
      .then(setPlans)
      .catch((error: unknown) => {
        message.error(error instanceof Error ? error.message : '加载计划失败');
      })
      .finally(() => setLoading(false));
  }, [patientId, filter, message]);

  useEffect(() => {
    load();
  }, [load]);

  const submitCreate = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await createCarePlan(patientId, {
        title: values.title,
        when: values.when.valueOf(),
      });
      message.success('计划已创建');
      setCreating(false);
      form.resetFields();
      setFilter('pending');
      load();
      onChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '创建失败');
    } finally {
      setSaving(false);
    }
  };

  const cancel = async (plan: CarePlan) => {
    try {
      await cancelCarePlan(plan.id);
      message.success('计划已取消');
      load();
      onChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '取消失败');
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <Radio.Group
          value={filter}
          optionType="button"
          onChange={(event) => setFilter(event.target.value as PlanFilter)}
          options={[
            { label: '待执行', value: 'pending' },
            { label: '已执行', value: 'done' },
            { label: '全部', value: 'all' },
          ]}
        />
        {canWrite ? (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              form.resetFields();
              setCreating(true);
            }}
          >
            新建计划
          </Button>
        ) : null}
      </Space>

      {loading ? (
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <Spin tip="正在加载计划…" />
        </div>
      ) : plans.length === 0 ? (
        <Empty description="没有符合条件的主动计划" />
      ) : (
        <List
          bordered
          dataSource={plans}
          renderItem={(plan) => (
            <List.Item
              actions={
                plan.status === 'pending' && canWrite
                  ? [
                      <Popconfirm
                        key="cancel"
                        title="取消这个计划？"
                        description="取消后 Agent 不会再执行。"
                        okText="取消计划"
                        cancelText="保留"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => void cancel(plan)}
                      >
                        <Button type="link" size="small" danger>
                          取消
                        </Button>
                      </Popconfirm>,
                    ]
                  : undefined
              }
            >
              <List.Item.Meta
                avatar={<ClockCircleOutlined style={{ fontSize: 20, color: '#0f766e' }} />}
                title={
                  <Space size={8} wrap>
                    <Text>{plan.title}</Text>
                    <Tag bordered={false} color={plan.status === 'pending' ? 'processing' : 'default'}>
                      {CARE_PLAN_STATUS_LABELS[plan.status]}
                    </Tag>
                    <Tag bordered={false} color={plan.source === 'agent' ? 'blue' : 'purple'}>
                      {plan.source === 'agent' ? 'Agent 识别' : '手动'}
                    </Tag>
                    {plan.quietHoursShifted ? (
                      <Tag bordered={false} color="gold">
                        已避开安静时段
                      </Tag>
                    ) : null}
                  </Space>
                }
                description={
                  <Text type="secondary">
                    执行时间 {formatDateTime(plan.when)}
                    {plan.lastFiredAt ? ` · 上次执行 ${formatDateTime(plan.lastFiredAt)}` : ''}
                  </Text>
                }
              />
            </List.Item>
          )}
        />
      )}

      <Modal
        title="新建主动计划"
        open={creating}
        onCancel={() => setCreating(false)}
        onOk={() => void submitCreate()}
        okText="创建"
        cancelText="取消"
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            label="计划内容"
            name="title"
            rules={[{ required: true, message: '请填写计划内容' }]}
          >
            <Input placeholder="例如：提醒量血压" maxLength={60} />
          </Form.Item>
          <Form.Item
            label="执行时间"
            name="when"
            rules={[{ required: true, message: '请选择执行时间' }]}
            extra="不能早于当前时间；落在安静时段会自动顺延。"
          >
            <DatePicker
              showTime
              style={{ width: '100%' }}
              disabledDate={(current) => current.isBefore(dayjs().startOf('day'))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
