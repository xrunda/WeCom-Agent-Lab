import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  HeartOutlined,
  RiseOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { App, Button, InputNumber, Popover, Space, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { useAuth, useTerm } from '../../auth/AuthContext.tsx';
import { updateTenant } from '../../mock/api.ts';
import type { DashboardValue } from '../../types.ts';
import { formatMinutes, formatPercent } from '../../utils/format.ts';

const { Text, Title } = Typography;

interface ValueBarProps {
  value: DashboardValue;
  rangeLabel: string;
  onRefresh: () => void;
  onOpenOnboarding: () => void;
}

/**
 * 工作台价值条（WP-M #58）。
 * 采纳率分母固定为「已发出」，同时拆分原样 / 改稿后 / 人工改写三类；
 * 节省时长 =（原样 + 改稿后）× 单条人工撰写时长，时长可在口径设置中修改。
 */
export function ValueBar({ value, rangeLabel, onRefresh, onOpenOnboarding }: ValueBarProps) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const term = useTerm();
  const [minutes, setMinutes] = useState(value.minutesPerDraft);
  const [saving, setSaving] = useState(false);
  const canConfigure = can('setting.write');

  useEffect(() => {
    setMinutes(value.minutesPerDraft);
  }, [value.minutesPerDraft]);

  const { adoption } = value;
  const sentTotal = adoption.sentTotal || 0;
  const ratio = (count: number) => (sentTotal > 0 ? formatPercent(count / sentTotal) : '—');

  const saveMinutes = async () => {
    if (!minutes) return;
    setSaving(true);
    try {
      await updateTenant({ settings: { writeMinutesPerDraft: minutes } });
      message.success(`口径已更新：每条草稿按 ${minutes} 分钟估算`);
      onRefresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const minutesEditor = (
    <div className="value-minutes-editor">
      <Text type="secondary">单条人工撰写时长</Text>
      <Space.Compact style={{ marginTop: 8 }}>
        <InputNumber
          min={1}
          max={30}
          value={minutes}
          onChange={(next) => setMinutes(next ?? 1)}
          suffix="分钟"
          style={{ width: 140 }}
        />
        <Button type="primary" loading={saving} onClick={() => void saveMinutes()}>
          保存
        </Button>
      </Space.Compact>
      <p className="value-minutes-hint">
        仅影响「节省写作时间」的估算口径，不改变真实服务记录。
      </p>
    </div>
  );

  return (
    <>
      <section className="value-strip" aria-label={`${rangeLabel}价值速览`}>
        <div className="value-strip-head">
          <div>
            <Text className="value-strip-eyebrow">价值速览 · {rangeLabel}</Text>
            <Title level={4} className="value-strip-title">
              每一条草稿，都在为顾问省时间
            </Title>
          </div>
          <Text className="value-strip-formula">采纳率 = {adoption.rateFormula}</Text>
        </div>

        <div className="value-strip-grid">
          <div className="value-item">
            <RiseOutlined />
            <div>
              <div className="value-item-value">{formatPercent(adoption.rate)}</div>
              <div className="value-item-label">草稿采纳率</div>
            </div>
          </div>
          <div className="value-item">
            <ClockCircleOutlined />
            <div className="value-item-main">
              <div className="value-item-value-row">
                <span className="value-item-value">{formatMinutes(value.savedMinutes)}</span>
                {canConfigure ? (
                  <Popover
                    trigger="click"
                    placement="bottomLeft"
                    content={minutesEditor}
                    title="节省时长口径"
                  >
                    <Button
                      type="text"
                      size="small"
                      className="value-item-config"
                      icon={<SettingOutlined />}
                      aria-label="修改节省时长口径"
                    />
                  </Popover>
                ) : null}
              </div>
              <Tooltip title={value.savedMinutesBasis}>
                <div className="value-item-label">节省写作时间 · 估算</div>
              </Tooltip>
            </div>
          </div>
          <div className="value-item">
            <HeartOutlined />
            <div>
              <div className="value-item-value">{value.proactiveCareCount}</div>
              <div className="value-item-label">{rangeLabel}主动关怀</div>
            </div>
          </div>
          <div className="value-item">
            <CheckCircleOutlined />
            <div>
              <div className="value-item-value">{formatPercent(value.verificationPassRate)}</div>
              <div className="value-item-label">核验通过率</div>
            </div>
          </div>
          <div className="value-item">
            <TeamOutlined />
            <div>
              <div className="value-item-value">{value.patientsPerAdvisor.toFixed(1)}</div>
              <div className="value-item-label">人均服务{term}</div>
            </div>
          </div>
        </div>

        <div className="value-breakdown" aria-label="采纳率构成">
          <span>
            原样采纳 <strong>{adoption.original}</strong> 条（{ratio(adoption.original)}）
          </span>
          <span className="value-breakdown-sep">·</span>
          <span>
            改稿后采纳 <strong>{adoption.revised}</strong> 条（{ratio(adoption.revised)}）
          </span>
          <span className="value-breakdown-sep">·</span>
          <span>
            人工改写 <strong>{adoption.edited}</strong> 条（{ratio(adoption.edited)}）
          </span>
          <span className="value-breakdown-sep">·</span>
          <span>
            已发出 <strong>{sentTotal}</strong> 条
          </span>
        </div>
      </section>

      <div className="value-onboarding-card">
        <div className="value-onboarding-main">
          <Text strong>想在自己的企微里跑同一条链路？</Text>
          <span className="value-onboarding-hint">
            先看前置条件、时间线与席位成本，再提交开通申请。
          </span>
        </div>
        <Button onClick={onOpenOnboarding}>
          查看开通条件 <ArrowRightOutlined />
        </Button>
      </div>
    </>
  );
}
