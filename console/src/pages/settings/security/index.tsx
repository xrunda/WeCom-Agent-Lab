import {
  AuditOutlined,
  CloudServerOutlined,
  DownloadOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { isMockMode } from '../../../mock/http.ts';
import { MOCK_SECURITY_NOTICE, getSecurityOverview } from '../../../mock/security.ts';
import type { SecurityOverview } from '../../../types.ts';
import { formatDateTime } from '../../../utils/format.ts';
import { ROLE_META, roleCapabilities } from '../../../utils/permissions.ts';
import '../settings.css';
import '../../wp-l.css';

const { Text } = Typography;

const CONSENT_META = [
  { key: 'agreed', label: '已同意存档', color: '#16a34a' },
  { key: 'unknown', label: '存档待确认', color: '#d97706' },
  { key: 'disagreed', label: '不同意存档', color: '#dc2626' },
] as const;

export default function SecuritySettingsPage() {
  const { message } = App.useApp();
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await getSecurityOverview());
    } catch (error) {
      message.error(error instanceof Error ? error.message : '数据与安全信息加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <PageContainer
      header={{
        title: '数据与安全',
        subTitle: '数据存放、模型服务、传输、留存、访问角色、审计与患者存档同意状态。',
        extra: [
          <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>,
        ],
      }}
    >
      {loading && !overview ? (
        <div className="app-loading" style={{ minHeight: 260 }}>
          <Spin />
          <div className="zb-muted" style={{ marginTop: 12 }}>
            正在读取当前部署口径…
          </div>
        </div>
      ) : overview ? (
        <div className="settings-stack">
          {isMockMode ? (
            <Alert type="info" showIcon message="演示模式" description={MOCK_SECURITY_NOTICE} />
          ) : null}

          <Row gutter={[16, 16]}>
            <Col xs={24} lg={14}>
              <Card
                className="zb-card"
                variant="borderless"
                title={
                  <Space>
                    <CloudServerOutlined />
                    部署事实
                  </Space>
                }
              >
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  <div>
                    <Text type="secondary">数据存放区域</Text>
                    <div>{overview.deployment.dataRegion}</div>
                  </div>
                  <div>
                    <Text type="secondary">模型服务</Text>
                    <div>
                      {overview.deployment.modelService}
                      <Text type="secondary">（运行区域：{overview.deployment.modelRegion}）</Text>
                    </div>
                  </div>
                  <div>
                    <Text type="secondary">传输加密</Text>
                    <div>{overview.deployment.transport}</div>
                  </div>
                  <div>
                    <Text type="secondary">数据存储</Text>
                    <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                      {overview.deployment.dataStores.map((store) => (
                        <li key={store}>{store}</li>
                      ))}
                    </ul>
                  </div>
                </Space>
              </Card>
            </Col>
            <Col xs={24} lg={10}>
              <Card
                className="zb-card"
                variant="borderless"
                title={
                  <Space>
                    <SafetyCertificateOutlined />
                    数据留存
                  </Space>
                }
                style={{ height: '100%' }}
              >
                <Space direction="vertical" size={12}>
                  <div>
                    <Text type="secondary">留存口径</Text>
                    <div>{overview.retention.notice}</div>
                  </div>
                  <Tag color={overview.retention.autoDelete ? 'green' : 'gold'} bordered={false}>
                    {overview.retention.autoDelete ? '按配置自动删除' : '当前不自动删除'}
                  </Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    会话存档原文与图片由企微会话存档保管；控制台只读取与核验，不另行复制消息正文。
                  </Text>
                </Space>
              </Card>
            </Col>
          </Row>

          <Row gutter={[16, 16]}>
            <Col xs={24} lg={14}>
              <Card
                className="zb-card"
                variant="borderless"
                title={
                  <Space>
                    <TeamOutlined />
                    患者存档同意
                  </Space>
                }
                extra={<Text type="secondary">按患者档案实时统计</Text>}
              >
                {overview.consent ? (
                  <Row gutter={16}>
                    {CONSENT_META.map((item) => (
                      <Col span={6} key={item.key}>
                        <Statistic
                          title={item.label}
                          value={overview.consent![item.key]}
                          valueStyle={{ color: item.color, fontSize: 22 }}
                        />
                      </Col>
                    ))}
                    <Col span={6}>
                      <Statistic
                        title="合计"
                        value={overview.consent.total}
                        valueStyle={{ fontSize: 22 }}
                      />
                    </Col>
                  </Row>
                ) : (
                  <Empty description="患者领域未就绪，暂无同意统计" />
                )}
                <Text type="secondary" style={{ fontSize: 12 }}>
                  未确认同意的患者不进入自动回复；同意状态在患者档案中维护，变更会写入审计。
                </Text>
              </Card>
            </Col>
            <Col xs={24} lg={10}>
              <Card
                className="zb-card"
                variant="borderless"
                title={
                  <Space>
                    <AuditOutlined />
                    审计与导出
                  </Space>
                }
                extra={<Link to="/settings/audit">查看审计日志</Link>}
                style={{ height: '100%' }}
              >
                <Row gutter={16}>
                  <Col span={12}>
                    <Statistic title="近 30 天事件" value={overview.audit.events30d} />
                  </Col>
                  <Col span={12}>
                    <Statistic title="近 30 天导出" value={overview.audit.exports30d} />
                  </Col>
                </Row>
                <div style={{ marginTop: 12 }}>
                  <Text type="secondary">最近一次导出：</Text>
                  {overview.audit.lastExportAt ? formatDateTime(overview.audit.lastExportAt) : '暂无'}
                </div>
              </Card>
            </Col>
          </Row>

          <Card
            className="zb-card"
            variant="borderless"
            title={
              <Space>
                <UserSwitchOutlined />
                访问角色
              </Space>
            }
            extra={<Link to="/settings/accounts">账号与权限矩阵</Link>}
          >
            <Table
              rowKey="role"
              size="small"
              pagination={false}
              dataSource={overview.access.roles}
              columns={[
                {
                  title: '角色',
                  dataIndex: 'role',
                  width: 160,
                  render: (role: keyof typeof ROLE_META, record) => (
                    <Tag color={ROLE_META[role]?.color ?? 'default'} bordered={false}>
                      {record.label || ROLE_META[role]?.label || role}
                    </Tag>
                  ),
                },
                {
                  title: '可执行操作',
                  dataIndex: 'permissions',
                  render: (permissions: string[]) => {
                    const capabilities = roleCapabilities(permissions);
                    if (!capabilities) return <Tag color="green">全部权限</Tag>;
                    return (
                      <Space wrap size={[4, 4]}>
                        {capabilities.slice(0, 8).map((label) => (
                          <Tag key={label} bordered={false}>
                            {label}
                          </Tag>
                        ))}
                        {capabilities.length > 8 ? (
                          <Tag bordered={false} color="blue">
                            +{capabilities.length - 8}
                          </Tag>
                        ) : null}
                      </Space>
                    );
                  },
                },
              ]}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              只读角色可查看本页与审计日志，但不能导出证据链或服务记录。
            </Text>
          </Card>

          <Card
            className="zb-card"
            variant="borderless"
            title={
              <Space>
                <DownloadOutlined />
                证据链与服务记录导出
              </Space>
            }
          >
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Text>
                证据链 PDF：服务流 → 打开草稿详情 →「导出证据链」。包含客户原话与图片、全部草稿版本、实发正文、
                存档 msgid 与时间、核验结果、操作人，页脚标注导出人与生成时间。
              </Text>
              <Text>
                服务记录 PDF：患者 Agent →「导出服务记录」，可按时间范围导出该患者的服务记录。
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                每次导出都会写入审计（evidence.export / records.export），只读角色会被拒绝。
              </Text>
              {isMockMode ? (
                <Alert
                  type="warning"
                  showIcon
                  message="演示模式不生成 PDF"
                  description={MOCK_SECURITY_NOTICE}
                />
              ) : overview.pdf.fontConfigured ? (
                <Alert type="success" showIcon message="服务端已配置中文字体，可生成 PDF" />
              ) : (
                <Alert
                  type="error"
                  showIcon
                  message="服务端缺少中文字体，导出会失败"
                  description="请在部署机安装 fonts-noto-cjk，或配置 zhiban-console 的 pdf.fontPath / pdf.fontFamily。"
                />
              )}
            </Space>
          </Card>
        </div>
      ) : null}
    </PageContainer>
  );
}
