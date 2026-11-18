import { describe, expect, it } from 'vitest';

import { isContact, validateDemoRequest } from '../src/lib/demo';

describe('预约表单校验', () => {
  it('三个必填项缺失时给出对应错误', () => {
    const { errors } = validateDemoRequest({});
    expect(errors.orgName).toBe('请填写机构名称');
    expect(errors.contactName).toBe('请填写联系人');
    expect(errors.contact).toBe('请填写联系方式');
  });

  it('联系方式支持手机、邮箱、微信号', () => {
    expect(isContact('13800138000')).toBe(true);
    expect(isContact('hello@example.com')).toBe(true);
    expect(isContact('wxid_demo01')).toBe(true);
    expect(isContact('!!')).toBe(false);
  });

  it('去除首尾空白后再校验', () => {
    const { data, errors } = validateDemoRequest({
      orgName: '  示例机构  ',
      contactName: ' 陈顾问 ',
      contact: ' 13800138000 ',
    });
    expect(errors).toEqual({});
    expect(data.orgName).toBe('示例机构');
    expect(data.contactName).toBe('陈顾问');
    expect(data.contact).toBe('13800138000');
  });

  it('超长问题描述被拒绝', () => {
    const { errors } = validateDemoRequest({
      orgName: '示例机构',
      contactName: '陈顾问',
      contact: '13800138000',
      topic: 'x'.repeat(501),
    });
    expect(errors.topic).toBe('问题描述请控制在 500 个字以内');
  });
});
