import test from 'node:test';
import assert from 'node:assert/strict';

import { inject as careInject } from '../plugins/zhiban-care/index.ts';
import { inject as guardInject } from '../plugins/zhiban-guard/index.ts';
import { inject as memoryInject } from '../plugins/zhiban-memory/index.ts';
import { inject as patientInject } from '../plugins/zhiban-patient/index.ts';

const TOOL_PLUGINS: Record<string, readonly string[]> = {
  'zhiban-care': careInject,
  'zhiban-guard': guardInject,
  'zhiban-memory': memoryInject,
  'zhiban-patient': patientInject,
};

test('注册 ctx.tools 的插件必须声明 tools 注入', () => {
  // DSH 只把 inject 中声明的服务挂到插件上下文的属性上；
  // 漏声明时 apply 里的 ctx.tools 为 undefined，插件静默启动失败。
  for (const [name, inject] of Object.entries(TOOL_PLUGINS)) {
    assert.ok(inject.includes('tools'), `${name} 未声明 tools 注入`);
  }
});

test('zhiban-patient 同时需要 sessionController 与 storageDomain', () => {
  assert.ok(patientInject.includes('sessionController'));
  assert.ok(patientInject.includes('storageDomain'));
});
