// 巡检调度台领域模型

export type Role = "巡检员" | "厂务工程师" | "班组长" | "审计员";
export type Calibration = "已确认" | "待复检" | "停用";
export type TaskStatus = "pending" | "queued" | "dispatched" | "done";
export type RobotStatus = "idle" | "working" | "charging";
export type ChargeRequestStatus = "queued" | "allocated" | "completed";
export type OutboxStatus = "pending" | "synced" | "duplicate" | "conflict";

export interface Instrument {
  id: string;
  kind: string; // 仪器类型，如 尘埃粒子计数器
  calibration: Calibration;
  borrowedBy: string | null; // 当前借用任务号
}

export interface Task {
  id: string;
  room: string; // 房间编号
  isoClass: string; // 洁净等级
  instrumentKind: string; // 所需仪器类型
  status: TaskStatus;
  instrumentId: string | null; // 实际占用的仪器号
  robotId: string | null;
  assignee: string | null; // 执行人：机器人/复检员
  progress: number; // 0-100
  blockReason?: string; // 排队/不可下发原因
  pinnedRobotId?: string | null; // 已下发后锁定的机器人
  conflictId?: string | null; // 未裁决的号对不上冲突
  createdAt: number;
}

export interface Robot {
  id: string;
  battery: number; // 0-100
  status: RobotStatus;
  activeTaskId: string | null;
}

export interface ChargeRequest {
  id: string;
  robotId: string;
  status: ChargeRequestStatus;
  dockNo: number | null;
  createdAt: number;
}

export interface FieldReport {
  id: string;
  taskId: string;
  instrumentId: string;
  progress: number;
  note: string;
  source: "现场" | "调度台";
  createdAt: number;
}

export interface OutboxItem extends FieldReport {
  dedupKey: string;
  syncStatus: OutboxStatus;
  syncedAt?: number;
  pendingConflict?: boolean; // 断网期间发生的仪器号对不上，恢复后补建冲突复核
}

export interface Conflict {
  id: string;
  taskId: string;
  dispatchInstrumentId: string; // 调度台记录的仪器号
  fieldInstrumentId: string; // 现场回传的仪器号
  ledgerReportId: string | null; // 已入账的现场记录
  status: "open" | "resolved";
  resolution?: "dispatch" | "field";
  resolvedBy?: Role;
  createdAt: number;
}

export interface LedgerEntry {
  id: string;
  taskId: string;
  instrumentId: string;
  progress: number;
  note: string;
  source: "现场" | "调度台";
  dedupKey: string;
  createdAt: number;
}

export interface AuditEntry {
  id: string;
  time: number;
  actor: Role | "系统" | "现场设备";
  action: string;
  detail: string;
  denied?: boolean;
}

export interface Toast {
  id: string;
  kind: "ok" | "warn" | "deny";
  text: string;
}

export interface AppState {
  role: Role;
  online: boolean;
  dockCapacity: number;
  instruments: Instrument[];
  tasks: Task[];
  robots: Robot[];
  chargeRequests: ChargeRequest[];
  outbox: OutboxItem[];
  conflicts: Conflict[];
  ledger: LedgerEntry[];
  audit: AuditEntry[];
  toasts: Toast[];
}
