import { describe, expect, it } from 'vitest';

import {
  draftRiskLabel,
  keywordsForRules,
  matchKeywords,
  parseDraftAlert,
  parseStaffAlert,
  splitByKeywords,
} from '../src/pages/alerts/alert-text.ts';

const MESSAGE =
  '群「糖友-张女士」李顾问的发言命中规则：不诊断、不调药。' +
  '发言内容：「不用去医院确诊了，您这就是糖尿病，二甲双胍直接加量到每天两片。」';

describe('员工发言告警拆解', () => {
  it('拆出群名、发言人、命中规则与发言原文', () => {
    const parts = parseStaffAlert(MESSAGE);
    expect(parts.groupName).toBe('糖友-张女士');
    expect(parts.senderName).toBe('李顾问');
    expect(parts.rules).toEqual(['不诊断', '不调药']);
    expect(parts.hasQuote).toBe(true);
    expect(parts.quote).toBe('不用去医院确诊了，您这就是糖尿病，二甲双胍直接加量到每天两片。');
  });

  it('正文被截断、没有收尾引号时退回整条正文，不丢内容', () => {
    const truncated =
      '群「糖友-张女士」李顾问的发言命中规则：不诊断。发言内容：「不用去医院确诊了，您这就是糖尿病';
    const parts = parseStaffAlert(truncated);
    expect(parts.hasQuote).toBe(false);
    expect(parts.quote).toBe(truncated);
    expect(parts.senderName).toBe('李顾问');
    expect(parts.rules).toEqual(['不诊断']);
  });

  it('不是员工发言格式时按普通文本处理', () => {
    const parts = parseStaffAlert('草稿涉及急症信号，已标为高风险，需人工确认');
    expect(parts.groupName).toBeUndefined();
    expect(parts.senderName).toBeUndefined();
    expect(parts.rules).toEqual([]);
    expect(parts.hasQuote).toBe(false);
  });
});

describe('草稿红线告警拆解', () => {
  it('拆出命中规则与风险等级', () => {
    const parts = parseDraftAlert('命中规则：不诊断、不调药；风险等级 high');
    expect(parts.rules).toEqual(['不诊断', '不调药']);
    expect(parts.riskLevel).toBe('high');
    expect(draftRiskLabel(parts.riskLevel)).toBe('高');
  });

  it('没有等级或格式不符时只返回能确认的部分，不编造', () => {
    expect(parseDraftAlert('命中规则：不诊断')).toEqual({ rules: ['不诊断'] });
    expect(parseDraftAlert('草稿涉及急症信号')).toEqual({ rules: [] });
    expect(draftRiskLabel(undefined)).toBeUndefined();
  });
});

describe('关键词高亮', () => {
  it('只返回原文里真实出现过的关键词，忽略大小写并去重', () => {
    expect(matchKeywords('Aspirin 加量，别再换药了', ['加量', '换药', '停药', '加量'])).toEqual([
      '加量',
      '换药',
    ]);
    expect(matchKeywords('aspirin', ['ASPIRIN'])).toEqual(['ASPIRIN']);
  });

  it('按命中规则取关键词；规则名对不上时退回全部规则关键词', () => {
    const rules = [
      { name: '不调药', keywords: ['停药', '减药', '换药', '加量'] },
      { name: '不诊断', keywords: ['诊断', '确诊'] },
      { name: '不承诺疗效', keywords: ['根治'] },
    ];
    expect(keywordsForRules(['不诊断'], rules)).toEqual(['诊断', '确诊']);
    expect(keywordsForRules(['已删除的规则'], rules)).toEqual([
      '停药',
      '减药',
      '换药',
      '加量',
      '诊断',
      '确诊',
      '根治',
    ]);
    expect(keywordsForRules([], rules)).toEqual([
      '停药',
      '减药',
      '换药',
      '加量',
      '诊断',
      '确诊',
      '根治',
    ]);
  });

  it('高亮片段拼回去与原文一致', () => {
    const segments = splitByKeywords('二甲双胍直接加量到每天两片', ['加量']);
    expect(segments.map((segment) => segment.text).join('')).toBe('二甲双胍直接加量到每天两片');
    expect(segments.filter((segment) => segment.hit).map((segment) => segment.text)).toEqual([
      '加量',
    ]);
  });
});
