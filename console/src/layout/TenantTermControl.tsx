import { SettingOutlined } from '@ant-design/icons';
import { App, Button, Input, Modal, Select, Space, Tooltip, Typography } from 'antd';
import { useState } from 'react';

import { useAuth } from '../auth/AuthContext.tsx';
import {
  isValidPatientTerm,
  PATIENT_TERM_MAX_LENGTH,
  PATIENT_TERMS,
  type PatientTerm,
} from '../types.ts';

/**
 * 顶栏称谓控制：
 * - 下拉用于在常用称谓之间快速切换；
 * - 齿轮打开自定义弹窗，机构可以填「亲人」「家人」「长者」等自己的叫法。
 * 保存走 PATCH /tenant，前端全局文案与 Agent 提示词立即同步。
 */
export function TenantTermControl() {
  const { tenant, session, updateTenant } = useAuth();
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState('');

  if (!tenant) return null;

  const canEdit = session?.account.role === 'admin';

  const save = async (value: PatientTerm, successText?: string) => {
    setSaving(true);
    try {
      await updateTenant({ patientTerm: value });
      message.success(successText ?? `称谓已切换为「${value}」，菜单与页面文案已同步`);
      return true;
    } catch (error) {
      message.error(error instanceof Error ? error.message : '称谓更新失败');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const openCustom = () => {
    setDraft(tenant.patientTerm);
    setCustomOpen(true);
  };

  const saveCustom = async () => {
    const value = draft.trim();
    if (!isValidPatientTerm(value)) {
      message.warning(`称谓需要 1–${PATIENT_TERM_MAX_LENGTH} 个字符`);
      return;
    }
    if (value === tenant.patientTerm) {
      setCustomOpen(false);
      return;
    }
    const ok = await save(value, `称谓已改为「${value}」，菜单、页面与 Agent 提示词已同步`);
    if (ok) setCustomOpen(false);
  };

  return (
    <>
      <Space size={6} className="term-control">
        <Tooltip title={canEdit ? '自定义称谓' : '只有机构管理员可以修改称谓'}>
          <Button
            type="text"
            size="small"
            className="term-control-gear"
            icon={<SettingOutlined />}
            onClick={openCustom}
            disabled={!canEdit || saving}
            aria-label="自定义服务对象称谓"
          />
        </Tooltip>
        <span className="term-control-label">称谓</span>
        <Select<PatientTerm>
          size="small"
          value={tenant.patientTerm}
          options={PATIENT_TERMS.map((value) => ({ value, label: value }))}
          onChange={(value) => void save(value)}
          disabled={!canEdit || saving}
          loading={saving}
          popupMatchSelectWidth={80}
          aria-label="切换服务对象称谓"
        />
      </Space>

      <Modal
        title="自定义称谓"
        open={customOpen}
        onCancel={() => setCustomOpen(false)}
        onOk={() => void saveCustom()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        okButtonProps={{ disabled: !isValidPatientTerm(draft) }}
        destroyOnHidden
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            菜单、页面文案和 Agent 提示词都会使用这个称呼，例如「亲人」「家人」「长者」。
          </Typography.Text>
          <Input
            value={draft}
            maxLength={PATIENT_TERM_MAX_LENGTH}
            showCount
            autoFocus
            placeholder="例如：亲人、家人、长辈"
            onChange={(event) => setDraft(event.target.value)}
            onPressEnter={() => void saveCustom()}
            aria-label="自定义称谓输入"
          />
          <Space size={[6, 8]} wrap>
            <Typography.Text type="secondary">常用：</Typography.Text>
            {PATIENT_TERMS.map((term) => (
              <Button key={term} size="small" onClick={() => setDraft(term)}>
                {term}
              </Button>
            ))}
          </Space>
        </Space>
      </Modal>
    </>
  );
}
