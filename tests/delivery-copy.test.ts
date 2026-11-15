import test from 'node:test';
import assert from 'node:assert/strict';

import { deliveryEmptyText } from '../console/src/pages/service-flow/delivery.ts';

test('实发正文空态：没发的草稿才说「尚未发送」', () => {
  assert.equal(deliveryEmptyText('QUEUED'), '尚未发送，没有实发正文。');
  assert.equal(deliveryEmptyText('PUSHED'), '尚未发送，没有实发正文。');
  assert.equal(deliveryEmptyText('ACKNOWLEDGED'), '尚未发送，没有实发正文。');
});

test('实发正文空态：已发送但取不到存档原文，不说成没发', () => {
  for (const status of ['VERIFIED', 'EDIT_SENT', 'MISROUTE_ALERT', 'UNVERIFIED']) {
    const text = deliveryEmptyText(status);
    assert.equal(text.startsWith('尚未发送'), false, status);
  }
  // 只有发错群那条能说「本群没有实发正文」
  for (const status of ['VERIFIED', 'EDIT_SENT', 'UNVERIFIED']) {
    assert.equal(deliveryEmptyText(status).includes('没有实发正文'), false, status);
  }
});

test('实发正文空态：改后发送说明是存档确认过发言', () => {
  assert.match(deliveryEmptyText('EDIT_SENT'), /存档确认/);
  assert.match(deliveryEmptyText('UNVERIFIED'), /没有找到对应正文/);
  assert.match(deliveryEmptyText('MISROUTE_ALERT'), /别的群/);
});
