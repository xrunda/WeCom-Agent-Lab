import { CloudServerOutlined, ReloadOutlined, SafetyCertificateOutlined, TeamOutlined, WechatOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, App, Button, Card, Space, Spin, Switch, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { getWecomStatus, setMockBotConnected } from '../../../mock/settings.ts';
import { isMockMode } from '../../../mock/http.ts';
import type { WecomChannelStatus, WecomStatus } from '../../../types.ts';
import { formatDateTime, formatRelative } from '../../../utils/format.ts';
import '../settings.css';
import '../../wp-l.css';

const { Text } = Typography;

const STATUS_LABELS: Record<WecomChannelStatus['status'], { text: string; color: string }> = {
  green: { text: '正常', color: 'green' },
  yellow: { text: '需关注', color: 'gold' },
  red: { text: '异常', color: 'red' },
};

function formatUptime(seconds: number | null): string {
  if (seconds == null) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
  return `${minutes} 分钟`;
}

function StatusCard({
  title,
  icon,
  status,
  message,
  extra,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  status: WecomChannelStatus['status'];
  message: string;
  extra?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className={`wecom-card ${status}`}>
      <div className="wecom-card-head">
        <span className="wecom-card-title">
          <span className={`zb-status-dot ${status}`} />
          {icon}
          {title}
        </span>
        {extra ?? <Tag color={STATUS_LABELS[status].color}>{STATUS_LABELS[status].text}</Tag>}
      </div>
      <div className="wecom-card-message">{message}</div>
      {children ? <div className="wecom-card-meta">{children}</div> : null}
    </div>
  );
}

export default function WecomSettingsPage() {
  const { message: toast } = App.useApp();
  const [status, setStatus] = useState<WecomStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        setStatus(await getWecomStatus());
      } catch (error) {
        if (!silent) {
          toast.error(error instanceof Error ? error.message : '接入状态加载失败');
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const seatStatus: WecomChannelStatus['status'] = (() => {
    if (!status?.seat.expiresAt) return 'yellow';
    const remaining = status.seat.expiresAt - Date.now();
    if (remaining <= 0) return 'red';
    if (remaining < 30 * 86_400_000) return 'yellow';
    return 'green';
  })();

  const hasProblem = status
    ? [status.archive.status, status.bot.status, status.host.status, seatStatus].some(
        (value) => value !== 'green',
      )
    : false;

  return (
    <PageContainer
      header={{
        title: '企微接入状态',
        subTitle: '存档 SDK、机器人长连接、DSH Host 与席位状态；每 15 秒自动刷新。',
        extra: [
          <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void load()}>
            立即刷新
          </Button>,
        ],
      }}
    >
      {loading && !status ? (
        <div className="app-loading" style={{ minHeight: 260 }}>
          <Spin />
          <div className="zb-muted" style={{ marginTop: 12 }}>正在读取接入状态…</div>
        </div>
      ) : status ? (
        <div className="settings-stack">
          {hasProblem ? (
            <Alert
              type={status.bot.status === 'red' || status.archive.status === 'red' ? 'error' : 'warning'}
              showIcon
              message="接入状态需要关注"
              description="请检查机器人长连接与存档拉取；状态异常时消息可能延迟，控制台会保留告警。"
            />
          ) : (
            <Alert
              type="success"
              showIcon
              message="四路接入均正常"
              description="存档拉取、机器人长连接、DSH Host 与席位状态均为绿色。"
            />
          )}

          <div className="wecom-toolbar">
            <Text type="secondary">最近检查：{formatDateTime(status.checkedAt)}</Text>
            <span className="zb-toolbar-spacer" />
            {isMockMode ? (
              <span className="wecom-demo-switch">
                演示：机器人长连接
                <Switch
                  size="small"
                  checked={status.bot.status !== 'red'}
                  onChange={(checked) => {
                    setMockBotConnected(checked);
                    void load(true);
                  }}
                />
              </span>
            ) : null}
          </div>

          <div className="wecom-status-grid">
            <StatusCard
              title="存档 SDK"
              icon={<SafetyCertificateOutlined />}
              status={status.archive.status}
              message={status.archive.message}
            >
              <span>最近拉取 {formatRelative(status.archive.lastPolledAt)}</span>
              <span>seq {status.archive.lastSeq ?? '—'}</span>
              <span>延迟 {status.archive.lagSeconds ?? '—'} 秒</span>
            </StatusCard>

            <StatusCard
              title="机器人长连接"
              icon={<WechatOutlined />}
              status={status.bot.status}
              message={status.bot.message}
            >
              <span>连接自 {formatDateTime(status.bot.connectedSince)}</span>
              {status.bot.lastDisconnectAt ? (
                <span>最近断开 {formatRelative(status.bot.lastDisconnectAt)}</span>
              ) : (
                <span>无断线记录</span>
              )}
            </StatusCard>

            <StatusCard
              title="DSH Host"
              icon={<CloudServerOutlined />}
              status={status.host.status}
              message={status.host.message}
            >
              <span>运行 {formatUptime(status.host.uptimeSeconds)}</span>
              <span>版本 {status.host.version ?? '—'}</span>
            </StatusCard>

            <StatusCard
              title="席位"
              icon={<TeamOutlined />}
              status={seatStatus}
              message={status.seat.message}
            >
              <span>已购 {status.seat.purchased} 个</span>
              <span>到期 {formatDateTime(status.seat.expiresAt)}</span>
            </StatusCard>
          </div>

          <Card className="zb-card" variant="borderless" title="判定口径">
            <Space direction="vertical" size={6}>
              <Text type="secondary">存档 SDK：按 seq 持续拉取服务群消息，延迟超过阈值转黄。</Text>
              <Text type="secondary">机器人长连接：断开后 30 秒内转红；恢复后自动回到绿色。</Text>
              <Text type="secondary">DSH Host：进程与版本由运行时上报；席位到期前 30 天转黄。</Text>
              <Text type="secondary">
                真实模式下状态来自 GET /settings/wecom/status，并通过 SSE 推送变化；本页每 15 秒兜底刷新。
              </Text>
            </Space>
          </Card>
        </div>
      ) : null}
    </PageContainer>
  );
}
