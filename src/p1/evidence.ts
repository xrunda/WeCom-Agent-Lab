/**
 * #59 证据链与服务记录导出（数据装配）。
 *
 * 只做「取数 + 校验 + 排序」，不生成 PDF、不碰 HTTP：
 * PDF 渲染在 plugins/zhiban-console/pdf.ts，路由在 plugins/zhiban-console/index.ts。
 *
 * 数据来源：
 * - 草稿、版本、核验结果：C2 领域存储（经 zhibanWecomAdmin 只读入口）
 * - 客户原话、实发正文：会话存档（同一入口在插件内查询，失败时降级为空）
 * - 患者与群绑定：患者领域（经 zhibanPatient 只读入口）
 *
 * 安全：不打印任何消息正文；导出人只记录账号 id / 显示名。
 */
import { ConsoleError } from './console-error.ts';

export interface EvidenceRevision {
  version: number;
  body: string;
  instruction?: string;
  createdBy: 'agent' | 'staff';
  createdAt: number;
}

export interface EvidenceMessage {
  msgid: string;
  from: string;
  text: string;
  msgtime: number;
  msgtype?: string;
  /** 图片在本机的落盘路径；文字消息为空 */
  mediaPath?: string;
}

export interface EvidenceVerification {
  outcome: string;
  matchedMsgId?: string;
  matchedRoomId?: string;
  similarity?: number;
  checkedAt: number;
}

/** zhibanWecomAdmin 返回的单条草稿证据源 */
export interface EvidenceDraftSource {
  id: string;
  advisorId: string;
  advisorName?: string;
  groupRoomId: string;
  groupName: string;
  customerName: string;
  inboundSummary: string;
  inboundMessageIds: string[];
  mediaIds: string[];
  body: string;
  version: number;
  revisions: EvidenceRevision[];
  status: string;
  riskLevel: string;
  source?: string;
  fallback?: boolean;
  sentVersion?: number;
  verification?: EvidenceVerification;
  ackAction?: string;
  ackAt?: number;
  createdAt: number;
  pushedAt?: number;
  citedMemoryIds: string[];
  citedKnowledgeIds: string[];
  inbound: EvidenceMessage[];
  sent: { msgid: string; text: string; msgtime: number } | null;
}

export interface EvidenceBundle {
  tenantName: string;
  exportedBy: string;
  exportedAt: number;
  draft: EvidenceDraftSource;
}

export interface RecordsBundle {
  tenantName: string;
  exportedBy: string;
  exportedAt: number;
  patient: { id: string; displayName: string };
  groups: Array<{ id: string; name: string; roomId: string }>;
  from: number;
  to: number;
  records: EvidenceDraftSource[];
  truncated: boolean;
}

export interface EvidenceWecomPort {
  getDraftEvidence(draftId: string): Promise<EvidenceDraftSource | undefined>;
  listDraftsByRooms(
    roomIds: string[],
    from: number,
    to: number,
  ): Promise<EvidenceDraftSource[]>;
}

export interface EvidencePatientPort {
  getPatientGroups(patientId: string):
    | {
        patient: { id: string; displayName: string };
        groups: Array<{ id: string; name: string; roomId: string }>;
      }
    | undefined;
}

export interface EvidenceServiceOptions {
  tenantName: string;
  now?: () => number;
  wecom: () => EvidenceWecomPort | undefined;
  patient: () => EvidencePatientPort | undefined;
}

/** 单次导出最多包含的服务记录数：防止一次 PDF 过大拖垮浏览器与存储 */
export const RECORDS_LIMIT = 200;
/** 按患者导出默认时间窗：最近 30 天 */
export const RECORDS_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export class EvidenceService {
  private readonly options: EvidenceServiceOptions;
  private readonly now: () => number;

  constructor(options: EvidenceServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  private requireWecom(): EvidenceWecomPort {
    const port = this.options.wecom();
    if (!port || typeof port.getDraftEvidence !== 'function') {
      throw new ConsoleError('UPSTREAM_UNAVAILABLE', '企微插件未就绪，无法读取草稿证据');
    }
    return port;
  }

  async draftEvidence(draftId: string, exportedBy: string): Promise<EvidenceBundle> {
    if (typeof draftId !== 'string' || draftId.trim() === '') {
      throw new ConsoleError('VALIDATION_FAILED', '缺少草稿 id');
    }
    const source = await this.requireWecom().getDraftEvidence(draftId.trim());
    if (!source) throw new ConsoleError('NOT_FOUND', '草稿不存在');
    return {
      tenantName: this.options.tenantName,
      exportedBy,
      exportedAt: this.now(),
      draft: source,
    };
  }

  async patientRecords(
    patientId: string,
    exportedBy: string,
    range: { from?: number; to?: number } = {},
  ): Promise<RecordsBundle> {
    const patientPort = this.options.patient();
    if (!patientPort || typeof patientPort.getPatientGroups !== 'function') {
      throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者插件未就绪，无法读取服务记录');
    }
    const context = patientPort.getPatientGroups(patientId);
    if (!context) throw new ConsoleError('NOT_FOUND', '患者不存在');

    const now = this.now();
    const to = range.to ?? now;
    const from = range.from ?? to - RECORDS_DEFAULT_WINDOW_MS;
    if (from >= to) {
      throw new ConsoleError('VALIDATION_FAILED', 'from 必须早于 to');
    }

    if (context.groups.length === 0) {
      return {
        tenantName: this.options.tenantName,
        exportedBy,
        exportedAt: now,
        patient: context.patient,
        groups: [],
        from,
        to,
        records: [],
        truncated: false,
      };
    }

    const roomIds = context.groups.map((group) => group.roomId);
    const all = await this.requireWecom().listDraftsByRooms(roomIds, from, to);
    const records = all
      .filter((item) => roomIds.includes(item.groupRoomId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, RECORDS_LIMIT);

    return {
      tenantName: this.options.tenantName,
      exportedBy,
      exportedAt: now,
      patient: context.patient,
      groups: context.groups,
      from,
      to,
      records,
      truncated: all.length > RECORDS_LIMIT,
    };
  }
}
