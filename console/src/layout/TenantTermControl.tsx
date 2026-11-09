import { SettingOutlined } from '@ant-design/icons';
import { App, Select, Space, Tooltip } from 'antd';
import { useState } from 'react';

import { useAuth } from '../auth/AuthContext.tsx';
import { PATIENT_TERMS, type PatientTerm } from '../types.ts';

/**
 * 演示用称谓切换：契约里 PATCH /tenant 保存后前端全局文案立即生效。
 * 这里把它放在顶栏，便于验收「改成会员后菜单与页面同步变化」。
 * 正式的 Agent 设定页由 WP-L 实现。
 */
export function TenantTermControl() {
  const { tenant, session, updateTenant } = useAuth();
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);

  if (!tenant) return null;

  const canEdit = session?.account.role === 'admin';

  const handleChange = async (value: PatientTerm) => {
    setSaving(true);
    try {
      await updateTenant({ patientTerm: value });
      message.success(`称谓已切换为「${value}」，菜单与页面文案已同步`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '称谓更新失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Tooltip title={canEdit ? '演示设置：全局称谓' : '只有机构管理员可以修改称谓'}>
      <Space size={6} className="term-control">
        <SettingOutlined />
        <span className="term-control-label">称谓</span>
        <Select<PatientTerm>
          size="small"
          value={tenant.patientTerm}
          options={PATIENT_TERMS.map((value) => ({ value, label: value }))}
          onChange={handleChange}
          disabled={!canEdit || saving}
          loading={saving}
          popupMatchSelectWidth={72}
          aria-label="切换客户称谓"
        />
      </Space>
    </Tooltip>
  );
}
