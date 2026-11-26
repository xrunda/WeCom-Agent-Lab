/**
 * 登录/邀请兑换页（PH5-02 #231，契约 api §2）。
 *
 * - 带一次性邀请码进入（?code= 已由 App 清理，仅存内存）→ 兑换并绑定
 * - 已绑定用户 → 手机号 + 验证码登录
 * - 失败分类提示：过期→联系顾问；手机号不匹配；短信未开通（真实登录阻塞）
 */
import { useState } from 'react';

import {
  ApiError,
  loginWithPhone,
  redeemInvitation,
  requestVerifyCode,
} from '../api.ts';
import { normalizePhone } from '../utils/phone.ts';

type Mode = 'form' | 'submitting';

interface Props {
  inviteCode: string | null;
  onDone: (usedInvite: boolean) => void;
}

export function InviteLoginPage({ inviteCode, onDone }: Props) {
  const [mode, setMode] = useState<Mode>('form');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [manualInviteCode, setManualInviteCode] = useState('');
  /** 邀请码默认收起：老用户只看到手机号+验证码两个框，少一层心理负担 */
  const [showInviteField, setShowInviteField] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);

  const effectiveInviteCode = inviteCode ?? (manualInviteCode.trim() || null);

  const startCountdown = (): void => {
    setCountdown(60);
    const timer = setInterval(() => {
      setCountdown((value) => {
        if (value <= 1) {
          clearInterval(timer);
          return 0;
        }
        return value - 1;
      });
    }, 1000);
  };

  /** 归一后的 11 位号码；带 +86 / 空格 / 短横线都能识别 */
  const normalizedPhone = normalizePhone(phone);

  const sendCode = async (): Promise<void> => {
    setError(null);
    setInfo(null);
    if (!normalizedPhone) {
      setError('请输入正确的手机号');
      return;
    }
    if (!inviteCode && !manualInviteCode.trim() && !phone) {
      setError('请填写邀请码或使用邀请链接进入');
      return;
    }
    try {
      const result = await requestVerifyCode(
        effectiveInviteCode
          ? { invitationCode: effectiveInviteCode }
          : { phone: normalizedPhone ?? phone },
      );
      setInfo(`验证码已发送至手机尾号 ${result.phoneTail}`);
      startCountdown();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(friendlyError(err));
      } else {
        setError('网络异常，请稍后再试');
      }
    }
  };

  const submit = async (): Promise<void> => {
    setError(null);
    setMode('submitting');
    try {
      if (effectiveInviteCode) {
        await redeemInvitation({
          invitationCode: effectiveInviteCode,
          phone: normalizedPhone ?? phone,
          code,
        });
        onDone(true);
      } else {
        await loginWithPhone({ phone: normalizedPhone ?? phone, code });
        onDone(false);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(friendlyError(err));
      } else {
        setError('网络异常，请稍后再试');
      }
      setMode('form');
    }
  };

  return (
    <div className="page page-center">
      <div className="brand">
        <div className="logo-mark" aria-hidden="true" />
        <h1 style={{ fontSize: 22, margin: 0 }}>知伴健康</h1>
        <div className="slogans" aria-label="服务主张">
          <span>饮食有养</span>
          <span>起居有常</span>
          <span>健康有伴</span>
        </div>
      </div>

      <div className="card">
        <h1>{effectiveInviteCode ? '开通个人服务' : '登录'}</h1>

        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        {info && (
          <div className="notice notice-ok" role="status">
            {info}
          </div>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {!inviteCode && showInviteField && (
            <div className="field">
              <label htmlFor="invite-code">邀请码</label>
              <input
                id="invite-code"
                value={manualInviteCode}
                onChange={(event) => setManualInviteCode(event.target.value.trim())}
                placeholder="顾问发你的邀请码"
                autoComplete="off"
                enterKeyHint="next"
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="phone">手机号</label>
            <input
              id="phone"
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value.trim())}
              inputMode="tel"
              autoComplete="tel"
              enterKeyHint="next"
              placeholder="请输入手机号"
            />
          </div>

          <div className="field">
            <label htmlFor="sms-code">验证码</label>
            <div className="row">
              <input
                id="sms-code"
                className="grow code-input"
                type="text"
                value={code}
                onChange={(event) => setCode(event.target.value.trim())}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                enterKeyHint="done"
                placeholder="6 位验证码"
              />
              <button
                type="button"
                className="btn btn-secondary btn-inline"
                onClick={() => void sendCode()}
                disabled={countdown > 0 || mode === 'submitting'}
              >
                {countdown > 0 ? `${countdown}s` : '获取验证码'}
              </button>
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={mode === 'submitting' || code.length < 6 || !normalizedPhone}
          >
            {mode === 'submitting' ? '正在验证…' : effectiveInviteCode ? '开通服务' : '登录'}
          </button>
        </form>

        <div className="login-foot">
          <span className="muted">收不到验证码？联系顾问</span>
          {!inviteCode && (
            <button
              type="button"
              className="link-btn"
              aria-expanded={showInviteField}
              onClick={() => setShowInviteField((value) => !value)}
            >
              {showInviteField ? '不用邀请码' : '用邀请码开通'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function friendlyError(error: ApiError): string {
  switch (error.code) {
    case 'INVITATION_EXPIRED':
      return '邀请已过期，请联系顾问重新发送。';
    case 'INVITATION_NOT_FOUND':
      return '邀请不存在或已使用，请联系顾问重新发送。';
    case 'PHONE_MISMATCH':
      return '手机号与邀请预留的不一致，请核对后重试。';
    case 'VERIFY_CODE_INVALID':
      return '验证码错误或已过期，请重新获取。';
    case 'SMS_UNAVAILABLE':
      return '短信通道尚未开通，真实登录暂不可用；演示环境请联系工作人员。';
    case 'RATE_LIMITED':
      return '尝试次数过多，请稍后再试。';
    case 'SERVICE_PAUSED':
      return '服务当前暂停，暂不能开通，请联系顾问。';
    case 'UNAUTHORIZED':
      return '手机号未开通，请先使用邀请链接进入。';
    default:
      return error.message || '操作失败，请稍后再试。';
  }
}
