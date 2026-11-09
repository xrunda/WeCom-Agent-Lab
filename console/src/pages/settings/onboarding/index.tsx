import {
  ArrowRightOutlined,
  CalculatorOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  FileProtectOutlined,
  SendOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Divider,
  Form,
  Input,
  InputNumber,
  Space,
  Spin,
  Steps,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../../../auth/AuthContext.tsx';
import { updateTenant } from '../../../mock/api.ts';
import { getDashboardKpis, getDashboardValue } from '../../../mock/dashboard.ts';
import { getOnboardingInfo, submitOnboardingRequest } from '../../../mock/onboarding.ts';
import type {
  DashboardValue,
  OnboardingInfo,
  OnboardingRequest,
  OnboardingRequestInput,
} from '../../../types.ts';
import { formatDateTime } from '../../../utils/format.ts';
import '../settings.css';
import './onboarding.css';

const { Paragraph, Text, Title } = Typography;

const OWNER_LABEL: Record<OnboardingInfo['prerequisites'][number]['owner'], string> = {
  customer: '机构完成',
  both: '双方配合',
};

interface ApplyFormValues {
  contactName: string;
  contactPhone: string;
  contactTitle?: string;
  expectedAdvisors: number;
  expectedPatients: number;
  note?: string;
  consentToContact: boolean;
}

export default function OnboardingSettingsPage() {
  const { message } = App.useApp();
  const { can } = useAuth();
  const canApply = can('onboarding.write');
  const canConfigurePrice = can('setting.write');

  const [info, setInfo] = useState<OnboardingInfo | null>(null);
  const [monthValue, setMonthValue] = useState<DashboardValue | null>(null);
  const [onlineAgents, setOnlineAgents] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [advisors, setAdvisors] = useState(5);
  const [patients, setPatients] = useState(200);
  const [price, setPrice] = useState<number>(900);
  const [savingPrice, setSavingPrice] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [submitted, setSubmitted] = useState<OnboardingRequest | null>(null);
  const [form] = Form.useForm<ApplyFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextInfo, value, kpis] = await Promise.all([
        getOnboardingInfo(),
        getDashboardValue('month'),
        getDashboardKpis('month'),
      ]);
      setInfo(nextInfo);
      setPrice(nextInfo.pricing.archiveSeatPriceYuan);
      setMonthValue(value);
      setOnlineAgents(kpis.onlineAgents);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '开通信息加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const archiveFee = useMemo(() => advisors * price, [advisors, price]);

  const savedHoursPerYear = useMemo(() => {
    if (!monthValue || !onlineAgents || onlineAgents <= 0) return null;
    const perAdvisorMonth = monthValue.savedMinutes / onlineAgents;
    return (perAdvisorMonth * advisors * 12) / 60;
  }, [monthValue, onlineAgents, advisors]);

  const savePrice = async () => {
    if (!price || price < 1 || price > 100000 || !Number.isInteger(price)) return;
    setSavingPrice(true);
    try {
      await updateTenant({ settings: { archiveSeatPriceYuan: price } });
      message.success('会话存档单价已更新');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSavingPrice(false);
    }
  };

  const submit = async (values: ApplyFormValues) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    const input: OnboardingRequestInput = {
      contactName: values.contactName,
      contactPhone: values.contactPhone,
      contactTitle: values.contactTitle,
      expectedAdvisors: values.expectedAdvisors,
      expectedPatients: values.expectedPatients,
      note: values.note,
      consentToContact: values.consentToContact,
    };
    setSubmitting(true);
    try {
      const request = await submitOnboardingRequest(input);
      setSubmitted(request);
      message.success('申请已提交，我方负责人会在 1 个工作日内联系');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '提交失败，请稍后重试');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (loading && !info) {
    return (
      <div className="app-loading" style={{ minHeight: 360 }}>
        <Spin />
        <div className="zb-muted" style={{ marginTop: 12 }}>正在加载开通信息…</div>
      </div>
    );
  }

  if (!info) {
    return (
      <PageContainer header={{ title: '开通正式服务' }}>
        <Alert type="error" showIcon message="开通信息加载失败" description="请刷新页面重试。" />
      </PageContainer>
    );
  }

  return (
    <PageContainer
      header={{
        title: '开通正式服务',
        subTitle: '接入机构自有企微的前置条件、时间线与席位成本；材料齐全后约 3–5 个工作日。',
      }}
    >
      <div className="onboarding-layout">
        <div className="onboarding-main">
          <Card className="zb-card" variant="borderless" title="前置条件清单">
            <Paragraph type="secondary" className="onboarding-card-hint">
              以下六项需要机构与我方配合完成；标注所需材料，便于提前准备。
            </Paragraph>
            <ul className="onboarding-prereqs">
              {info.prerequisites.map((item) => (
                <li key={item.id} className="onboarding-prereq">
                  <span className="onboarding-prereq-icon">
                    <CheckCircleOutlined />
                  </span>
                  <div className="onboarding-prereq-main">
                    <div className="onboarding-prereq-head">
                      <Text strong>{item.title}</Text>
                      <Tag color={item.owner === 'both' ? 'blue' : 'default'} bordered={false}>
                        {OWNER_LABEL[item.owner]}
                      </Tag>
                      <Tag bordered={false}>
                        <ClockCircleOutlined /> {item.days > 0 ? `约 ${item.days} 天` : '当天'}
                      </Tag>
                    </div>
                    {item.materials.length > 0 ? (
                      <div className="onboarding-materials">
                        所需材料：
                        {item.materials.map((material) => (
                          <Tag key={material} bordered={false} color="cyan">
                            {material}
                          </Tag>
                        ))}
                      </div>
                    ) : (
                      <div className="onboarding-materials">无需额外材料</div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="zb-card" variant="borderless" title="整体时间线">
            <Steps
              current={1}
              items={[
                { title: '材料准备', description: '营业执照、顾问名单、企微管理员账号' },
                { title: '配置联调', description: '会话存档、自建应用、可信 IP' },
                { title: '上线走查', description: info.timeline.summary },
              ]}
            />
            <Paragraph type="secondary" className="onboarding-card-hint">
              时间取决于企微主体认证与会话存档购买进度；配置联调约需 1–2 个工作日。
            </Paragraph>
          </Card>

          <Card
            className="zb-card"
            variant="borderless"
            title={
              <Space>
                <CalculatorOutlined />
                席位成本计算器
              </Space>
            }
          >
            <div className="onboarding-calc">
              <div className="onboarding-calc-inputs">
                <label className="onboarding-field">
                  <span>顾问人数</span>
                  <InputNumber
                    min={1}
                    max={1000}
                    value={advisors}
                    onChange={(next) => setAdvisors(Math.round(next ?? 1))}
                    precision={0}
                    suffix="人"
                    style={{ width: 180 }}
                  />
                </label>
                <label className="onboarding-field">
                  <span>预计服务人数</span>
                  <InputNumber
                    min={1}
                    max={1000000}
                    value={patients}
                    onChange={(next) => setPatients(Math.round(next ?? 1))}
                    precision={0}
                    suffix="人"
                    style={{ width: 200 }}
                  />
                </label>
                <label className="onboarding-field">
                  <span>会话存档单价</span>
                  <Space.Compact>
                    <InputNumber
                      min={1}
                      max={100000}
                      value={price}
                      disabled={!canConfigurePrice}
                      onChange={(next) => setPrice(Math.round(next ?? 1))}
                      precision={0}
                      suffix="元/人/年"
                      style={{ width: 210 }}
                    />
                    {canConfigurePrice ? (
                      <Button loading={savingPrice} onClick={() => void savePrice()}>
                        保存
                      </Button>
                    ) : null}
                  </Space.Compact>
                </label>
              </div>

              <div className="onboarding-calc-results">
                <div className="onboarding-result">
                  <span className="onboarding-result-label">会话存档年费</span>
                  <span className="onboarding-result-value">
                    ¥{archiveFee.toLocaleString('zh-CN')}
                  </span>
                  <span className="onboarding-result-hint">按 {advisors} 人计</span>
                </div>
                <div className="onboarding-result">
                  <span className="onboarding-result-label">平台服务费</span>
                  <span className="onboarding-result-value onboarding-result-text">
                    {info.pricing.platformFeeText}
                  </span>
                  <span className="onboarding-result-hint">不含会话存档费</span>
                </div>
                <div className="onboarding-result">
                  <span className="onboarding-result-label">年节省时长</span>
                  <span className="onboarding-result-value onboarding-result-time">
                    {savedHoursPerYear == null ? '—' : `≈ ${Math.round(savedHoursPerYear)}`}
                  </span>
                  <span className="onboarding-result-hint">
                    {savedHoursPerYear == null
                      ? '暂无足够数据'
                      : '小时/年 · 按当前人均月节省口径外推'}
                  </span>
                </div>
              </div>
            </div>
            <Paragraph type="secondary" className="onboarding-card-hint">
              会话存档年费为实际采购价；平台服务费按方案报价，页面不展示固定金额。预计服务人数用于后续方案沟通，
              不影响存档年费。
            </Paragraph>
          </Card>
        </div>

        <aside className="onboarding-aside">
          <Card className="zb-card onboarding-apply" variant="borderless" title="申请开通">
            {submitted ? (
              <div className="onboarding-success">
                <CheckCircleOutlined className="onboarding-success-icon" />
                <Title level={5} style={{ margin: '8px 0 4px' }}>
                  申请已提交
                </Title>
                <Paragraph type="secondary" style={{ marginBottom: 8 }}>
                  申请编号 {submitted.id}，提交于 {formatDateTime(submitted.createdAt)}。
                  我方负责人会在 1 个工作日内联系，请保持电话畅通。
                </Paragraph>
                <Button onClick={() => setSubmitted(null)}>再提交一份</Button>
              </div>
            ) : (
              <>
                {!canApply ? (
                  <Alert
                    type="info"
                    showIcon
                    message="只读账号可浏览，提交需主管或管理员"
                    style={{ marginBottom: 16 }}
                  />
                ) : null}
                <Form<ApplyFormValues>
                  form={form}
                  layout="vertical"
                  requiredMark={false}
                  disabled={!canApply}
                  initialValues={{
                    expectedAdvisors: advisors,
                    expectedPatients: patients,
                  }}
                  onFinish={(values) => void submit(values)}
                >
                  <Form.Item
                    label="联系人"
                    name="contactName"
                    rules={[{ required: true, message: '请填写联系人姓名' }]}
                  >
                    <Input placeholder="如：赵经理" maxLength={20} />
                  </Form.Item>
                  <Form.Item
                    label="联系电话 / 企微号"
                    name="contactPhone"
                    rules={[
                      { required: true, message: '请填写联系电话或企微号' },
                      { pattern: /^[0-9+\-\s]{6,20}$/, message: '请填写有效的电话或企微号' },
                    ]}
                  >
                    <Input placeholder="用于我方负责人联系" maxLength={20} />
                  </Form.Item>
                  <Form.Item label="职务" name="contactTitle">
                    <Input placeholder="选填，如：运营负责人" maxLength={20} />
                  </Form.Item>
                  <div className="onboarding-form-row">
                    <Form.Item
                      label="预计顾问人数"
                      name="expectedAdvisors"
                      rules={[{ required: true, message: '请填写预计顾问人数' }]}
                    >
                      <InputNumber min={1} max={1000} precision={0} suffix="人" style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item
                      label="预计服务人数"
                      name="expectedPatients"
                      rules={[{ required: true, message: '请填写预计服务人数' }]}
                    >
                      <InputNumber min={1} max={1000000} precision={0} suffix="人" style={{ width: '100%' }} />
                    </Form.Item>
                  </div>
                  <Form.Item label="备注" name="note">
                    <Input.TextArea
                      rows={3}
                      maxLength={200}
                      showCount
                      placeholder="选填，如期望上线时间、特殊需求"
                    />
                  </Form.Item>
                  <Form.Item
                    name="consentToContact"
                    valuePropName="checked"
                    rules={[
                      {
                        validator: (_, value) =>
                          value
                            ? Promise.resolve()
                            : Promise.reject(new Error('需同意我方联系后才能提交')),
                      },
                    ]}
                  >
                    <Checkbox>同意我方就开通事宜联系我</Checkbox>
                  </Form.Item>
                  <Button
                    type="primary"
                    htmlType="submit"
                    block
                    loading={submitting}
                    icon={<SendOutlined />}
                  >
                    提交申请
                  </Button>
                </Form>
                <Divider />
                <Space direction="vertical" size={4} className="onboarding-side-notes">
                  <Text type="secondary">
                    <FileProtectOutlined /> 提交记录会写入审计日志。
                  </Text>
                  <Text type="secondary">
                    <TeamOutlined /> 演示环境不会真实发送企微通知，也不会自动开通企微后台。
                  </Text>
                  <Text type="secondary">
                    <ArrowRightOutlined /> 开通后可回到本页查看进度。
                  </Text>
                </Space>
              </>
            )}
          </Card>
        </aside>
      </div>
    </PageContainer>
  );
}
