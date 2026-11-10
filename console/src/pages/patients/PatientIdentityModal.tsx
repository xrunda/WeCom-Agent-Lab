import { App, Alert, Input, Modal, Radio, Select, Space, Spin, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';

import {
  CONSENT_LABELS,
  listGroupMembers,
  setPatientIdentity,
  type PatientDetail,
  type PatientGroupMember,
} from '../../mock/patients.ts';

const { Text } = Typography;

const ROLE_LABELS: Record<PatientGroupMember['role'], string> = {
  self: '本人',
  family: '家属',
  advisor: '顾问',
  colleague: '同事',
  unknown: '身份未知',
};

const ROLE_COLORS: Record<PatientGroupMember['role'], string> = {
  self: 'green',
  family: 'blue',
  advisor: 'purple',
  colleague: 'purple',
  unknown: 'default',
};

export interface PatientIdentityModalProps {
  open: boolean;
  detail: PatientDetail;
  term: string;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * 确认 / 改绑患者身份：在该患者绑定的服务群里选择一位外部成员作为「本人」。
 * 系统自动建档的患者可能绑错人，顾问可在这里核对并改绑。
 */
export function PatientIdentityModal({
  open,
  detail,
  term,
  onClose,
  onSaved,
}: PatientIdentityModalProps) {
  const { message } = App.useApp();
  const { patient, groups } = detail;

  const defaultGroupId = groups[0]?.id ?? '';
  const [groupId, setGroupId] = useState(defaultGroupId);
  const [members, setMembers] = useState<PatientGroupMember[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [nameOverride, setNameOverride] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // 打开时重置为当前患者身份
  useEffect(() => {
    if (!open) return;
    setGroupId(groups[0]?.id ?? '');
    setSelected(patient.externalUserId ?? undefined);
    setNameOverride('');
  }, [open, groups, patient.externalUserId]);

  useEffect(() => {
    if (!open || !groupId) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    listGroupMembers(groupId)
      .then((next) => {
        if (!cancelled) setMembers(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) message.error(error instanceof Error ? error.message : '成员加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, groupId, message]);

  const externalMembers = useMemo(() => members.filter((member) => member.isExternal), [members]);
  const selectedMember = externalMembers.find((member) => member.externalUserId === selected);

  const submit = async () => {
    if (!groupId) {
      message.warning('请选择服务群');
      return;
    }
    if (!selected) {
      message.warning(`请选择当前 Agent 对应的${term}`);
      return;
    }
    setSaving(true);
    try {
      await setPatientIdentity(patient.id, {
        groupId,
        externalUserId: selected,
        displayName: nameOverride.trim() || undefined,
      });
      message.success(`已确认${term}身份`);
      onSaved();
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const noGroup = groups.length === 0;

  return (
    <Modal
      open={open}
      title={`确认${term}身份`}
      okText="确认身份"
      cancelText="取消"
      confirmLoading={saving}
      okButtonProps={{ disabled: noGroup || !selected || loading }}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          每个 Agent 对应一位{term}。请核对服务群里哪位成员是{term}本人；改绑后，
          被选成员标为「本人」，原「本人」成员降为「家属」，存档同意状态跟随被选成员。
        </Text>

        {noGroup ? (
          <Alert
            type="warning"
            showIcon
            message="尚未绑定服务群"
            description={`该${term}没有关联的服务群，无法指定身份。请先在「服务群」页把群绑定到该${term}。`}
          />
        ) : (
          <>
            {groups.length > 1 ? (
              <div>
                <Text strong style={{ display: 'block', marginBottom: 6 }}>
                  服务群
                </Text>
                <Select
                  style={{ width: '100%' }}
                  value={groupId}
                  onChange={(value) => {
                    setGroupId(value);
                    setSelected(undefined);
                  }}
                  options={groups.map((group) => ({
                    label: `${group.name}${group.isPrimary ? '（主群）' : ''}`,
                    value: group.id,
                  }))}
                />
              </div>
            ) : null}

            <div>
              <Text strong style={{ display: 'block', marginBottom: 6 }}>
                选择{term}本人
              </Text>
              {loading ? (
                <div style={{ padding: '16px 0', textAlign: 'center' }}>
                  <Spin size="small" />
                </div>
              ) : externalMembers.length === 0 ? (
                <Alert
                  type="info"
                  showIcon
                  message="该群暂无外部成员"
                  description="存档里还没有识别到个人微信成员。等群里有新消息后再试，或在「服务群」页确认群状态。"
                />
              ) : (
                <Radio.Group
                  value={selected}
                  onChange={(event) => setSelected(event.target.value as string)}
                  style={{ width: '100%' }}
                >
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    {externalMembers.map((member) => (
                      <Radio
                        key={member.id}
                        value={member.externalUserId ?? undefined}
                        style={{ width: '100%', marginInlineStart: 0 }}
                      >
                        <Space size={8} wrap>
                          <Text>{member.displayName}</Text>
                          <Tag bordered={false} color={ROLE_COLORS[member.role]} className="tag-tight">
                            {ROLE_LABELS[member.role]}
                          </Tag>
                          <Tag bordered={false} className="tag-tight">
                            存档：{CONSENT_LABELS[member.consent]}
                          </Tag>
                          {member.externalUserIdTail ? (
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              尾号 {member.externalUserIdTail}
                            </Text>
                          ) : null}
                        </Space>
                      </Radio>
                    ))}
                  </Space>
                </Radio.Group>
              )}
            </div>

            <div>
              <Text strong style={{ display: 'block', marginBottom: 6 }}>
                备注名（可选）
              </Text>
              <Input
                value={nameOverride}
                onChange={(event) => setNameOverride(event.target.value)}
                placeholder={selectedMember ? `留空则使用「${selectedMember.displayName}」` : '留空则使用成员群昵称'}
                maxLength={40}
              />
            </div>
          </>
        )}
      </Space>
    </Modal>
  );
}
