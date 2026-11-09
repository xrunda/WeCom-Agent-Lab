import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { App, Button, Card, Descriptions, Progress, Space, Spin, Statistic, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { getModelStatus } from '../../../mock/settings.ts';
import type { ModelStatus } from '../../../types.ts';
import { formatDateTime, formatPercent } from '../../../utils/format.ts';
import '../settings.css';
import '../../wp-l.css';

const { Paragraph, Text } = Typography;

export default function ModelSettingsPage() {
  const { message } = App.useApp();
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await getModelStatus());
    } catch (error) {
      message.error(error instanceof Error ? error.message : '模型统计加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !status) {
    return (
      <div className="app-loading" style={{ minHeight: 260 }}>
        <Spin />
        <div className="zb-muted" style={{ marginTop: 12 }}>正在读取模型统计…</div>
      </div>
    );
  }

  if (!status) return null;

  const fallbackRate = status.callsToday > 0 ? status.fallbackCount / status.callsToday : 0;

  return (
    <PageContainer
      header={{
        title: 'AI 模型',
        subTitle: '当前模型、今日调用、平均耗时与降级统计。',
        extra: [
          <Button key="refresh" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>,
        ],
      }}
    >
      <div className="settings-stack">
        <Card className="model-hero" variant="borderless">
          <div>
            <Text type="secondary">当前模型</Text>
            <div className="model-name">
              <ThunderboltOutlined style={{ color: '#0f766e' }} />
              {status.model}
            </div>
            <Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
              <Tag color="green" bordered={false}>
                主模型
              </Tag>{' '}
              由 DSH 模型设置提供；超时 15 秒或出错时回退模板草稿。
            </Paragraph>
          </div>
          <div style={{ textAlign: 'right' }}>
            <Text type="secondary">最近更新</Text>
            <div>{formatDateTime(status.updatedAt)}</div>
          </div>
        </Card>

        <div className="zb-grid zb-grid-4">
          <Card className="zb-card" variant="borderless">
            <Statistic title="今日调用" value={status.callsToday} suffix="次" />
          </Card>
          <Card className="zb-card" variant="borderless">
            <Statistic
              title="平均耗时"
              value={(status.avgLatencyMs / 1000).toFixed(1)}
              suffix="秒"
            />
          </Card>
          <Card className="zb-card" variant="borderless">
            <Statistic
              title="降级次数"
              value={status.fallbackCount}
              suffix="次"
              valueStyle={{ color: status.fallbackCount > 0 ? '#b45309' : '#0f766e' }}
            />
          </Card>
          <Card className="zb-card" variant="borderless">
            <Statistic
              title="今日估算成本"
              value={status.estimatedCostYuanToday}
              precision={2}
              prefix="¥"
            />
          </Card>
        </div>

        <Card className="zb-card" variant="borderless" title="降级比例">
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Progress
              percent={Number((fallbackRate * 100).toFixed(1))}
              strokeColor={fallbackRate > 0.05 ? '#f59e0b' : '#0f766e'}
              trailColor="#eef2f7"
              format={(value) => `${value}%`}
            />
            <Text type="secondary">
              今日调用 {status.callsToday} 次，其中降级 {status.fallbackCount} 次（
              {formatPercent(fallbackRate)}）。降级草稿会标注「模板草稿」并计入统计。
            </Text>
          </Space>
        </Card>

        <Card className="zb-card" variant="borderless" title="口径说明">
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="调用次数">含草稿生成与改稿重写，按今日 0 点起算。</Descriptions.Item>
            <Descriptions.Item label="平均耗时">模型调用从发出到返回的平均时长，不含排队。</Descriptions.Item>
            <Descriptions.Item label="降级次数">模型超时或出错后回退模板草稿的次数。</Descriptions.Item>
            <Descriptions.Item label="估算成本">按当前模型单价与当日调用量估算，仅供演示。</Descriptions.Item>
          </Descriptions>
        </Card>
      </div>
    </PageContainer>
  );
}
