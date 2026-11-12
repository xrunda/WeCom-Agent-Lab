import {
  PictureOutlined,
  ReloadOutlined,
  SendOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Steps,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { mediaUrl } from '../../mock/media.ts';
import {
  SANDBOX_ACTION_LABELS,
  SANDBOX_GUIDE_STEPS,
  SANDBOX_OUTCOME_LABELS,
  SANDBOX_PRESET_IMAGES,
  applySandboxAction,
  createSandboxSession,
  getSandboxState,
  resetSandboxSession,
  sendSandboxMessage,
  subscribeSandbox,
  uploadSandboxFile,
  type SandboxAction,
  type SandboxDraft,
  type SandboxSessionResponse,
  type SandboxState,
} from '../../mock/sandbox.ts';
import { formatDateTime } from '../../utils/format.ts';
import './sandbox.css';

const { Text, Paragraph } = Typography;

const GUIDE_KEY = 'zhiban.console.j.sandbox.guideSeen';

function readGuideSeen(): boolean {
  try {
    return localStorage.getItem(GUIDE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveGuideSeen(): void {
  try {
    localStorage.setItem(GUIDE_KEY, '1');
  } catch {
    // ignore
  }
}

function isTerminal(draft: SandboxDraft | null): boolean {
  return Boolean(
    draft && ['VERIFIED', 'EDIT_SENT', 'MISROUTE_ALERT', 'UNVERIFIED'].includes(draft.status),
  );
}

export default function SandboxPage() {
  const { message, modal } = App.useApp();
  const [sessionResponse, setSessionResponse] = useState<SandboxSessionResponse | null>(null);
  const [state, setState] = useState<SandboxState | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editedBody, setEditedBody] = useState('');
  const [wrongOpen, setWrongOpen] = useState(false);
  const [targetGroupId, setTargetGroupId] = useState('grp_sandbox_2');

  const refresh = useCallback(async () => {
    const next = await getSandboxState();
    setState(next);
    return next;
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([createSandboxSession(), getSandboxState()])
      .then(([response, current]) => {
        if (!active) return;
        setSessionResponse(response);
        setState(current);
        if (!readGuideSeen()) setGuideOpen(true);
      })
      .catch((error: unknown) => {
        if (active) message.error(error instanceof Error ? error.message : '沙盒加载失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [message]);

  // 真实模式下 Agent 回合是异步的：发送接口返回 202，草稿稍后经 SSE 到达。
  // 不订阅的话页面只会在发送后刷新一次，看不到随后生成的草稿。
  useEffect(() => {
    const unsubscribe = subscribeSandbox(() => {
      void refresh().catch(() => {
        // 忽略单次刷新失败；下一次事件会再拉
      });
    });
    return unsubscribe;
  }, [refresh]);

  const draft = state?.drafts.at(-1) ?? null;
  const verification = state?.verification ?? null;
  const latestImage = useMemo(() => {
    const messages = state?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].kind === 'image') return messages[index];
    }
    return null;
  }, [state]);

  const send = async (payload: { kind: 'text' | 'image'; text?: string; mediaId?: string }) => {
    if (!state) return;
    setSending(true);
    try {
      await sendSandboxMessage(payload);
      await refresh();
      if (payload.kind === 'text') setInput('');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  const sendText = () => {
    const text = input.trim();
    if (!text) {
      message.warning('先输入一句话');
      return;
    }
    void send({ kind: 'text', text });
  };

  const sendPreset = (presetId: string) => {
    const preset = sessionResponse?.presets.find((item) => item.id === presetId);
    if (!preset) return;
    if (preset.kind === 'image' && preset.mediaId) {
      void send({ kind: 'image', mediaId: preset.mediaId });
    } else if (preset.text) {
      void send({ kind: 'text', text: preset.text });
    }
  };

  const handleUpload = async (file: File) => {
    setSending(true);
    try {
      const uploaded = await uploadSandboxFile(file);
      await sendSandboxMessage({ kind: 'image', mediaId: uploaded.mediaId });
      await refresh();
      message.success('图片已发送，顾问手机里会出现原图和草稿');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '图片上传失败');
    } finally {
      setSending(false);
    }
    return false;
  };

  const runAction = async (
    action: SandboxAction,
    options?: { editedBody?: string; targetGroupId?: string },
  ) => {
    if (!draft) return;
    try {
      const result = await applySandboxAction(draft.id, action, options);
      await refresh();
      message.success(`核验结果：${SANDBOX_OUTCOME_LABELS[result.outcome].label}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败');
    }
  };

  const confirmReset = () => {
    modal.confirm({
      title: '重置沙盒？',
      content: '会清空沙盒里的消息、记忆、草稿和核验结果，不影响真实客户群。',
      okText: '重置',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await resetSandboxSession();
          await refresh();
          message.success('沙盒已重置');
        } catch (error) {
          message.error(error instanceof Error ? error.message : '重置失败');
        }
      },
    });
  };

  const openEdit = () => {
    if (!draft) return;
    setEditedBody(draft.body);
    setEditOpen(true);
  };

  const openWrongGroup = () => {
    const other = sessionResponse?.session.groups.find((item) => item.role === 'other');
    setTargetGroupId(other?.id ?? 'grp_sandbox_2');
    setWrongOpen(true);
  };

  const currentStep = verification ? 4 : draft ? (draft.status === 'ACKNOWLEDGED' ? 3 : 2) : 1;

  return (
    <PageContainer
      header={{
        title: '体验中心（沙盒）',
        subTitle: '真 DSH、真模型、真插件，只把渠道换成模拟群；数据单独存放，随时重置。',
      }}
      extra={[
        <Button key="reset" icon={<ReloadOutlined />} onClick={confirmReset}>
          重置沙盒
        </Button>,
      ]}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message="体验沙盒 · 不连接真实客户群"
          description="这里的消息、记忆和草稿只属于当前账号的沙盒，不计入工作台与报表。真实企微群不会收到任何消息。"
          action={
            <Tag color="gold" bordered={false}>
              剩余 {state?.quota.remaining ?? 0} / {state?.quota.dailyLimit ?? 100} 次
            </Tag>
          }
        />

        <div className="sandbox-grid">
          <Card
            className="sandbox-column"
            title={
              <Space size={8}>
                <span>模拟客户群</span>
                <Tag bordered={false} color="blue">
                  模拟
                </Tag>
              </Space>
            }
            extra={
              <Text type="secondary" style={{ fontSize: 12 }}>
                体验客户群
              </Text>
            }
          >
            <div className="sandbox-chat" aria-label="模拟客户群消息">
              {loading ? (
                <Text type="secondary">正在准备沙盒…</Text>
              ) : state && state.messages.length > 0 ? (
                state.messages.map((item) => (
                  <div className="chat-row" key={item.id}>
                    <div className="chat-avatar">客</div>
                    <div className="chat-main">
                      <div className="chat-meta">体验患者 · {formatDateTime(item.at)}</div>
                      <div className="chat-bubble">
                        {item.kind === 'image' && item.imageUrl ? (
                          <img
                            className="chat-image"
                            src={item.imageUrl}
                            alt={item.mediaId ?? '图片消息'}
                          />
                        ) : (
                          item.text
                        )}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="sandbox-empty">
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="先点下面的引导问题，体验一次完整闭环"
                  />
                </div>
              )}
            </div>

            <div className="sandbox-presets">
              {(sessionResponse?.presets ?? []).map((preset) => (
                <Button
                  key={preset.id}
                  size="small"
                  disabled={sending}
                  onClick={() => sendPreset(preset.id)}
                >
                  {preset.label}
                </Button>
              ))}
            </div>

            <div className="sandbox-composer">
              <Input
                value={input}
                placeholder="输入一句话，例如：我对海鲜过敏"
                onChange={(event) => setInput(event.target.value)}
                onPressEnter={sendText}
                disabled={sending}
              />
              <Button type="primary" icon={<SendOutlined />} loading={sending} onClick={sendText}>
                发送
              </Button>
              <Upload
                accept="image/png,image/jpeg"
                showUploadList={false}
                beforeUpload={(file) => {
                  void handleUpload(file);
                  return false;
                }}
              >
                <Button icon={<PictureOutlined />} disabled={sending}>
                  上传图片
                </Button>
              </Upload>
            </div>

            <div className="sandbox-samples">
              <Text type="secondary" style={{ fontSize: 12 }}>
                预置示例图：
              </Text>
              {SANDBOX_PRESET_IMAGES.map((sample) => (
                <button
                  type="button"
                  className="sandbox-sample"
                  key={sample.mediaId}
                  disabled={sending}
                  onClick={() => void send({ kind: 'image', mediaId: sample.mediaId })}
                >
                  <img src={mediaUrl(sample.mediaId, 'meal', sample.label)} alt={sample.label} />
                  <span>{sample.label}</span>
                </button>
              ))}
            </div>
          </Card>

          <Card
            className="sandbox-column"
            title="模拟顾问手机"
            extra={<Tag bordered={false}>草稿卡片</Tag>}
          >
            <div className="wecom-phone">
              <div className="wecom-phone-top">业务通知</div>
              <div className="wecom-phone-body">
                {draft ? (
                  <div className="wecom-card">
                    <div className="wecom-card-head">
                      <span className="wecom-agent">小安</span>
                      <Tag bordered={false}>草稿 v{draft.version}</Tag>
                    </div>
                    <div className="wecom-card-body">{draft.body}</div>
                    {latestImage?.imageUrl && (
                      <img className="wecom-image" src={latestImage.imageUrl} alt="客户发来的图片" />
                    )}
                    <div className="wecom-card-foot">
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        生成于 {formatDateTime(draft.createdAt)}
                      </Text>
                    </div>
                  </div>
                ) : (
                  <div className="wecom-empty">
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="客户发消息后，草稿会推送到这里"
                    />
                  </div>
                )}

                {verification && (
                  <Alert
                    className="sandbox-result"
                    type={verification.outcome === 'verified' ? 'success' : 'warning'}
                    showIcon
                    message={`核验结果：${SANDBOX_OUTCOME_LABELS[verification.outcome].label}`}
                    description={
                      verification.outcome === 'misroute'
                        ? `实际发到了「${verification.matchedGroupName ?? '未知群'}」`
                        : verification.outcome === 'unverified'
                          ? '只点了已发送，存档中没有找到对应消息。'
                          : `匹配群：${verification.matchedGroupName ?? '体验客户群'}`
                    }
                  />
                )}
              </div>
            </div>

            <div className="sandbox-actions">
              <Button
                type="primary"
                disabled={!draft || isTerminal(draft)}
                onClick={() => void runAction('send_original')}
              >
                {SANDBOX_ACTION_LABELS.send_original}
              </Button>
              <Button disabled={!draft || isTerminal(draft)} onClick={openEdit}>
                {SANDBOX_ACTION_LABELS.send_edited}
              </Button>
              <Button disabled={!draft || isTerminal(draft)} onClick={openWrongGroup}>
                {SANDBOX_ACTION_LABELS.send_wrong_group}
              </Button>
              <Button
                danger
                disabled={!draft || isTerminal(draft)}
                onClick={() => void runAction('ack_only')}
              >
                {SANDBOX_ACTION_LABELS.ack_only}
              </Button>
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              四种操作分别产生：✅ 已核验 / ✏️ 改后发送 / ⚠️ 发错群 / ❌ 未核验。
            </Text>
          </Card>

          <Card
            className="sandbox-column"
            title="记忆面板"
            extra={
              <Tag bordered={false} color="teal">
                患者记忆，患者做主
              </Tag>
            }
          >
            <div className="memory-panel">
              {state && state.memories.length > 0 ? (
                state.memories.map((item) => (
                  <div className="memory-card" key={item.id}>
                    <div className="memory-head">
                      <Tag bordered={false} color="blue">
                        {item.category === 'dietary_taboo' ? '饮食禁忌' : '记忆'}
                      </Tag>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {formatDateTime(item.createdAt)}
                      </Text>
                    </div>
                    <div className="memory-body">{item.content}</div>
                  </div>
                ))
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    <span>
                      还没有记忆
                      <br />
                      试试说「我对海鲜过敏」
                    </span>
                  }
                />
              )}
            </div>
            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
              记忆只在当前沙盒患者下生效。真实环境里，记忆写入与删除都由患者授权。
            </Paragraph>
          </Card>
        </div>

        <Card variant="borderless" title="状态流转">
          <Steps
            current={currentStep}
            status={verification && verification.outcome !== 'verified' ? 'error' : 'process'}
            items={[
              { title: '客户消息', description: state?.messages.length ? '已收到' : '等待' },
              { title: '草稿生成', description: draft ? `v${draft.version}` : '等待' },
              { title: '推送顾问', description: draft ? '已推送' : '等待' },
              {
                title: '顾问确认',
                description: verification ? '已确认' : draft ? '待确认' : '等待',
              },
              {
                title: '核验',
                description: verification
                  ? SANDBOX_OUTCOME_LABELS[verification.outcome].label
                  : '等待',
              },
            ]}
          />
        </Card>
      </Space>

      <Modal
        open={guideOpen}
        title="3 分钟走通一次服务闭环"
        centered
        maskClosable={false}
        onCancel={() => setGuideOpen(false)}
        footer={[
          <Button key="skip" onClick={() => setGuideOpen(false)}>
            跳过
          </Button>,
          <Button
            key="start"
            type="primary"
            onClick={() => {
              saveGuideSeen();
              setGuideOpen(false);
            }}
          >
            开始体验
          </Button>,
        ]}
      >
        <Steps
          direction="vertical"
          size="small"
          current={-1}
          items={SANDBOX_GUIDE_STEPS.map((step) => ({
            title: step.title,
            description: step.hint,
          }))}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          这里不连接真实客户群，可以放心点击。
        </Text>
      </Modal>

      <Modal
        open={editOpen}
        title="改写后发送"
        okText="发送"
        cancelText="取消"
        onCancel={() => setEditOpen(false)}
        onOk={() => {
          setEditOpen(false);
          void runAction('send_edited', { editedBody });
        }}
      >
        <Input.TextArea
          rows={5}
          value={editedBody}
          onChange={(event) => setEditedBody(event.target.value)}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          改写后会生成新版本，核验结果为「改后发送」。
        </Text>
      </Modal>

      <Modal
        open={wrongOpen}
        title="发到别的群"
        okText="模拟发错"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onCancel={() => setWrongOpen(false)}
        onOk={() => {
          setWrongOpen(false);
          void runAction('send_wrong_group', { targetGroupId });
        }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Text>选择要发错的群：</Text>
          <Select
            style={{ width: '100%' }}
            value={targetGroupId}
            onChange={setTargetGroupId}
            options={(sessionResponse?.session.groups ?? [])
              .filter((group) => group.role !== 'primary')
              .map((group) => ({ value: group.id, label: group.name }))}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            核验会比对实际群名，结果标记为「发错群」。
          </Text>
        </Space>
      </Modal>
    </PageContainer>
  );
}
