import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyChronicPatch,
  emptyChronicProfile,
  formatMeasurementValue,
  validateChronicPatch,
  validateChronicRecord,
} from '../src/p1/chronic.ts';
import { buildChronicToolDefinitions } from '../src/p1/chronic-tools.ts';

const NOW = Date.parse('2026-11-11T10:00:00+08:00');

test('慢病补丁：血压必须成对、时间不能来自未来', () => {
  const valid = validateChronicPatch(
    {
      conditions: ['高血压', '高血压', ' 2 型糖尿病 '],
      measurements: [{ metric: 'bp', value: 138, secondaryValue: 86 }],
    },
    NOW,
  );
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.deepEqual(valid.value.conditions, ['高血压', '2 型糖尿病']);
  assert.equal(valid.value.measurements?.[0]?.measuredAt, NOW);

  const missingDiastolic = validateChronicPatch(
    { measurements: [{ metric: 'bp', value: 138 }] },
    NOW,
  );
  assert.equal(missingDiastolic.ok, false);

  const reversed = validateChronicPatch(
    { measurements: [{ metric: 'bp', value: 80, secondaryValue: 120 }] },
    NOW,
  );
  assert.equal(reversed.ok, false);

  const future = validateChronicPatch(
    {
      measurements: [
        { metric: 'glucose', value: 6.1, measuredAt: NOW + 3_600_000 },
      ],
    },
    NOW,
  );
  assert.equal(future.ok, false);

  const empty = validateChronicPatch({}, NOW);
  assert.equal(empty.ok, false);
});

test('慢病档案：写入来源可区分，体征按测量时间倒序', () => {
  const profile = emptyChronicProfile('pat_1', 'tn_test');
  const advisorPatch = validateChronicPatch(
    {
      conditions: ['高血压'],
      heightCm: 165,
      weightKg: 62,
      medications: [{ name: '虚构降压药', dose: '5 mg', frequency: '每日一次' }],
      measurements: [
        { metric: 'bp', value: 132, secondaryValue: 84, measuredAt: NOW - 86_400_000 },
      ],
    },
    NOW,
  );
  assert.equal(advisorPatch.ok, true);
  if (!advisorPatch.ok) return;

  let seq = 0;
  const afterAdvisor = applyChronicPatch(profile, advisorPatch.value, {
    now: NOW,
    actor: { id: 'acc_1', name: '李顾问', source: 'advisor' },
    nextMeasurementId: () => `cme_${++seq}`,
  });
  assert.equal(afterAdvisor.medications[0]?.source, 'advisor');
  assert.equal(afterAdvisor.measurements[0]?.recordedBy, '李顾问');

  const agentPatch = validateChronicRecord(
    {
      measurements: [{ metric: 'glucose', value: 7.1, context: '餐后 2 小时' }],
    },
    NOW,
  );
  assert.equal(agentPatch.ok, true);
  if (!agentPatch.ok) return;
  const afterAgent = applyChronicPatch(afterAdvisor, agentPatch.value, {
    now: NOW + 60_000,
    actor: { name: 'Agent', source: 'agent' },
    nextMeasurementId: () => `cme_${++seq}`,
  });

  assert.equal(afterAgent.measurements[0]?.metric, 'glucose');
  assert.equal(afterAgent.measurements[0]?.source, 'agent');
  assert.equal(afterAgent.measurements[1]?.metric, 'bp');
  assert.equal(formatMeasurementValue(afterAgent.measurements[1]!), '132/84 mmHg');
});

test('Agent 工具：只接受结构化明确数值', async () => {
  const calls: Array<{ sessionId: string; input: unknown }> = [];
  const [tool] = buildChronicToolDefinitions({
    chronicRecordWrite: (sessionId, input) => {
      calls.push({ sessionId, input });
      return { savedMeasurements: 1, savedConditions: 0, savedNotes: false, sandbox: false };
    },
  });
  assert.equal(tool?.name, 'chronic_record_write');

  await tool!.execute(
    { measurements: [{ metric: 'bp', value: 136, secondaryValue: 88 }] },
    { agent: { id: 'sess_1' } },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.sessionId, 'sess_1');

  await assert.rejects(
    () =>
      tool!.execute(
        { measurements: [{ metric: 'bp', value: 136 }] },
        { agent: { id: 'sess_1' } },
      ),
    /INVALID_TOOL_ARGS/,
  );
  await assert.rejects(() => tool!.execute({}, { agent: { id: 'sess_1' } }), /INVALID_TOOL_ARGS/);
});
