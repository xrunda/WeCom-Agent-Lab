import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { App, Button, Col, Empty, Input, Row, Select, Space, Spin, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAuth, useTerm } from '../../auth/AuthContext.tsx';
import { listAdvisors, type Advisor } from '../../mock/advisors.ts';
import { isMockMode } from '../../mock/http.ts';
import { listPatients, type Patient } from '../../mock/patients.ts';
import { AgentDrawer } from './AgentDrawer.tsx';
import { PatientCard } from './PatientCard.tsx';
import './patients.css';

const { Text } = Typography;

export default function PatientsPage() {
  const term = useTerm();
  const { can } = useAuth();
  const { message } = App.useApp();

  const [keyword, setKeyword] = useState('');
  const [tag, setTag] = useState<string | undefined>();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [advisors, setAdvisors] = useState<Advisor[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // 标签选项只来自当前真实数据，避免把示例数据里的标签混进筛选器
  const tags = useMemo(() => {
    const values = new Set<string>();
    for (const item of patients) for (const itemTag of item.tags) values.add(itemTag);
    if (tag) values.add(tag);
    return [...values].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [patients, tag]);
  const advisorById = useMemo(() => new Map(advisors.map((item) => [item.id, item])), [advisors]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([listPatients({ q: keyword, tag }), listAdvisors()])
      .then(([page, advisorList]) => {
        if (cancelled) return;
        setPatients(page.items);
        setAdvisors(advisorList);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        message.error(error instanceof Error ? error.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [keyword, tag, refreshKey, message]);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  return (
    <PageContainer
      header={{
        title: `${term} Agent`,
        subTitle: `一人一 Agent：查看${term}的记忆、计划与全部办事记录。`,
      }}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space wrap size={12} style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space wrap size={12}>
            <Input.Search
              allowClear
              placeholder={`搜索${term}备注名或标签`}
              prefix={<SearchOutlined />}
              style={{ width: 280 }}
              onSearch={(value) => setKeyword(value.trim())}
              onChange={(event) => {
                if (!event.target.value) setKeyword('');
              }}
            />
            <Select
              allowClear
              placeholder="按标签筛选"
              style={{ minWidth: 180 }}
              value={tag}
              options={tags.map((item) => ({ label: item, value: item }))}
              onChange={setTag}
            />
          </Space>
          <Space>
            <Text type="secondary">共 {patients.length} 位</Text>
            <Button icon={<ReloadOutlined />} onClick={refresh}>
              刷新
            </Button>
          </Space>
        </Space>

        {loading ? (
          <div style={{ padding: '64px 0', textAlign: 'center' }}>
            <Spin tip="正在加载患者 Agent…" />
          </div>
        ) : patients.length === 0 ? (
          <Empty description={`没有匹配的${term}`} />
        ) : (
          <Row gutter={[16, 16]}>
            {patients.map((patient) => (
              <Col key={patient.id} xs={24} sm={12} lg={8} xxl={6}>
                <PatientCard
                  patient={patient}
                  term={term}
                  online={Boolean(advisorById.get(patient.advisorId ?? '')?.online)}
                  advisorName={advisorById.get(patient.advisorId ?? '')?.name ?? '未分配'}
                  onOpen={() => setActiveId(patient.id)}
                />
              </Col>
            ))}
          </Row>
        )}

        <Text type="secondary" style={{ fontSize: 12 }}>
          {can('patient.write')
            ? '记忆与计划支持编辑，所有变更都会写入审计日志。'
            : '当前角色为只读，记忆与计划不可编辑。'}
          {!isMockMode ? ' 列表与详情来自企微会话存档，不是虚构样例。' : null}
          {patients.some((item) => item.demo) ? (
            <span>
              {' '}
              标记 <Tag bordered={false}>演示环境</Tag> 的记录产生于演示环境，请勿作为生产数据。
            </span>
          ) : null}
        </Text>
      </Space>

      <AgentDrawer
        patientId={activeId}
        term={term}
        onClose={() => setActiveId(null)}
        onChanged={refresh}
      />
    </PageContainer>
  );
}
