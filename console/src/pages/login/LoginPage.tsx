import { LockOutlined, QrcodeOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, App, Button, Form, Input, Spin, Tag } from 'antd';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';

import { useAuth } from '../../auth/AuthContext.tsx';
import loginPhoto from '../../assets/login-dusk.jpg';
import logoUrl from '../../assets/zhiban-logo.png';
import { getWecomQrUrl, MOCK_PASSWORD, isMockMode } from '../../mock/api.ts';

interface LoginForm {
  username: string;
  password: string;
}

/** 企微扫码回调的失败原因（`/login?wecom=`），文案要能指导下一步动作 */
const WECOM_FAILURES: Record<string, string> = {
  scope: '企业微信账号不在「知伴顾问助手」的可见范围内，请联系管理员开通后再试。',
  unbound:
    '企业微信身份已确认，但还没有绑定控制台账号。请先用账号密码登录，在「设置 · 账号与角色」里扫码绑定；或联系管理员开通。',
  disabled: '控制台账号已停用，请联系管理员。',
  state: '登录链接已失效，请重新点击「企业微信扫码登录」。',
  unavailable: '企业微信登录暂时不可用，请稍后重试，或使用账号密码登录。',
};

export function LoginPage() {
  const { session, loading, signIn } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wecomAvailable, setWecomAvailable] = useState(false);
  const [wecomPending, setWecomPending] = useState(false);

  const from = (location.state as { from?: string } | null)?.from || '/dashboard';
  const wecomParam = searchParams.get('wecom');
  const wecomError = wecomParam ? (WECOM_FAILURES[wecomParam] ?? WECOM_FAILURES.unavailable!) : null;

  // 入口显隐看后端是否配置了企微凭据；本地 dev / mock 模式一律不展示
  useEffect(() => {
    let cancelled = false;
    getWecomQrUrl(from).then((url) => {
      if (!cancelled) setWecomAvailable(url !== null);
    });
    return () => {
      cancelled = true;
    };
  }, [from]);

  const dismissWecomError = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('wecom');
    setSearchParams(next, { replace: true });
  };

  // state 只有 5 分钟有效：点击时重新取一次 URL，避免用挂载时的旧链接
  const handleWecom = async () => {
    setWecomPending(true);
    setError(null);
    const url = await getWecomQrUrl(from);
    if (!url) {
      setWecomPending(false);
      setError(WECOM_FAILURES.unavailable!);
      return;
    }
    window.location.assign(url);
  };

  if (loading) {
    return (
      <div className="app-loading">
        <Spin size="large" />
        <div style={{ marginTop: 12, color: '#64748b' }}>正在检查登录状态…</div>
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
    <div className="login-scene">
      <img className="login-photo" src={loginPhoto} alt="" aria-hidden="true" />
      <div className="login-scrim" aria-hidden="true" />

      <div className="login-shell">
        <header className="login-top">
          <img className="login-logo" src={logoUrl} alt="知伴健康 Agent" />
        </header>

        <main className="login-grid">
          <section className="login-copy">
            <p className="login-dateline">
              <span className="login-dot" aria-hidden="true" />
              管理控制台
            </p>
            <h1 className="login-headline">
              每一次回复，
              <br />
              都有依据。
            </h1>
            <p className="login-lede">
              让团队的每一次回复都留下依据，可核验、能复盘。
            </p>
            <p className="login-note">
              <span>服务流实时可见</span>
              <span className="login-sep" aria-hidden="true" />
              <span>健康红线前置校验</span>
              <span className="login-sep" aria-hidden="true" />
              <span>正文不落日志</span>
            </p>
          </section>

          <section className="login-panel">
            <div className="login-card">
              <div className="login-card-head">
                <h2 className="login-card-title">登录控制台</h2>
                <p className="login-card-sub">
                  {wecomAvailable ? '企业微信扫码，或使用管理员分配的账号' : '使用机构管理员分配的账号登录'}
                </p>
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

              {wecomError ? (
                <Alert
                  className="login-notice"
                  type="warning"
                  showIcon
                  closable
                  onClose={dismissWecomError}
                  message={wecomError}
                />
              ) : null}

              {error ? (
                <Alert className="login-error" type="error" showIcon message={error} />
              ) : null}

              {wecomAvailable ? (
                <>
                  <Button
                    className="login-wecom"
                    size="large"
                    block
                    icon={<QrcodeOutlined />}
                    loading={wecomPending}
                    onClick={() => void handleWecom()}
                  >
                    企业微信扫码登录
                  </Button>
                  <div className="login-divider" aria-hidden="true">
                    <span>或使用账号密码</span>
                  </div>
                </>
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

              <div className="login-card-foot">登录即表示同意机构的数据使用与隐私规范。</div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
