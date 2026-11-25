/**
 * 患者端 H5 本地预览服务（开发工具，不参与生产部署）。
 *
 * 把**真实的** `zhiban-patient-h5` HTTP 层（含真实领域逻辑：邀请兑换、会话、
 * 分项授权、建档校验）挂到一个普通 node:http 服务上，配内存存储与 mock 短信，
 * 让 `npm run dev` 的 Vite 能直接代理过来点完整流程。
 *
 * 与生产环境的差别（刻意为之，不能据此宣称真机通过）：
 * - 存储是内存的，重启即清空
 * - 短信是 mock，验证码固定 000000，只在控制台打印
 * - 患者档案是写死的虚构数据（不接 zhiban-patient）
 * - 计划/日历/记录/跟进/提醒/内容域尚未实现（PH5-04 起），页面显示占位
 *
 * 用法：
 *   node patient-h5/dev-server.ts          # 默认 :3080
 *   PORT=3081 node patient-h5/dev-server.ts
 */
import http from 'node:http';

import { idFactory } from '../src/p1/ids.ts';
import {
  MOCK_SMS,
  MemoryH5Backend,
  PatientH5Service,
} from '../src/p1/patient-h5.ts';
import { MemoryProfileBackend, ProfileService } from '../src/p1/patient-h5-profile.ts';
import { registerPatientH5Http } from '../plugins/zhiban-patient-h5/http.ts';
import type { H5HttpRequest, H5HttpResponse } from '../plugins/zhiban-patient-h5/http.ts';
import { createProfileRoutes } from '../plugins/zhiban-patient-h5/routes/profile.ts';

const TENANT = 'tn_demo';
const PORT = Number(process.env.PORT ?? 3080);
/** Vite 开发地址，只用于打印可点的邀请链接 */
const H5_BASE = process.env.H5_BASE ?? 'http://127.0.0.1:5174';

/** 虚构患者：演示数据，不对应任何真实个人 */
const DEMO_PATIENTS = new Map<
  string,
  { status: string; displayName: string; advisorId?: string }
>([
  ['pat_demo', { status: 'serving', displayName: '演示患者（虚构）', advisorId: 'adv_demo' }],
]);

function log(line: string): void {
  process.stdout.write(`[patient-h5-preview] ${line}\n`);
}

const backend = new MemoryH5Backend();
const service = new PatientH5Service({
  tenantId: TENANT,
  backend,
  sms: MOCK_SMS,
  loadPatient: (id) => DEMO_PATIENTS.get(id),
  ids: idFactory(Date.now),
  patientLoginMode: 'invite_then_phone',
  retentionNotice: '本地预览：内存存储，重启即清空',
});

const profile = new ProfileService({
  backend: new MemoryProfileBackend(),
  tenantId: TENANT,
  ids: idFactory(Date.now),
});

/** 收集插件注册的处理器（与 DSH webServer.register 的接口一致） */
const routes: Array<{ path: string; handler: (req: H5HttpRequest, res: H5HttpResponse) => unknown }> =
  [];
registerPatientH5Http(
  {
    register: (route) => {
      routes.push(route as unknown as (typeof routes)[number]);
      return undefined;
    },
  },
  {
    service,
    allowedOrigins: [H5_BASE],
    // 本地 http 预览：Cookie 不带 Secure，否则浏览器不会保存
    cookieSecure: false,
    log,
    extensions: createProfileRoutes({ profile }),
    composeMe: (view) => ({
      status: profile.meStatus(view.session.patientId, view.patient.status),
      profile: profile.status(view.session.patientId),
    }),
  },
);

const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  const route = routes.find((item) => path === item.path || path.startsWith(`${item.path}/`));
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: '接口不存在' } }));
    return;
  }
  void Promise.resolve(
    route.handler(req as unknown as H5HttpRequest, res as unknown as H5HttpResponse),
  ).catch((error: unknown) => {
    log(`请求失败：${error instanceof Error ? error.name : 'UNKNOWN'}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL', message: '服务暂时不可用' } }));
    }
  });
});

await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));

// 启动即发一张可用邀请，打印可点的链接（24 小时内有效）
const invitation = await service.createInvitation({
  patientId: 'pat_demo',
  advisorId: 'adv_demo',
  phone: '13800000000',
  ttlHours: 24,
  note: '本地预览邀请',
  createdBy: 'acc_demo',
});

log(`接口已监听 http://127.0.0.1:${PORT}/zhiban/h5`);
log(`演示患者：pat_demo（虚构）· 预绑定手机号 13800000000`);
log(`验证码固定：000000（mock 短信，不会真实发送）`);
log(`邀请链接（24h 内有效）：${H5_BASE}/h5/invite?code=${invitation.code}`);
log(`另开一个终端启动前端：cd patient-h5 && npm run dev`);
