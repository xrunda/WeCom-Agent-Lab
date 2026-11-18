import { useState } from 'react';

import { validateDemoRequest, type FieldErrors } from '../lib/demo';
import { Icon } from './Icons';

type Status = 'idle' | 'submitting' | 'success' | 'error';

const SUCCESS_TEXT = '已收到预约，我们会通过您留下的联系方式沟通演示时间。';
const ERROR_TEXT = '预约暂未提交成功，请稍后重试。';

export function DemoForm() {
  const [values, setValues] = useState({ orgName: '', contactName: '', contact: '', topic: '', website: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  const setField = (field: string, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    if (field in errors) {
      setErrors((current) => ({ ...current, [field]: undefined }));
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === 'submitting') return;

    const { errors: nextErrors } = validateDemoRequest(values);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setStatus('idle');
      setMessage('');
      return;
    }

    setStatus('submitting');
    setErrors({});
    setMessage('');
    try {
      const response = await fetch('/api/demo-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (response.ok) {
        setStatus('success');
        setMessage(SUCCESS_TEXT);
        return;
      }
      const payload = (await response.json().catch(() => null)) as
        | { error?: { fields?: FieldErrors } }
        | null;
      if (payload?.error?.fields) setErrors(payload.error.fields);
      setStatus('error');
      setMessage(ERROR_TEXT);
    } catch {
      setStatus('error');
      setMessage(ERROR_TEXT);
    }
  };

  if (status === 'success') {
    return (
      <div className="form-success" role="status" aria-live="polite">
        <span className="form-success__icon">
          <Icon name="check" size={26} />
        </span>
        <h3>预约已收到</h3>
        <p>{message}</p>
        <p className="form-success__hint">我们不会把您填写的信息用于其他用途。</p>
      </div>
    );
  }

  return (
    <form className="demo-form" onSubmit={submit} noValidate>
      <div className="form-grid">
        <label className={`field${errors.orgName ? ' has-error' : ''}`}>
          <span className="field__label">机构名称 <em>必填</em></span>
          <input
            type="text"
            name="orgName"
            value={values.orgName}
            onChange={(event) => setField('orgName', event.target.value)}
            maxLength={80}
            autoComplete="organization"
            aria-invalid={Boolean(errors.orgName)}
            aria-describedby={errors.orgName ? 'err-orgName' : undefined}
          />
          {errors.orgName ? <span className="field__error" id="err-orgName">{errors.orgName}</span> : null}
        </label>

        <label className={`field${errors.contactName ? ' has-error' : ''}`}>
          <span className="field__label">联系人 <em>必填</em></span>
          <input
            type="text"
            name="contactName"
            value={values.contactName}
            onChange={(event) => setField('contactName', event.target.value)}
            maxLength={40}
            autoComplete="name"
            aria-invalid={Boolean(errors.contactName)}
            aria-describedby={errors.contactName ? 'err-contactName' : undefined}
          />
          {errors.contactName ? <span className="field__error" id="err-contactName">{errors.contactName}</span> : null}
        </label>
      </div>

      <label className={`field${errors.contact ? ' has-error' : ''}`}>
        <span className="field__label">联系方式 <em>必填</em></span>
        <input
          type="text"
          name="contact"
          value={values.contact}
          onChange={(event) => setField('contact', event.target.value)}
          maxLength={120}
          inputMode="text"
          autoComplete="off"
          placeholder="手机号、邮箱或微信号"
          aria-invalid={Boolean(errors.contact)}
          aria-describedby={errors.contact ? 'err-contact' : undefined}
        />
        {errors.contact ? <span className="field__error" id="err-contact">{errors.contact}</span> : null}
      </label>

      <label className={`field${errors.topic ? ' has-error' : ''}`}>
        <span className="field__label">目前最想解决的问题 <em>选填</em></span>
        <textarea
          name="topic"
          rows={4}
          value={values.topic}
          onChange={(event) => setField('topic', event.target.value)}
          maxLength={500}
          aria-invalid={Boolean(errors.topic)}
          aria-describedby={errors.topic ? 'err-topic' : undefined}
        />
        {errors.topic ? <span className="field__error" id="err-topic">{errors.topic}</span> : null}
      </label>

      <label className="honeypot" aria-hidden="true">
        <span>公司网站</span>
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={values.website}
          onChange={(event) => setField('website', event.target.value)}
        />
      </label>

      <p className="form-hint">请填写商务联系信息，方便我们联系您。请勿填写客户姓名、健康日志或其他个人健康资料。</p>

      <button className="btn btn--primary form-submit" type="submit" disabled={status === 'submitting'}>
        {status === 'submitting' ? '正在提交…' : '提交预约'}
        {status === 'submitting' ? null : <Icon name="arrow" size={15} />}
      </button>

      {status === 'error' ? (
        <p className="form-error" role="alert">
          {message}
        </p>
      ) : null}
    </form>
  );
}
