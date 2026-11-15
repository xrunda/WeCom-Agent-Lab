import {
  CheckCircleOutlined,
  EyeOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Drawer,
  Input,
  Modal,
  Pagination,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../../auth/AuthContext.tsx';
import { listAdvisors } from '../../mock/advisors.ts';
import { listGroups } from '../../mock/groups.ts';
import {
  getAlertDetail,
  listAlerts,
  resolveAlert,
  subscribeAlerts,
  type Alert as AlertItem,
  type AlertCount,
  type AlertDetail,
  type AlertStatus,
} from '../../mock/alerts.ts';
import { listRiskRules } from '../../mock/rules.ts';
import type { RiskRule } from '../../types.ts';
import { formatDateTime, formatRelative } from '../../utils/format.ts';
import { alertGuidance, alertReason } from './alert-insights.ts';
import {
  keywordsForRules,
  matchKeywords,
  parseDraftAlert,
  parseStaffAlert,
  splitByKeywords,
  draftRiskLabel,
} from './alert-text.ts';
import './alerts.css';

const { Text } = Typography;

const PAGE_SIZE = 20;

/** 员工发言与 AI 草稿都可能触发红线，状态文案统一用中性的「处理」 */
const STATUS_LABELS: { value: AlertStatus; label: string }[] = [
  { value: 'open', label: '待处理' },
  { value: 'acknowledged', label: '处理中' },
  { value: 'resolved', label: '已处理' },
];

function statusLabel(status: AlertStatus): string {
  return STATUS_LABELS.find((item) => item.value === status)?.label ?? status;
}

function statusColor(status: AlertStatus): string {
  if (status === 'open') return 'red';
  if (status === 'acknowledged') return 'gold';
  return 'green';
}

function asAlertStatus(value: string | null): AlertStatus | undefined {
  return value === 'open' || value === 'acknowledged' || value === 'resolved'
    ? value
    : undefined;
}

type AlertSource = 'staff' | 'draft';

function asAlertSource(value: string | null): AlertSource | undefined {
  return value === 'staff' || value === 'draft' ? value : undefined;
}

const SOURCE_OPTIONS: { value: AlertSource; label: string }[] = [
  { value: 'staff', label: '员工发言' },
  { value: 'draft', label: 'AI 草稿' },
];

/** 把发言原文按命中词加底色；没有关键词时按普通文本展示 */
function HighlightedQuote({ text, keywords }: { text: string; keywords: string[] }) {
  return (
    <>
      {splitByKeywords(text, keywords).map((segment, index) =>
        segment.hit ? (
          <mark className="alert-hit" key={index}>
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

interface AlertCardProps {
  alert: AlertItem;
  advisorName: string;
  groupName: string;
  keywords: string[];
  canWrite: boolean;
  onView: () => void;
  onResolve: () => void;
  /** 草稿红线：直接打开命中红线的草稿，处理入口在抽屉里 */
  onOpenDraft?: () => void;
}

function AlertCard({
  alert,
  advisorName,
  groupName,
  keywords,
  canWrite,
  onView,
  onResolve,
  onOpenDraft,
}: AlertCardProps) {
  /** 员工发言有引文；草稿红线只有规则与等级摘要，两类要分开渲染 */
  const isDraft = alert.source !== 'staff';
  const parsed = parseStaffAlert(alert.message);
  const draft = parseDraftAlert(alert.message);
  const ruleNames = isDraft ? draft.rules : parsed.rules;
  const riskLabel = isDraft ? draftRiskLabel(draft.riskLevel) : undefined;
  const resolved = alert.status === 'resolved';

  return (
    <article className={`alert-card${resolved ? ' is-resolved' : ''}`}>
      <header className="alert-card-head">
        <span className="alert-avatar" aria-hidden="true">
          {isDraft ? '稿' : advisorName.slice(0, 1)}
        </span>
        <div className="alert-who">
          <span className="alert-name">{advisorName}</span>
          <span className="alert-where">
            {isDraft ? '命中健康红线' : `在「${groupName}」发言`}
          </span>
        </div>
        <div className="alert-meta">
          {isDraft ? (
            <Tag bordered={false} className="alert-rule-tag">
              AI 草稿
            </Tag>
          ) : null}
          <span className="alert-time" title={formatDateTime(alert.createdAt)}>
            {formatRelative(alert.createdAt)}
          </span>
          <Tag bordered={false} color={statusColor(alert.status)}>
            {statusLabel(alert.status)}
          </Tag>
        </div>
      </header>

      {isDraft ? (
        <div className="alert-draft-body">{alert.message}</div>
      ) : (
        <blockquote className="alert-quote">
          {parsed.hasQuote ? '“' : null}
          <HighlightedQuote text={parsed.quote} keywords={keywords} />
          {parsed.hasQuote ? '”' : null}
        </blockquote>
      )}

      {resolved && alert.note ? (
        <div className="alert-note">
          <span className="alert-note-label">处理备注</span>
          <span>{alert.note}</span>
        </div>
      ) : null}

      <footer className="alert-card-foot">
        <div className="alert-rules">
          <span className="alert-rules-label">命中规则</span>
          {ruleNames.length > 0 ? (
            ruleNames.map((rule) => (
              <Tag bordered={false} key={rule} className="alert-rule-tag">
                {rule}
              </Tag>
            ))
          ) : (
            <Tag bordered={false} className="alert-rule-tag">
              健康红线
            </Tag>
          )}
          {riskLabel ? (
            <Tag bordered={false} color="red" className="alert-rule-tag">
              风险{riskLabel}
            </Tag>
          ) : null}
        </div>
        <Space size={8} className="alert-card-actions">
          {onOpenDraft ? (
            <Button type="link" size="small" onClick={onOpenDraft}>
              打开草稿
            </Button>
          ) : null}
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={onView}>
            查看详情
          </Button>
          {!resolved && canWrite ? (
            <Button size="small" onClick={onResolve}>
              标记已处理
            </Button>
          ) : null}
        </Space>
      </footer>
    </article>
  );
}

export default function AlertsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const urlStatus = searchParams.get('status');
  const urlAdvisorId = searchParams.get('advisorId') ?? undefined;
  const urlSource = searchParams.get('source');
  const canWrite = can('alert.write');

  const [items, setItems] = useState<AlertItem[]>([]);
  const [total, setTotal] = useState(0);
  const [resolvedTotal, setResolvedTotal] = useState(0);
  const [count, setCount] = useState<AlertCount>({ open: 0, acknowledged: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<AlertStatus | undefined>(() => asAlertStatus(urlStatus));
  const [advisorFilter, setAdvisorFilter] = useState<string | undefined>(urlAdvisorId);
  const [sourceFilter, setSourceFilter] = useState<AlertSource | undefined>(() =>
    asAlertSource(urlSource),
  );
  const [advisorNames, setAdvisorNames] = useState<Record<string, string>>({});
  const [groupNames, setGroupNames] = useState<Record<string, string>>({});
  const [rules, setRules] = useState<RiskRule[]>([]);
  const [detail, setDetail] = useState<AlertDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<AlertItem | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    let alive = true;
    listRiskRules({ enabled: true })
      .then(({ items: all }) => {
        if (alive) setRules(all);
      })
      .catch(() => {
        // 关键词高亮只是辅助：规则接口不可用时按普通文本展示
      });
    return () => {
      alive = false;
    };
  }, []);

  // 工作台「团队关注」深链：status / advisorId / source 从 URL 恢复。
  useEffect(() => {
    setStatus(asAlertStatus(urlStatus));
    setAdvisorFilter(urlAdvisorId);
    setSourceFilter(asAlertSource(urlSource));
    setPage(1);
  }, [urlStatus, urlAdvisorId, urlSource]);

  const clearAdvisorFilter = () => {
    setAdvisorFilter(undefined);
    const next = new URLSearchParams(searchParams);
    next.delete('advisorId');
    setSearchParams(next, { replace: true });
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 只看红线：员工的群发言与 AI 草稿各是一条来源，计数与列表用同一套筛选，避免数字对不上
      const base = { kind: 'redline', source: sourceFilter } as const;
      const [list, open, acknowledged, resolved, advisors, groups] = await Promise.all([
        listAlerts({ ...base, status, advisorId: advisorFilter, page, pageSize: PAGE_SIZE }),
        listAlerts({ ...base, status: 'open', pageSize: 1 }),
        listAlerts({ ...base, status: 'acknowledged', pageSize: 1 }),
        listAlerts({ ...base, status: 'resolved', pageSize: 1 }),
        listAdvisors(),
        listGroups({ pageSize: 100 }).catch(() => ({ items: [] })),
      ]);
      setItems(list.items);
      setTotal(list.total);
      setCount({ open: open.total, acknowledged: acknowledged.total, total: open.total + acknowledged.total });
      setResolvedTotal(resolved.total);
      setAdvisorNames(Object.fromEntries(advisors.map((item) => [item.id, item.name])));
      setGroupNames(
        Object.fromEntries(
          groups.items.map((item: { id: string; name: string }) => [item.id, item.name]),
        ),
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : '告警加载失败');
    } finally {
      setLoading(false);
    }
  }, [advisorFilter, page, sourceFilter, status, message]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const unsubscribe = subscribeAlerts(() => {
      void load();
    });
    return unsubscribe;
  }, [load]);

  const openDetail = async (id: string) => {
    setDetailOpen(true);
    setDetail(null);
    try {
      setDetail(await getAlertDetail(id));
    } catch (error) {
      message.error(error instanceof Error ? error.message : '详情加载失败');
    }
  };

  const submitResolve = async () => {
    if (!resolveTarget) return;
    const targetId = resolveTarget.id;
    try {
      await resolveAlert(targetId, note);
      message.success('已标记为已处理');
      setResolveTarget(null);
      setNote('');
      await load();
      if (detailOpen && detail?.alert.id === targetId) {
        setDetail(await getAlertDetail(targetId));
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '处理失败');
    }
  };

  const ruleNamesFor = useCallback(
    (alert: AlertItem) => parseStaffAlert(alert.message).rules,
    [],
  );

  /** 每条告警只高亮它自己命中的规则关键词；规则对不上时退回全部启用规则 */
  const allRuleKeywords = useMemo(
    () => keywordsForRules([], rules.filter((rule) => rule.action === 'flag')),
    [rules],
  );
  const keywordsByAlert = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const alert of items) {
      const names = ruleNamesFor(alert);
      map.set(
        alert.id,
        names.length > 0
          ? keywordsForRules(
              names,
              rules.filter((rule) => rule.action === 'flag'),
            )
          : allRuleKeywords,
      );
    }
    return map;
  }, [allRuleKeywords, items, ruleNamesFor, rules]);

  const advisorNameOf = (alert: AlertItem, fallback?: string | null): string => {
    if (alert.advisorId && advisorNames[alert.advisorId]) return advisorNames[alert.advisorId]!;
    if (fallback) return fallback;
    // 草稿告警正文里没有发言人，退回「AI 草稿」而不是「员工」
    if (alert.source !== 'staff') return 'AI 草稿';
    const parsed = parseStaffAlert(alert.message).senderName;
    return parsed ?? '员工';
  };

  const groupNameOf = (alert: AlertItem): string => {
    if (alert.groupId && groupNames[alert.groupId]) return groupNames[alert.groupId]!;
    const parsed = parseStaffAlert(alert.message).groupName;
    return parsed ?? alert.groupId ?? '未知群';
  };

  const changeStatus = (value: AlertStatus | undefined) => {
    setStatus(value);
    setPage(1);
  };
  const changeAdvisor = (value: string | undefined) => {
    setAdvisorFilter(value);
    setPage(1);
  };
  const changeSource = (value: AlertSource | undefined) => {
    setSourceFilter(value);
    setPage(1);
  };

  const filtersActive = Boolean(status || advisorFilter || sourceFilter);

  return (
    <PageContainer
      className="alerts-page"
      header={{
        title: '质检与告警',
        subTitle:
          '服务群里的员工发言与 AI 草稿都会在这里留下红线记录；点开核对命中规则与处理结果。',
      }}
      extra={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>,
      ]}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <div className="alert-summary">
          <div className="alert-summary-item">
            <span className={`alert-summary-value${count.open > 0 ? ' is-danger' : ''}`}>
              {count.open}
            </span>
            <span className="alert-summary-label">待处理</span>
          </div>
          <span className="alert-summary-divider" aria-hidden="true" />
          <div className="alert-summary-item">
            <span className="alert-summary-value">{count.acknowledged}</span>
            <span className="alert-summary-label">处理中</span>
          </div>
          <span className="alert-summary-divider" aria-hidden="true" />
          <div className="alert-summary-item">
            <span className="alert-summary-value">{resolvedTotal}</span>
            <span className="alert-summary-label">已处理</span>
          </div>
        </div>

        {advisorFilter ? (
          <Alert
            type="info"
            showIcon
            message={`已按服务人员筛选：${advisorNames[advisorFilter] ?? advisorFilter}`}
            action={
              <Button size="small" onClick={clearAdvisorFilter}>
                清除人员筛选
              </Button>
            }
          />
        ) : null}

        <Card variant="borderless">
          <div className="alert-filters">
            <Space wrap size={12}>
              <Select
                allowClear
                placeholder="全部顾问"
                style={{ width: 160 }}
                value={advisorFilter}
                onChange={changeAdvisor}
                options={Object.entries(advisorNames).map(([value, label]) => ({ value, label }))}
              />
              <Select
                allowClear
                placeholder="全部来源"
                style={{ width: 140 }}
                value={sourceFilter}
                onChange={changeSource}
                options={SOURCE_OPTIONS}
              />
              <Select
                allowClear
                placeholder="全部状态"
                style={{ width: 140 }}
                value={status}
                onChange={changeStatus}
                options={STATUS_LABELS}
              />
            </Space>
            <Text type="secondary">共 {total} 条</Text>
          </div>
        </Card>

        {loading && items.length === 0 ? (
          <div className="alert-loading">
            <Spin />
          </div>
        ) : items.length === 0 ? (
          <div className="alert-empty">
            <CheckCircleOutlined className="alert-empty-icon" />
            <div className="alert-empty-title">
              {filtersActive ? '当前筛选下没有红线记录' : '最近没有命中健康红线的记录'}
            </div>
            <div className="alert-empty-hint">
              {filtersActive
                ? '换个来源、顾问或状态看看；清除筛选可查看全部记录。'
                : '员工在服务群的发言，或 AI 起草的回复命中诊断、调药、疗效承诺等规则时，会出现在这里。'}
            </div>
          </div>
        ) : (
          <div className="alert-feed" aria-busy={loading}>
            {items.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                advisorName={advisorNameOf(alert)}
                groupName={groupNameOf(alert)}
                keywords={keywordsByAlert.get(alert.id) ?? allRuleKeywords}
                canWrite={canWrite}
                onView={() => void openDetail(alert.id)}
                onOpenDraft={
                  alert.source !== 'staff' && alert.draftId
                    ? () => navigate(`/service-flow?draftId=${encodeURIComponent(alert.draftId!)}`)
                    : undefined
                }
                onResolve={() => {
                  setResolveTarget(alert);
                  setNote('');
                }}
              />
            ))}
          </div>
        )}

        {total > PAGE_SIZE ? (
          <div className="alert-pagination">
            <Pagination
              current={page}
              pageSize={PAGE_SIZE}
              total={total}
              showSizeChanger={false}
              onChange={setPage}
            />
          </div>
        ) : null}
      </Space>

      <Drawer
        width={640}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title="红线告警详情"
        destroyOnHidden
      >
        {detail ? (
          (() => {
            const alert = detail.alert;
            const isDraft = alert.source !== 'staff';
            const parsed = parseStaffAlert(alert.message);
            const draftParts = parseDraftAlert(alert.message);
            const ruleNames = isDraft
              ? draftParts.rules
              : parsed.rules.length > 0
                ? parsed.rules
                : ruleNamesFor(alert);
            const keywords =
              ruleNames.length > 0
                ? keywordsForRules(
                    ruleNames,
                    rules.filter((rule) => rule.action === 'flag'),
                  )
                : allRuleKeywords;
            const matched = isDraft ? [] : matchKeywords(parsed.quote, keywords);
            const advisorName = advisorNameOf(alert, detail.advisor?.name);
            const groupName = groupNameOf(alert);
            const riskLabel = draftRiskLabel(draftParts.riskLevel);
            return (
              <Space direction="vertical" size={20} style={{ width: '100%' }}>
                <Space wrap size={8}>
                  <Tag bordered={false} color={statusColor(alert.status)}>
                    {statusLabel(alert.status)}
                  </Tag>
                  {isDraft ? (
                    <Tag bordered={false} className="alert-rule-tag">
                      AI 草稿
                    </Tag>
                  ) : null}
                  <Text type="secondary">{formatDateTime(alert.createdAt)}</Text>
                </Space>

                <div className="alert-chain">
                  <section className="alert-step">
                    <span className="alert-step-index" aria-hidden="true">
                      1
                    </span>
                    <div className="alert-step-title">{isDraft ? 'AI 草稿' : '员工发言'}</div>
                    <div className="alert-step-meta">
                      {isDraft
                        ? `${advisorName} · ${
                            detail.draft?.id ?? alert.draftId ?? '未关联草稿'
                          } · ${formatDateTime(alert.createdAt)}`
                        : `${advisorName} · 「${groupName}」 · ${formatDateTime(alert.createdAt)}`}
                    </div>
                    {isDraft ? (
                      <>
                        {detail.draft?.summary ? (
                          <blockquote className="alert-quote is-detail">
                            {detail.draft.summary}
                          </blockquote>
                        ) : null}
                        <div className="alert-step-hint">
                          告警正文只记录命中规则，具体措辞请打开草稿查看。
                        </div>
                        {alert.draftId ? (
                          <Button
                            size="small"
                            onClick={() =>
                              navigate(
                                `/service-flow?draftId=${encodeURIComponent(alert.draftId!)}`,
                              )
                            }
                          >
                            打开草稿处理
                          </Button>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <blockquote className="alert-quote is-detail">
                          {parsed.hasQuote ? '“' : null}
                          <HighlightedQuote text={parsed.quote} keywords={keywords} />
                          {parsed.hasQuote ? '”' : null}
                        </blockquote>
                        {matched.length > 0 ? (
                          <div className="alert-step-hint">
                            命中词：
                            {matched.map((word) => (
                              <mark className="alert-hit" key={word}>
                                {word}
                              </mark>
                            ))}
                          </div>
                        ) : null}
                      </>
                    )}
                  </section>

                  <section className="alert-step">
                    <span className="alert-step-index" aria-hidden="true">
                      2
                    </span>
                    <div className="alert-step-title">命中规则</div>
                    <Space wrap size={6}>
                      {(ruleNames.length > 0 ? ruleNames : ['健康红线']).map((rule) => (
                        <Tag bordered={false} key={rule} className="alert-rule-tag">
                          {rule}
                        </Tag>
                      ))}
                      {riskLabel ? (
                        <Tag bordered={false} color="red" className="alert-rule-tag">
                          风险{riskLabel}
                        </Tag>
                      ) : null}
                    </Space>
                    <div className="alert-step-hint">
                      {alertReason(alert.kind, alert.source)}
                    </div>
                  </section>

                  <section className="alert-step">
                    <span className="alert-step-index" aria-hidden="true">
                      3
                    </span>
                    <div className="alert-step-title">生成告警</div>
                    <div className="alert-step-meta">
                      「{alert.title}」 · {formatDateTime(alert.createdAt)}
                    </div>
                    <div className="alert-step-hint">
                      {isDraft
                        ? '红线告警只做提示与留痕，不会自动撤回草稿或改动已发出的消息。'
                        : '该发言已进入人工复核，未自动撤回或改动群内消息。'}
                    </div>
                  </section>
                </div>

                <Card size="small" title="处理情况">
                  <Descriptions size="small" column={2} bordered>
                    <Descriptions.Item label="处理状态">
                      <Tag bordered={false} color={statusColor(alert.status)}>
                        {statusLabel(alert.status)}
                      </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="处理人（账号）">
                      {alert.resolvedBy ?? '—'}
                    </Descriptions.Item>
                    <Descriptions.Item label="处理时间">
                      {alert.resolvedAt ? formatDateTime(alert.resolvedAt) : '—'}
                    </Descriptions.Item>
                    <Descriptions.Item label="处理备注">
                      {alert.note ?? (alert.status === 'resolved' ? '未填写' : '尚未处理')}
                    </Descriptions.Item>
                  </Descriptions>
                </Card>

                {alert.status !== 'resolved' ? (
                  <Alert
                    type="info"
                    showIcon
                    message="怎么处理"
                    description={alertGuidance(alert.kind, alert.source)}
                  />
                ) : null}

                {alert.status !== 'resolved' && canWrite ? (
                  <Space wrap size={8}>
                    <Button
                      type="primary"
                      onClick={() => {
                        setResolveTarget(alert);
                        setNote('');
                      }}
                    >
                      标记已处理
                    </Button>
                    <Text type="secondary">处理时请填写备注，便于后续追溯。</Text>
                  </Space>
                ) : null}
              </Space>
            );
          })()
        ) : (
          <div className="alert-loading">
            <Spin />
          </div>
        )}
      </Drawer>

      <Modal
        open={Boolean(resolveTarget)}
        title={
          <Space>
            <WarningOutlined />
            标记已处理
          </Space>
        }
        okText="确认处理"
        cancelText="取消"
        onCancel={() => setResolveTarget(null)}
        onOk={() => void submitResolve()}
      >
        {resolveTarget && (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Text strong>
              {resolveTarget.source !== 'staff'
                ? `${advisorNameOf(resolveTarget)}的 AI 草稿命中红线`
                : `${advisorNameOf(resolveTarget)}在「${groupNameOf(resolveTarget)}」的发言`}
            </Text>
            <Text type="secondary">
              {resolveTarget.source !== 'staff'
                ? resolveTarget.message
                : parseStaffAlert(resolveTarget.message).quote}
            </Text>
            <Input.TextArea
              rows={3}
              maxLength={200}
              showCount
              placeholder="填写处理备注（必填，≤200 字）"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Space>
        )}
      </Modal>
    </PageContainer>
  );
}
