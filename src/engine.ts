import {
  AppState, AuditEntry, ChargeRequest, Conflict, FieldReport, Instrument,
  LedgerEntry, OutboxItem, Role, Task, Toast,
} from "./types";

// ---------- 权限 ----------
// 审计员全站只读；充电位占用仅机器人低电量流程可申请，人工角色不能直接占用。
const READONLY_ROLES: Role[] = ["审计员"];

export function isReadonly(role: Role) {
  return READONLY_ROLES.includes(role);
}

// ---------- 初始数据 ----------
export const LOW_BATTERY = 40;
export const FULL_BATTERY = 90; // 充到该值即完成

let seq = 0;
export function uid(prefix: string) {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36)}`;
}

function initialInstruments(): Instrument[] {
  return [
    { id: "PC-A01", kind: "尘埃粒子计数器", calibration: "已确认", borrowedBy: null },
    { id: "PC-A02", kind: "尘埃粒子计数器", calibration: "待复检", borrowedBy: null },
    { id: "DP-B01", kind: "微压差计", calibration: "已确认", borrowedBy: null },
    { id: "TH-C01", kind: "温湿度记录仪", calibration: "已确认", borrowedBy: null },
    { id: "TH-C02", kind: "温湿度记录仪", calibration: "停用", borrowedBy: null },
  ];
}

function initialTasks(): Task[] {
  const now = Date.now();
  return [
    { id: "T-1001", room: "CR-1201", isoClass: "ISO 5", instrumentKind: "尘埃粒子计数器", status: "pending", instrumentId: null, robotId: null, assignee: null, progress: 0, createdAt: now - 90000 },
    { id: "T-1002", room: "CR-1204", isoClass: "ISO 5", instrumentKind: "微压差计", status: "pending", instrumentId: null, robotId: null, assignee: null, progress: 0, createdAt: now - 80000 },
    { id: "T-1003", room: "Y-0302", isoClass: "黄光区", instrumentKind: "温湿度记录仪", status: "pending", instrumentId: null, robotId: null, assignee: null, progress: 0, createdAt: now - 70000 },
  ];
}

export function initialState(role: Role = "班组长"): AppState {
  return {
    role,
    online: true,
    dockCapacity: 2,
    instruments: initialInstruments(),
    tasks: initialTasks(),
    robots: [
      { id: "R-01", battery: 82, status: "idle", activeTaskId: null },
      { id: "R-02", battery: 36, status: "idle", activeTaskId: null },
    ],
    chargeRequests: [],
    outbox: [],
    conflicts: [],
    ledger: [],
    audit: [],
    toasts: [],
  };
}

// ---------- 工具 ----------
function toast(kind: Toast["kind"], text: string): Toast {
  return { id: uid("toast"), kind, text };
}

function audit(actor: AppState["audit"][number]["actor"], action: string, detail: string, denied = false): AuditEntry {
  return { id: uid("aud"), time: Date.now(), actor, action, detail, denied };
}

// 复检员（人工执行人，不占机器人，但同样受仪器借用唯一性约束）
export const INSPECTORS = [
  { id: "INSP-WQ", name: "复检员 王倩" },
  { id: "INSP-LM", name: "复检员 李明" },
];

export function executorName(id: string | null): string {
  if (!id) return "未指派";
  if (id.startsWith("INSP-")) return INSPECTORS.find((x) => x.id === id)?.name ?? id;
  return `机器人 ${id}`;
}

function availableInstrumentOfKind(instruments: Instrument[], kind: string, excludeTaskId: string | null): Instrument | null {
  return instruments.find(
    (i) => i.kind === kind && i.calibration === "已确认" && (i.borrowedBy === null || i.borrowedBy === excludeTaskId),
  ) ?? null;
}

// 机器人能否接新任务：空闲、电量达标、无未完成的充电申请
function robotCanWork(s: AppState, robotId: string) {
  const r = s.robots.find((x) => x.id === robotId);
  if (!r || r.status !== "idle" || r.activeTaskId !== null || r.battery < LOW_BATTERY) return false;
  if (s.chargeRequests.some((q) => q.robotId === robotId && q.status !== "completed")) return false;
  return true;
}

function firstIdleRobot(s: AppState) {
  return s.robots.find((r) => robotCanWork(s, r.id)) ?? null;
}

// ---------- Action ----------
export type Action =
  | { type: "switchRole"; role: Role }
  | { type: "dismissToast"; id: string }
  | { type: "addTask"; room: string; isoClass: string; instrumentKind: string; assignee?: string }
  | { type: "dispatchTask"; taskId: string; manualRobotId?: string; manualInstrumentId?: string; manualAssignee?: string }
  | { type: "advanceProgress"; taskId: string }
  | { type: "completeTask"; taskId: string }
  | { type: "setBattery"; robotId: string; battery: number }
  | { type: "requestCharge"; robotId: string; actor?: Role } // 低电量申请；actor 存在表示人工越权尝试
  | { type: "tickCharge" }
  | { type: "releaseCharge"; requestId: string }
  | { type: "setDockCapacity"; capacity: number }
  | { type: "setCalibration"; instrumentId: string; calibration: Instrument["calibration"] }
  | { type: "toggleNetwork" }
  | { type: "fieldReport"; report: FieldReport; duplicated?: boolean }
  | { type: "simulateMismatchReport"; taskId: string; fieldInstrumentId: string; note: string }
  | { type: "resolveConflict"; conflictId: string; resolution: "dispatch" | "field" };

// 把审计与提示附加到状态
function withFeedback(s: AppState, a: AuditEntry, t?: Toast): AppState {
  return { ...s, audit: [a, ...s.audit].slice(0, 200), toasts: t ? [t, ...s.toasts].slice(0, 4) : s.toasts };
}

function deny(s: AppState, action: string, detail: string): AppState {
  return withFeedback(
    s,
    audit(s.role, action, detail, true),
    toast("deny", detail),
  );
}

// 条件不满足：任务转为排队并写明原因（不能下发），不计为越权拒绝
function markBlocked(s: AppState, taskId: string, reason: string): AppState {
  const next: AppState = {
    ...s,
    tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, status: "queued", instrumentId: null, blockReason: reason } : t)),
  };
  return withFeedback(next, audit(s.role, "任务排队", `${taskId}：${reason}`), toast("warn", reason));
}

// 尝试自动下发：仪器可用 + 可作业机器人 + 无未裁决冲突；其余任务写明排队原因
function tryAutoDispatch(s: AppState): AppState {
  let tasks = [...s.tasks];
  let instruments = [...s.instruments];
  let robots = [...s.robots];
  // 有未完成充电申请（排队/在充）的机器人不得接新任务
  const pendingChargeRobots = new Set(
    s.chargeRequests.filter((r) => r.status !== "completed").map((r) => r.robotId),
  );
  const queueOrder = [...tasks]
    .filter((t) => t.status === "queued" || t.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt);

  const usedRobots = new Set(robots.filter((r) => r.status === "working").map((r) => r.id));
  const blockMap = new Map<string, string>();

  const canWork = (r: { id: string; status: string; activeTaskId: string | null; battery: number }) =>
    r.status === "idle" && r.activeTaskId === null && r.battery >= LOW_BATTERY && !usedRobots.has(r.id) && !pendingChargeRobots.has(r.id);

  for (const qt of queueOrder) {
    if (s.conflicts.some((c) => c.status === "open" && c.taskId === qt.id)) {
      blockMap.set(qt.id, "仪器号冲突待班组长裁决");
      continue;
    }
    const robot = robots.find(canWork);
    const inst = availableInstrumentOfKind(instruments, qt.instrumentKind, qt.id);
    if (!inst) {
      blockMap.set(qt.id, `等待可用的已确认「${qt.instrumentKind}」`);
      continue;
    }
    if (!robot) {
      const lowBattery = robots.some((r) => r.status === "idle" && (r.battery < LOW_BATTERY || pendingChargeRobots.has(r.id)));
      blockMap.set(qt.id, lowBattery ? "机器人电量低于40%/等待充电，充电完成后下发" : "等待空闲机器人");
      continue;
    }
    usedRobots.add(robot.id);
    instruments = instruments.map((i) => (i.id === inst.id ? { ...i, borrowedBy: qt.id } : i));
    robots = robots.map((r) => (r.id === robot.id ? { ...r, status: "working" as const, activeTaskId: qt.id } : r));
    tasks = tasks.map((t) =>
      t.id === qt.id
        ? { ...t, status: "dispatched" as const, instrumentId: inst.id, robotId: robot.id, assignee: robot.id, blockReason: undefined, pinnedRobotId: robot.id }
        : t,
    );
  }
  tasks = tasks.map((t) => {
    const reason = blockMap.get(t.id);
    if (reason && (t.status === "pending" || t.status === "queued")) {
      return { ...t, status: "queued" as const, instrumentId: null, blockReason: reason };
    }
    return t;
  });
  return { ...s, tasks, instruments, robots };
}

// 任务完成后释放仪器与机器人
function releaseTaskResources(s: AppState, taskId: string): AppState {
  const task = s.tasks.find((t) => t.id === taskId);
  if (!task) return s;
  return {
    ...s,
    instruments: s.instruments.map((i) => (i.borrowedBy === taskId ? { ...i, borrowedBy: null } : i)),
    robots: s.robots.map((r) =>
      r.activeTaskId === taskId ? { ...r, status: "idle", activeTaskId: null } : r,
    ),
  };
}

// 入账：重复回传只入账一次
function ledgerKey(report: { taskId: string; instrumentId: string; progress: number; note: string }) {
  return `${report.taskId}|${report.instrumentId}|${report.progress}|${report.note}`;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "switchRole":
      return { ...state, role: action.role, toasts: [toast("ok", `当前角色：${action.role}${isReadonly(action.role) ? "（只读）" : ""}`), ...state.toasts].slice(0, 4) };

    case "dismissToast":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };

    case "addTask": {
      if (isReadonly(state.role)) return deny(state, "新建任务", "审计员为只读角色，不能新建巡检任务");
      const t: Task = {
        id: uid("T"),
        room: action.room,
        isoClass: action.isoClass,
        instrumentKind: action.instrumentKind,
        status: "pending",
        instrumentId: null,
        robotId: null,
        assignee: action.assignee ?? null,
        progress: 0,
        createdAt: Date.now(),
      };
      let s: AppState = { ...state, tasks: [...state.tasks, t] };
      s = withFeedback(s, audit(state.role, "新建任务", `${t.id} ${t.room} 需要「${t.instrumentKind}」`));
      return tryAutoDispatch(s);
    }

    case "dispatchTask": {
      if (isReadonly(state.role)) return deny(state, "下发任务", "审计员为只读角色，不能下发任务");
      const task = state.tasks.find((t) => t.id === action.taskId);
      if (!task || task.status === "dispatched" || task.status === "done") return state;
      if (state.conflicts.some((c) => c.status === "open" && c.taskId === task.id)) {
        return deny(state, "下发任务", `${task.id} 存在仪器号冲突，须由班组长裁决后才能继续`);
      }
      // 手动指定仪器：借用同一台仪器会冲突（机器人与复检员不能抢同一台）
      if (action.manualInstrumentId) {
        const mi = state.instruments.find((i) => i.id === action.manualInstrumentId);
        if (!mi) return deny(state, "下发任务", "仪器号不存在");
        if (mi.borrowedBy && mi.borrowedBy !== task.id) {
          return deny(state, "下发任务", `仪器 ${mi.id} 已被任务 ${mi.borrowedBy} 借用，机器人与复检员不能抢用同一台仪器`);
        }
        if (mi.kind !== task.instrumentKind) return deny(state, "下发任务", `仪器 ${mi.id} 类型不符，任务需要「${task.instrumentKind}」`);
        if (mi.calibration !== "已确认") return deny(state, "下发任务", `仪器 ${mi.id} 校准状态为「${mi.calibration}」，不可下发`);
      }
      const isInspector = !!action.manualAssignee;
      const robot = !isInspector
        ? action.manualRobotId
          ? state.robots.find((r) => r.id === action.manualRobotId) ?? null
          : firstIdleRobot(state)
        : null;
      const inst = action.manualInstrumentId
        ? state.instruments.find((i) => i.id === action.manualInstrumentId) ?? null
        : availableInstrumentOfKind(state.instruments, task.instrumentKind, task.id);

      if (robot && robot.activeTaskId && robot.activeTaskId !== task.id) {
        return deny(state, "下发任务", `${robot.id} 正在执行任务 ${robot.activeTaskId}，不能重复派发`);
      }
      if (robot && state.chargeRequests.some((q) => q.robotId === robot.id && q.status !== "completed")) {
        return markBlocked(state, task.id, `${robot.id} 已申请充电（等待入位），完成充电前不能下发`);
      }
      if (!isInspector && !robot) return markBlocked(state, task.id, "没有空闲且电量≥40%的机器人，任务排队等待");
      if (robot && robot.battery < LOW_BATTERY) return markBlocked(state, task.id, `${robot.id} 电量 ${robot.battery}% 低于40%，须先充电`);
      if (!inst) return markBlocked(state, task.id, `没有可用的已确认「${task.instrumentKind}」，任务排队等待`);

      const assigneeId = isInspector ? action.manualAssignee! : robot!.id;
      let s: AppState = {
        ...state,
        instruments: state.instruments.map((i) => (i.id === inst.id ? { ...i, borrowedBy: task.id } : i)),
        robots: robot
          ? state.robots.map((r) => (r.id === robot.id ? { ...r, status: "working", activeTaskId: task.id } : r))
          : state.robots,
        tasks: state.tasks.map((t) =>
          t.id === task.id
            ? { ...t, status: "dispatched", instrumentId: inst.id, robotId: robot?.id ?? null, assignee: assigneeId, blockReason: undefined, pinnedRobotId: robot?.id ?? null }
            : t,
        ),
      };
      return withFeedback(s, audit(state.role, "下发任务", `${task.id} → ${executorName(assigneeId)} 借用 ${inst.id}`), toast("ok", `${task.id} 已下发，${executorName(assigneeId)} 借用 ${inst.id}`));
    }

    case "advanceProgress": {
      if (isReadonly(state.role)) return deny(state, "更新进度", "审计员为只读角色");
      const task = state.tasks.find((t) => t.id === action.taskId);
      if (!task || task.status !== "dispatched") return state;
      if (task.conflictId && state.conflicts.some((c) => c.id === task.conflictId && c.status === "open")) {
        return deny(state, "更新进度", `${task.id} 仪器号冲突未裁决，任务挂起`);
      }
      const progress = Math.min(100, task.progress + 25);
      return withFeedback(
        { ...state, tasks: state.tasks.map((t) => (t.id === task.id ? { ...t, progress } : t)) },
        audit(state.role, "巡检进度", `${task.id} 进度 ${progress}%`),
      );
    }

    case "completeTask": {
      if (isReadonly(state.role)) return deny(state, "完成任务", "审计员为只读角色");
      const task = state.tasks.find((t) => t.id === action.taskId);
      if (!task || task.status !== "dispatched") return state;
      if (task.conflictId && state.conflicts.some((c) => c.id === task.conflictId && c.status === "open")) {
        return deny(state, "完成任务", `${task.id} 仪器号冲突未裁决，不能完成`);
      }
      let s = releaseTaskResources({ ...state, tasks: state.tasks.map((t) => (t.id === task.id ? { ...t, status: "done", progress: 100 } : t)) }, task.id);
      s = withFeedback(s, audit(state.role, "完成任务", `${task.id} 巡检完成，归还仪器 ${task.instrumentId ?? "-"}`), toast("ok", `${task.id} 已完成并归还仪器`));
      // 先处理排队充电（低电量回库机器人补位），再自动下发排队任务
      s = allocateDocks(s);
      return tryAutoDispatch(s);
    }

    case "setBattery": {
      if (isReadonly(state.role)) return deny(state, "调整电量", "审计员为只读角色");
      const battery = Math.max(0, Math.min(100, action.battery));
      let s: AppState = { ...state, robots: state.robots.map((r) => (r.id === action.robotId ? { ...r, battery } : r)) };
      s = withFeedback(s, audit(state.role, "设置电量", `${action.robotId} 电量 ${battery}%`));
      return tryAutoDispatch(s);
    }

    case "requestCharge": {
      // 巡检员越权手动占用充电位 → 拒绝；机器人低电量自动申请才放行
      if (action.actor) {
        return deny(state, "申请充电", `已拒绝：充电位仅允许低电量机器人自动申请，${action.actor}不得手动占用`);
      }
      if (isReadonly(state.role)) return deny(state, "申请充电", "审计员为只读角色");
      const robot = state.robots.find((r) => r.id === action.robotId);
      if (!robot) return state;
      const existing = state.chargeRequests.find((r) => r.robotId === robot.id && r.status !== "completed");
      if (existing) return deny(state, "申请充电", `${robot.id} 已有充电申请（${existing.status === "allocated" ? "已入位" : "排队中"}）`);
      if (robot.battery >= LOW_BATTERY) return deny(state, "申请充电", `${robot.id} 电量 ${robot.battery}% 未低于40%，不允许占用充电位`);

      const req: ChargeRequest = { id: uid("CH"), robotId: robot.id, status: "queued", dockNo: null, createdAt: Date.now() };
      let s: AppState = { ...state, chargeRequests: [...state.chargeRequests, req] };
      s = withFeedback(s, audit("系统", "低电量申请充电", `${robot.id} 电量 ${robot.battery}% < 40%，申请充电`), toast("warn", `${robot.id} 电量低于40%，已申请充电`));
      return allocateDocks(s);
    }

    case "tickCharge": {
      if (isReadonly(state.role)) return state;
      let robots = state.robots.map((r) => {
        const alloc = state.chargeRequests.find((q) => q.status === "allocated" && q.robotId === r.id);
        if (!alloc) return r;
        return { ...r, battery: Math.min(100, r.battery + 12) };
      });
      let requests = state.chargeRequests.map((r) => {
        const robot = robots.find((x) => x.id === r.robotId);
        if (r.status === "allocated" && robot && robot.battery >= FULL_BATTERY) {
          return { ...r, status: "completed" as const, dockNo: null };
        }
        return r;
      });
      // 充满后机器人恢复空闲
      const finishedRobotIds = state.chargeRequests
        .filter((r) => r.status === "allocated")
        .map((r) => r.robotId)
        .filter((id) => robots.find((x) => x.id === id)!.battery >= FULL_BATTERY);
      robots = robots.map((r) => (finishedRobotIds.includes(r.id) && r.status === "charging" ? { ...r, status: "idle" } : r));
      let s: AppState = { ...state, robots, chargeRequests: requests };
      s = allocateDocks(s);
      return tryAutoDispatch(s);
    }

    case "releaseCharge": {
      if (isReadonly(state.role)) return deny(state, "释放充电位", "审计员为只读角色");
      const req = state.chargeRequests.find((r) => r.id === action.requestId);
      if (!req) return state;
      let s: AppState = {
        ...state,
        chargeRequests: state.chargeRequests.map((r) => (r.id === req.id ? { ...r, status: "completed", dockNo: null } : r)),
        robots: state.robots.map((r) => (r.id === req.robotId && r.status === "charging" ? { ...r, status: "idle" } : r)),
      };
      s = withFeedback(s, audit(state.role, "释放充电位", `${req.robotId} 提前结束充电`));
      s = allocateDocks(s);
      return tryAutoDispatch(s);
    }

    case "setDockCapacity": {
      if (isReadonly(state.role)) return deny(state, "设置充电位", "审计员为只读角色");
      const capacity = Math.max(0, action.capacity);
      let s: AppState = { ...state, dockCapacity: capacity };
      s = withFeedback(s, audit(state.role, "设置充电位容量", `充电位容量 ${capacity}`));
      return allocateDocks(s);
    }

    case "setCalibration": {
      if (isReadonly(state.role)) return deny(state, "校准确认", "审计员为只读角色");
      const inst = state.instruments.find((i) => i.id === action.instrumentId);
      if (!inst) return state;
      const changed = inst.calibration !== action.calibration;
      let instruments = state.instruments.map((i) => (i.id === inst.id ? { ...i, calibration: action.calibration } : i));

      // 仪器变「待复检/停用」：未开始任务立即失效并释放预占；进行中任务持机不受影响
      let auditDetail = `${inst.id} 校准状态：${inst.calibration} → ${action.calibration}`;
      if (changed && action.calibration !== "已确认") {
        const affected = state.tasks.filter(
          (t) => (t.status === "pending" || t.status === "queued") && t.instrumentKind === inst.kind,
        ).length;
        instruments = instruments.map((i) =>
          i.id === inst.id && i.borrowedBy && state.tasks.find((t) => t.id === i.borrowedBy)?.status !== "dispatched"
            ? { ...i, borrowedBy: null }
            : i,
        );
        auditDetail += `；${affected} 个未开始任务立即失效并按可用仪器重排`;
      }
      let s: AppState = { ...state, instruments };
      if (changed) {
        // tryAutoDispatch 会对所有 pending/queued 任务按当前可用仪器+机器人重新评估、重排或下发
        s = withFeedback(s, audit(state.role, "校准确认变更", auditDetail), toast(action.calibration === "已确认" ? "ok" : "warn", auditDetail));
      }
      return tryAutoDispatch(s);
    }

    case "toggleNetwork": {
      if (isReadonly(state.role)) return deny(state, "网络切换", "审计员为只读角色");
      const online = !state.online;
      let s: AppState = { ...state, online };
      if (!online) {
        s = withFeedback(s, audit("系统", "基站断网", "进入离线模式：任务进度留存本地，现场记录入待同步发件箱"), toast("warn", "基站断网，进度本地留存，恢复后自动合并"));
      } else {
        s = withFeedback(s, audit("系统", "网络恢复", "开始合并发件箱中的现场记录"), toast("ok", "网络恢复，正在合并现场记录…"));
        s = syncOutbox(s);
      }
      return s;
    }

    case "fieldReport": {
      if (isReadonly(state.role)) return deny(state, "现场回传", "审计员为只读角色");
      const report: FieldReport = { ...action.report, id: action.report.id || uid("RPT") };
      const key = ledgerKey(report);
      const keyInLedger = state.ledger.some((e) => e.dedupKey === key);
      const keyInOutbox = state.outbox.some((o) => o.dedupKey === key);
      const duplicate = action.duplicated === true || keyInLedger || keyInOutbox;

      // 离线：全部只留存到本地发件箱（含重传包），不写台账、不改任务；恢复时合并去重
      if (!state.online) {
        const item: OutboxItem = { ...report, dedupKey: key, syncStatus: "pending" };
        let s: AppState = { ...state, outbox: [item, ...state.outbox].slice(0, 200) };
        s = withFeedback(
          s,
          audit("现场设备", "离线现场回传", `${report.taskId} 进度 ${report.progress}% 仪器 ${report.instrumentId}，留存发件箱待恢复合并${duplicate ? "（重传包）" : ""}`),
          duplicate ? toast("warn", "断网期间重传包已留存，恢复后只入账一次") : toast("warn", "已离线留存，恢复联网后合并"),
        );
        return s;
      }

      const item: OutboxItem = {
        ...report,
        dedupKey: key,
        syncStatus: duplicate ? "duplicate" : "synced",
        syncedAt: Date.now(),
      };
      let s: AppState = { ...state, outbox: [item, ...state.outbox].slice(0, 200) };

      if (duplicate) {
        s = withFeedback(s, audit("系统", "现场回传", `${report.taskId} 重复回传，仅保留首次入账记录（幂等丢弃）`), toast("warn", "重复回传，只入账一次"));
        return s;
      }

      s = ingestReport(s, report, key, "现场回传即时入账");
      return s;
    }

    case "simulateMismatchReport": {
      if (isReadonly(state.role)) return deny(state, "现场回传", "审计员为只读角色");
      const task = state.tasks.find((t) => t.id === action.taskId);
      if (!task) return state;
      if (task.status !== "dispatched") return deny(state, "现场回传", "仅进行中的任务可回传仪器号");
      if (task.instrumentId === action.fieldInstrumentId) {
        return deny(state, "现场回传", "现场仪器号与调度一致，无冲突");
      }
      const report: FieldReport = {
        id: uid("RPT"),
        taskId: task.id,
        instrumentId: action.fieldInstrumentId,
        progress: task.progress,
        note: action.note,
        source: "现场",
        createdAt: Date.now(),
      };
      // 两版都留：调度台版仪器 + 现场版仪器，现场记录照常入账但挂起任务
      const key = ledgerKey(report);
      // 离线：冲突包进发件箱，任务立刻挂起（双版信息随现场记录留存），台账恢复后补入
      if (!state.online) {
        const outboxItem: OutboxItem = { ...report, dedupKey: key, syncStatus: "pending", pendingConflict: true };
        const conflict: Conflict = {
          id: uid("CF"),
          taskId: task.id,
          dispatchInstrumentId: task.instrumentId ?? "-",
          fieldInstrumentId: action.fieldInstrumentId,
          ledgerReportId: null,
          status: "open",
          createdAt: Date.now(),
        };
        let s: AppState = {
          ...state,
          outbox: [outboxItem, ...state.outbox].slice(0, 200),
          conflicts: [conflict, ...state.conflicts],
          tasks: state.tasks.map((t) => (t.id === task.id ? { ...t, conflictId: conflict.id } : t)),
        };
        return withFeedback(
          s,
          audit("现场设备", "离线仪器号冲突", `${task.id} 调度号 ${task.instrumentId} ≠ 现场号 ${action.fieldInstrumentId}，两版离线留存，任务挂起`),
          toast("warn", `断网期间仪器号对不上：${task.instrumentId} / ${action.fieldInstrumentId}，已挂起待裁决`),
        );
      }
      const outboxItem: OutboxItem = { ...report, dedupKey: key, syncStatus: "synced" };
      let s: AppState = { ...state, outbox: [outboxItem, ...state.outbox].slice(0, 200) };
      const entry: LedgerEntry = { ...report, id: uid("LG"), dedupKey: key };
      const conflict: Conflict = {
        id: uid("CF"),
        taskId: task.id,
        dispatchInstrumentId: task.instrumentId ?? "-",
        fieldInstrumentId: action.fieldInstrumentId,
        ledgerReportId: entry.id,
        status: "open",
        createdAt: Date.now(),
      };
      s = {
        ...s,
        ledger: [entry, ...s.ledger].slice(0, 200),
        conflicts: [conflict, ...s.conflicts],
        tasks: s.tasks.map((t) => (t.id === task.id ? { ...t, conflictId: conflict.id } : t)),
      };
      s = withFeedback(
        s,
        audit("系统", "仪器号冲突", `${task.id} 调度号 ${task.instrumentId} ≠ 现场号 ${action.fieldInstrumentId}，两版并存，待班组长裁决`),
        toast("warn", `仪器号对不上：${task.instrumentId} / ${action.fieldInstrumentId}，任务挂起`),
      );
      return s;
    }

    case "resolveConflict": {
      // 仅班组长可裁决；审计员只读；其他角色拒绝
      if (state.role !== "班组长") return deny(state, "冲突裁决", "仪器号冲突仅班组长可裁决");
      const conflict = state.conflicts.find((c) => c.id === action.conflictId);
      if (!conflict || conflict.status === "resolved") return state;
      const chosenInstrumentId = action.resolution === "dispatch" ? conflict.dispatchInstrumentId : conflict.fieldInstrumentId;
      // 重新借用：检查选中仪器是否被别的任务占用（防机器人/复检员抢同一台）
      const inst = state.instruments.find((i) => i.id === chosenInstrumentId);
      if (!inst) return deny(state, "冲突裁决", `仪器 ${chosenInstrumentId} 不存在`);
      if (inst.borrowedBy && inst.borrowedBy !== conflict.taskId) {
        return deny(state, "冲突裁决", `仪器 ${chosenInstrumentId} 已被任务 ${inst.borrowedBy} 占用，无法选用`);
      }
      if (inst.calibration !== "已确认") return deny(state, "冲突裁决", `仪器 ${chosenInstrumentId} 校准确认未通过，无法选用`);

      const task = state.tasks.find((t) => t.id === conflict.taskId);
      let instruments = state.instruments;
      // 释放原仪器号（若是调度台版且仍记在该任务名下）
      if (task && task.instrumentId && task.instrumentId !== chosenInstrumentId) {
        instruments = instruments.map((i) => (i.borrowedBy === conflict.taskId ? { ...i, borrowedBy: null } : i));
      }
      instruments = instruments.map((i) => (i.id === chosenInstrumentId ? { ...i, borrowedBy: conflict.taskId } : i));

      let s: AppState = {
        ...state,
        instruments,
        conflicts: state.conflicts.map((c) => (c.id === conflict.id ? { ...c, status: "resolved", resolution: action.resolution, resolvedBy: "班组长" } : c)),
        tasks: state.tasks.map((t) =>
          t.id === conflict.taskId ? { ...t, instrumentId: chosenInstrumentId, conflictId: null } : t,
        ),
      };
      s = withFeedback(
        s,
        audit("班组长", "冲突裁决", `${conflict.taskId} 采用${action.resolution === "dispatch" ? "调度台版" : "现场版"}仪器 ${chosenInstrumentId}，任务继续`),
        toast("ok", `已选用 ${chosenInstrumentId}，任务恢复`),
      );
      return tryAutoDispatch(s);
    }

    default:
      return state;
  }
}

// ---------- 充电位分配：容量满则排队；作业中机器人完成任务前保持排队 ----------
function allocateDocks(s: AppState): AppState {
  let allocated = s.chargeRequests.filter((r) => r.status === "allocated").length;
  const usedDocks = new Set(s.chargeRequests.filter((r) => r.status === "allocated" && r.dockNo !== null).map((r) => r.dockNo as number));
  // 先到先得
  const queueOrder = s.chargeRequests
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => r.status === "queued")
    .sort((a, b) => a.r.createdAt - b.r.createdAt || a.idx - b.idx);
  const allocateIds = new Set<string>();

  for (const { r } of queueOrder) {
    if (allocated >= s.dockCapacity) break; // 容量满：继续排队
    const robot = s.robots.find((x) => x.id === r.robotId);
    if (!robot) continue;
    if (robot.status === "working" || robot.activeTaskId !== null) continue; // 作业中：完成后补位
    let dockNo = 1;
    while (usedDocks.has(dockNo)) dockNo += 1;
    usedDocks.add(dockNo);
    allocated += 1;
    r.dockNo = dockNo;
    allocateIds.add(r.id);
  }

  const nextRequests = s.chargeRequests.map((r) =>
    allocateIds.has(r.id) ? { ...r, status: "allocated" as const, dockNo: r.dockNo } : r,
  );

  const newlyAllocated = nextRequests.filter((r) => allocateIds.has(r.id));
  let robots = s.robots.map((r) => (newlyAllocated.some((q) => q.robotId === r.id) ? { ...r, status: "charging" as const, activeTaskId: null } : r));
  let next: AppState = { ...s, chargeRequests: nextRequests, robots };
  for (const q of newlyAllocated) {
    next = withFeedback(next, audit("系统", "分配充电位", `${q.robotId} 入位 ${q.dockNo} 号充电桩`), toast("ok", `${q.robotId} 已入位 ${q.dockNo} 号充电桩`));
  }
  const queuedLeft = nextRequests.filter((r) => r.status === "queued");
  if (queuedLeft.length) {
    const busy = queuedLeft
      .map((q) => {
        const rb = s.robots.find((x) => x.id === q.robotId);
        return rb && (rb.status === "working" || rb.activeTaskId) ? `${q.robotId}（作业完成后补位）` : q.robotId;
      })
      .join("、");
    const reason = allocated >= s.dockCapacity ? "充电位容量已满" : "等待可入位机器人";
    next = withFeedback(next, audit("系统", "充电排队", `${busy} 排队：${reason}`));
  }
  return next;
}

// ---------- 现场记录入账（含仪器号比对） ----------
function ingestReport(s: AppState, report: FieldReport, key: string, logText: string): AppState {
  const entry: LedgerEntry = {
    id: uid("LG"),
    taskId: report.taskId,
    instrumentId: report.instrumentId,
    progress: report.progress,
    note: report.note,
    source: report.source,
    dedupKey: key,
    createdAt: report.createdAt,
  };
  let tasks = s.tasks;
  let conflicts = s.conflicts;
  let toasts = s.toasts;
  const task = s.tasks.find((t) => t.id === report.taskId);
  let detail = `${logText}：${report.taskId} 进度 ${report.progress}% 仪器 ${report.instrumentId}`;

  if (task && task.status === "dispatched" && task.instrumentId && task.instrumentId !== report.instrumentId) {
    // 现场号对不上：两版都留，挂起，等班长
    const conflict: Conflict = {
      id: uid("CF"),
      taskId: task.id,
      dispatchInstrumentId: task.instrumentId,
      fieldInstrumentId: report.instrumentId,
      ledgerReportId: entry.id,
      status: "open",
      createdAt: Date.now(),
    };
    conflicts = [conflict, ...conflicts];
    tasks = tasks.map((t) => (t.id === task.id ? { ...t, conflictId: conflict.id } : t));
    detail += `；仪器号与调度不符，两版并存，任务挂起待班组长裁决`;
    toasts = [toast("warn", `仪器号对不上：${task.instrumentId} / ${report.instrumentId}`), ...toasts].slice(0, 4);
  } else if (task && (task.status === "dispatched" || task.status === "done")) {
    tasks = tasks.map((t) => (t.id === task.id ? { ...t, progress: Math.max(t.progress, report.progress) } : t));
  }

  return withFeedback(
    { ...s, ledger: [entry, ...s.ledger].slice(0, 200), tasks, conflicts, toasts },
    audit(report.source === "现场" ? "现场设备" : s.role, "现场记录入账", detail),
  );
}

// ---------- 断网恢复：合并发件箱，重复只入账一次 ----------
function syncOutbox(s: AppState): AppState {
  let next = s;
  const pending = s.outbox.filter((o) => o.syncStatus === "pending");
  let merged = 0;
  let dup = 0;
  const updated = new Map<string, OutboxItem>();

  for (const item of pending) {
    const already = next.ledger.some((e) => e.dedupKey === item.dedupKey) ||
      [...updated.values()].some((o) => o.dedupKey === item.dedupKey && o.syncStatus === "synced");
    if (already) {
      updated.set(item.id, { ...item, syncStatus: "duplicate" });
      dup += 1;
      continue;
    }
    const report: FieldReport = {
      id: item.id, taskId: item.taskId, instrumentId: item.instrumentId, progress: item.progress,
      note: item.note, source: item.source, createdAt: item.createdAt,
    };
    if (item.pendingConflict) {
      // 断网时已生成 open 冲突：只补现场版台账并回填 ledgerReportId，不重复建冲突
      const entry: LedgerEntry = { ...report, id: uid("LG"), dedupKey: item.dedupKey };
      const existingConflict = next.conflicts.find(
        (c) => c.status === "open" && c.taskId === item.taskId && c.fieldInstrumentId === item.instrumentId,
      );
      next = {
        ...next,
        ledger: [entry, ...next.ledger].slice(0, 200),
        conflicts: existingConflict
          ? next.conflicts.map((c) => (c.id === existingConflict.id ? { ...c, ledgerReportId: entry.id } : c))
          : next.conflicts,
      };
      next = withFeedback(next, audit("系统", "合并冲突记录", `${item.taskId} 现场版仪器 ${item.instrumentId} 已补入账，冲突仍待班组长裁决`));
    } else {
      next = ingestReport(next, report, item.dedupKey, "网络恢复合并");
    }
    updated.set(item.id, { ...item, syncStatus: "synced", syncedAt: Date.now(), pendingConflict: undefined });
    merged += 1;
  }

  if (merged === 0 && dup === 0) {
    return withFeedback(next, audit("系统", "合并完成", "发件箱无待同步记录"), toast("ok", "现场记录已是最新"));
  }
  const outbox = next.outbox.map((o) => updated.get(o.id) ?? o);
  next = { ...next, outbox };
  return withFeedback(
    next,
    audit("系统", "合并完成", `合并现场记录 ${merged} 条，重复回传丢弃 ${dup} 条`),
    toast("ok", `合并完成：入账 ${merged} 条，去重 ${dup} 条`),
  );
}
