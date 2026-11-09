import { LockOutlined, SafetyCertificateOutlined, ThunderboltOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Form, Input, Spin, Tag, Typography } from 'antd';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useState } from 'react';

import { useAuth } from '../../auth/AuthContext.tsx';
import { MOCK_PASSWORD, isMockMode } from '../../mock/api.ts';

const { Paragraph, Text, Title } = Typography;

interface LoginForm {
  username: string;
  password: string;
}

export function LoginPage() {
  const { session, loading, signIn } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from || '/dashboard';

  if (loading) {
    return (
      <div className="app-loading">
        <Spin size="large" tip="正在检查登录状态…" />
      </div>
    );
  }

  if (session) return <Navigate to={from} replace />;

  const handleSubmit = async (values: LoginForm) => {
    setSubmitting(true);
    setError(null);
    try {
      await signIn(values.username, values.password);
      message.success('登录成功');
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <section className="login-brand">
        <div className="login-brand-inner">
          <div className="brand-mark brand-mark-large">知</div>
          <Title level={1} className="login-title">
            知伴健康 Agent
          </Title>
          <Paragraph className="login-subtitle">
            让健康管理团队的每一次回复，都有依据、可核验、能复盘。
          </Paragraph>
          <ul className="login-features">
            <li>
              <ThunderboltOutlined />
              <span>服务流实时可见，草稿从生成到核验一条线</span>
            </li>
            <li>
              <SafetyCertificateOutlined />
              <span>健康红线前置校验，风险分级交给顾问决定</span>
            </li>
            <li>
              <LockOutlined />
              <span>会话存档只处理服务群，正文不落日志</span>
            </li>
          </ul>
          <Text className="login-brand-footnote">P1 演示环境 · 所有数据均为虚构</Text>
        </div>
      </section>

      <section className="login-panel">
        <Card className="login-card" variant="borderless">
          <div className="login-card-head">
            <Title level={3} style={{ marginBottom: 4 }}>
              登录控制台
            </Title>
            <Text type="secondary">使用机构管理员分配的账号登录</Text>
          </div>

          {isMockMode ? (
            <Alert
              className="login-demo-hint"
              type="info"
              showIcon
              message={
                <span>
                  演示模式：账号 <Tag bordered={false}>admin</Tag> / 密码{' '}
                  <Tag bordered={false}>{MOCK_PASSWORD}</Tag>
                </span>
              }
              description="也可以使用 supervisor / viewer 体验不同角色。"
            />
          ) : null}

          {error ? (
            <Alert className="login-error" type="error" showIcon message={error} />
          ) : null}

          <Form<LoginForm>
            layout="vertical"
            size="large"
            initialValues={{ username: 'admin', password: isMockMode ? MOCK_PASSWORD : '' }}
            onFinish={(values) => void handleSubmit(values)}
            requiredMark={false}
          >
            <Form.Item
              label="用户名"
              name="username"
              rules={[{ required: true, message: '请输入用户名' }]}
            >
              <Input prefix={<UserOutlined />} placeholder="admin" autoComplete="username" />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password
                prefix={<LockOutlined />}
                placeholder="请输入密码"
                autoComplete="current-password"
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={submitting}>
              登录
            </Button>
          </Form>

          <div className="login-card-foot">
            <Text type="secondary">登录即表示同意机构的数据使用与隐私规范。</Text>
          </div>
        </Card>
      </section>
    </div>
  );
}
