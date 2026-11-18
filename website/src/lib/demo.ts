export interface DemoRequestInput {
  orgName: string;
  contactName: string;
  contact: string;
  topic?: string;
}

export type DemoField = keyof DemoRequestInput;

export type FieldErrors = Partial<Record<DemoField, string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9][0-9\-\s]{7,19}$/;
const WECHAT = /^[a-zA-Z][a-zA-Z0-9_-]{3,29}$/;

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 联系方式允许手机、邮箱或微信号（issue #217）。 */
export function isContact(value: string): boolean {
  return EMAIL.test(value) || PHONE.test(value) || WECHAT.test(value);
}

export function validateDemoRequest(raw: Record<string, unknown>): { data: DemoRequestInput; errors: FieldErrors } {
  const data: DemoRequestInput = {
    orgName: normalize(raw.orgName),
    contactName: normalize(raw.contactName),
    contact: normalize(raw.contact),
    topic: normalize(raw.topic),
  };
  const errors: FieldErrors = {};

  if (!data.orgName) errors.orgName = '请填写机构名称';
  else if (data.orgName.length > 80) errors.orgName = '机构名称请控制在 80 个字以内';

  if (!data.contactName) errors.contactName = '请填写联系人';
  else if (data.contactName.length > 40) errors.contactName = '联系人请控制在 40 个字以内';

  if (!data.contact) errors.contact = '请填写联系方式';
  else if (data.contact.length > 120) errors.contact = '联系方式过长，请简化后重试';
  else if (!isContact(data.contact)) errors.contact = '请填写手机号、邮箱或微信号';

  if (data.topic && data.topic.length > 500) errors.topic = '问题描述请控制在 500 个字以内';

  return { data, errors };
}
