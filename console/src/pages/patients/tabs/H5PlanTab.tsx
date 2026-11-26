/**
 * PH5-04（#233）患者详情「健康方案」Tab：版本列表 + 审核动作。
 *
 * 审核（发布/退回/暂停）需要 `h5.plan.review` 能力，与角色矩阵分开；
 * 没有该能力的账号只能查看，不能发布——避免把管理员默认为专业审核人。
 */
import {
  Alert,
  App as AntApp,
  Button,
  Descriptions,
  Empty,
  Input,
  Modal,
  Space,
  Spin,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';

import { formatDateTime } from '../../../utils/format.ts';
import { isMockMode } from '../../../mock/http.ts';
import {
  changePlanStatus,
  generatePlan,
  listPlans,
  PLAN_STATUS_LABEL,
  publishPlan,
  rejectPlan,
  updatePlan,
  type PlanView,
} from '../../../mock/patient-h5-plan.ts';

const { Text, Paragraph } = Typography;

interface Props {
  patientId: string;
  canReview: boolean;
}

export function H5PlanTab({ patientId, canReview }: Props) {
  const { message } = AntApp.useApp();
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState<PlanView | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [editing, setEditing] = useState<PlanView | null>(null);
  const [editGoal, setEditGoal] = useState('');

  const reload = (): void => {
    setLoading(true);
    listPlans(patientId)
      .then((result) => setPlans(result.items))
      .catch((err: unknown) => message.error(err instanceof Error ? err.message : '加载失败'))
      .finally(() => setLoading(false));
  };

  useEffect(reload, [patientId, message]);

  const run = async (action: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusy(true);
    try {
      await action();
      message.success(ok);
      reload();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center' }}>
        <Spin tip="正在加载方案…" />
      </div>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {isMockMode && (
        <Alert type="info" showIcon message="mock 模式：方案为虚构示例；真实模式下由 AI 生成或团队起草。" />
      )}

      {!canReview && (
        <Alert
          type="warning"
          showIcon
          message="当前账号没有「方案审核」能力，只能查看"
          description="发布、退回、暂停需要管理员在「设置 → 账号 → H5 能力」里单独开通 h5.plan.review——管理员身份本身不等于专业审核资质。"
        />
      )}

      <Space>
        <Button
          type="primary"
          disabled={!canReview || busy}
          onClick={() =>
            void run(
              () =>
                generatePlan(patientId, {
                  startDate: new Date().toISOString().slice(0, 10),
                  endDate: new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString().slice(0, 10),
                }),
              '已生成草稿，等待审核',
            )
          }
        >
          生成草稿
        </Button>
        <Button onClick={reload} disabled={busy}>
          刷新
        </Button>
      </Space>

      {plans.length === 0 && <Empty description="还没有方案" />}

      {plans.map((plan) => {
        const meta = PLAN_STATUS_LABEL[plan.status];
        return (
          <div key={plan.id} style={{ border: '1px solid #eee', borderRadius: 10, padding: 16 }}>
            <Space align="center" style={{ marginBottom: 8 }}>
              <Tag color={meta.color}>{meta.text}</Tag>
              <Text strong>第 {plan.version} 版</Text>
              <Text type="secondary">
                {plan.startDate} 至 {plan.endDate}
              </Text>
            </Space>

            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="阶段目标">{plan.stageGoal || '—'}</Descriptions.Item>
              <Descriptions.Item label="食养思路">{plan.foodTherapyRationale || '—'}</Descriptions.Item>
              <Descriptions.Item label="行动">
                {plan.actions.length === 0 ? '—' : `${plan.actions.length} 条`}
              </Descriptions.Item>
              <Descriptions.Item label="生成方式">
                {plan.generation.source === 'manual' ? '团队起草' : `AI 生成${plan.generation.model ? `（${plan.generation.model}）` : ''}`}
                {plan.generation.errorCode && (
                  <Text type="danger"> · 失败：{plan.generation.errorCode}</Text>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="输入依据">
                档案条目 {plan.inputSnapshot.profileEntryCount} 条 · {formatDateTime(plan.inputSnapshot.takenAt)}
              </Descriptions.Item>
              <Descriptions.Item label="审核">
                {plan.review.reviewerName
                  ? `${plan.review.reviewerName} · ${formatDateTime(plan.review.reviewedAt ?? 0)}`
                  : '尚未审核'}
              </Descriptions.Item>
            </Descriptions>

            {plan.status === 'data_pending' && (
              <Paragraph type="secondary" style={{ marginTop: 8 }}>
                资料缺失或存在冲突，未生成可执行方案。补齐档案后重新生成，或由团队起草。
              </Paragraph>
            )}

            {plan.reviewHistory.length > 0 && (
              <Timeline
                style={{ marginTop: 12 }}
                items={plan.reviewHistory.map((item) => ({
                  children: `${item.status === 'approved' ? '发布' : item.status === 'rejected' ? '退回' : item.status} · ${item.reviewerName ?? ''} ${formatDateTime(item.at)}${item.note ? ` · ${item.note}` : ''}`,
                }))}
              />
            )}

            <Space style={{ marginTop: 12 }} wrap>
              {plan.status === 'reviewing' && (
                <>
                  <Button
                    type="primary"
                    disabled={!canReview || busy}
                    onClick={() => void run(() => publishPlan(patientId, plan.id), '已发布，患者可见')}
                  >
                    发布
                  </Button>
                  <Button
                    danger
                    disabled={!canReview || busy}
                    onClick={() => {
                      setRejecting(plan);
                      setRejectNote('');
                    }}
                  >
                    退回
                  </Button>
                  <Button
                    disabled={!canReview || busy}
                    onClick={() => {
                      setEditing(plan);
                      setEditGoal(plan.stageGoal);
                    }}
                  >
                    编辑目标
                  </Button>
                </>
              )}
              {plan.status === 'published' && (
                <>
                  <Button disabled={!canReview || busy} onClick={() => void run(() => changePlanStatus(patientId, plan.id, 'suspend'), '已暂停')}>
                    暂停
                  </Button>
                  <Button disabled={!canReview || busy} onClick={() => void run(() => changePlanStatus(patientId, plan.id, 'end'), '已结束')}>
                    结束
                  </Button>
                </>
              )}
              {plan.status === 'suspended' && (
                <>
                  <Button disabled={!canReview || busy} onClick={() => void run(() => changePlanStatus(patientId, plan.id, 'resume'), '已恢复')}>
                    恢复
                  </Button>
                  <Button disabled={!canReview || busy} onClick={() => void run(() => changePlanStatus(patientId, plan.id, 'end'), '已结束')}>
                    结束
                  </Button>
                </>
              )}
              {(plan.status === 'generate_failed' || plan.status === 'data_pending') && canReview && (
                <Button onClick={() => { setEditing(plan); setEditGoal(plan.stageGoal); }}>
                  人工接管编辑
                </Button>
              )}
            </Space>
          </div>
        );
      })}

      <Modal
        open={rejecting !== null}
        title="退回方案"
        okText="确认退回"
        okButtonProps={{ danger: true }}
        onCancel={() => setRejecting(null)}
        onOk={() => {
          if (!rejecting) return;
          void run(() => rejectPlan(patientId, rejecting.id, rejectNote), '已退回').then(() =>
            setRejecting(null),
          );
        }}
      >
        <Input.TextArea
          rows={3}
          value={rejectNote}
          onChange={(event) => setRejectNote(event.target.value)}
          placeholder="写清退回原因，便于重新生成或人工修改"
        />
      </Modal>

      <Modal
        open={editing !== null}
        title={`编辑第 ${editing?.version ?? ''} 版阶段目标`}
        okText="保存"
        onCancel={() => setEditing(null)}
        onOk={() => {
          if (!editing) return;
          void run(
            () =>
              updatePlan(patientId, editing.id, {
                expectedVersion: editing.version,
                stageGoal: editGoal,
              }),
            '已保存',
          ).then(() => setEditing(null));
        }}
      >
        <Input.TextArea
          rows={3}
          value={editGoal}
          onChange={(event) => setEditGoal(event.target.value)}
          placeholder="患者能读懂的一两句话"
        />
        <Paragraph type="secondary" style={{ marginTop: 8 }}>
          当前只支持改阶段目标；行动清单编辑随后续工作包补充。
        </Paragraph>
      </Modal>
    </Space>
  );
}
