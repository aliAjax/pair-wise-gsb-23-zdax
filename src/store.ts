// 巡检调度台领域逻辑：任务-充电位-仪器联动、断网暂存合并、权限控制
export type Role = "inspector" | "supervisor" | "auditor";
export type InstrumentType = "particle" | "pressure" | "thermal";
export type Calibration = "confirmed" | "pending" | "expired";
export type RobotStatus = "idle" | "working" | "charging" | "charge-waiting";
export type TaskStatus =
  | "pending"
  | "queued"
  | "dispatched"
  | "in-progress"
  | "blocked"
  | "done"
  | "invalidated";

export interface Robot {
  id: string;
  name: string;
  battery: number;
  status: RobotStatus;
  taskId?: string;
}

export interface ChargingSpot {
  id: string;
  label: string;
  robotId?: string;
  heldBy?: string; // 班长维护锁定
}

export interface Instrument {
  id: string;
  name: string;
  type: InstrumentType;
  calibration: Calibration;
  borrowedByTaskId?: string;
}

export interface Task {
  id: string;
  room: string;
  kind: string;
  instrumentType: InstrumentType;
  robotId?: string;
  instrumentId?: string;
  status: TaskStatus;
  progress: number;
  note?: string;
  generation: number; // 失效重排次数
}

export interface FieldRecord {
  id: string; // 幂等键：重复回传只入账一次
  taskId: string;
  instrumentId: string;
  robotId: string;
  summary: string;
  progress: number;
}

export interface Conflict {
  id: string;
  taskId: string;
  recordId: string;
  systemInstrumentId: string;
  fieldInstrumentId: string;
  fieldRecord: FieldRecord;
  resolvedBy?: "system" | "field";
}

export interface AuditEntry {
  id: number;
  time: string;
  actor: string;
  action: string;
  result: "ok" | "rejected" | "info";
}

export interface SyncEntry {
  id: number;
  text: string;
  kind: "merged" | "duplicate" | "conflict" | "info";
}

export interface Toast {
  text: string;
  kind: "ok" | "rejected" | "info";
}

export interface State {
  role: Role;
  online: boolean;
  robots: Robot[];
  spots: ChargingSpot[];
  instruments: Instrument[];
  tasks: Task[];
  ledger: FieldRecord[]; // 已入账现场记录
  outbox: FieldRecord[]; // 断网暂存
  conflicts: Conflict[];
  audit: AuditEntry[];
  syncLog: SyncEntry[];
  toast?: Toast;
  seq: { task: number; record: number; conflict: number; audit: number; sync: number };
}

export const BATTERY_LOW = 40;

export const ROLE_LABEL: Record<Role, string> = {
  inspector: "巡检员",
  supervisor: "班长",
  auditor: "审计员",
};

export const ROLE_HINT: Record<Role, string> = {
  inspector: "可派发/回传任务，不可占用充电位、不可改校准",
  supervisor: "可占用充电位、确认校准、裁决冲突",
  auditor: "只读，任何写操作都会被拒绝",
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "待派发",
  queued: "排队中",
  dispatched: "已下发未开始",
  "in-progress": "进行中",
  blocked: "待班长裁决",
  done: "已完成",
  invalidated: "已失效",
};

export const ROBOT_STATUS_LABEL: Record<RobotStatus, string> = {
  idle: "空闲",
  working: "作业中",
  charging: "充电中",
  "charge-waiting": "排队等充电",
};

export const CALIBRATION_LABEL: Record<Calibration, string> = {
  confirmed: "校准已确认",
  pending: "校准待确认",
  expired: "校准已过期",
};

export const INSTRUMENT_TYPE_LABEL: Record<InstrumentType, string> = {
  particle: "粒子计数",
  pressure: "压差",
  thermal: "温湿度",
};

export type Action =
  | { type: "SET_ROLE"; role: Role }
  | { type: "DISMISS_TOAST" }
  | { type: "TOGGLE_ONLINE" }
  | { type: "TICK" }
  | { type: "SIMULATE_UPLOAD" }
  | { type: "ADD_TASK"; room: string; kind: string; instrumentType: InstrumentType }
  | { type: "DISPATCH"; taskId: string }
  | { type: "START"; taskId: string }
  | { type: "REPORT"; taskId: string }
  | { type: "COMPLETE"; taskId: string }
  | { type: "OCCUPY_SPOT"; spotId: string }
  | { type: "RELEASE_SPOT"; spotId: string }
  | { type: "CALIBRATION"; instrumentId: string; status: Calibration }
  | { type: "RESOLVE"; conflictId: string; choice: "system" | "field" };

const ACTION_LABEL: Record<string, string> = {
  ADD_TASK: "新建任务",
  DISPATCH: "派发任务",
  START: "开始巡检",
  REPORT: "回传进度",
  COMPLETE: "完成任务",
  OCCUPY_SPOT: "占用充电位",
  RELEASE_SPOT: "释放充电位",
  CALIBRATION: "变更校准确认",
  RESOLVE: "裁决冲突",
};

export const initialState: State = {
  role: "inspector",
  online: true,
  robots: [
    { id: "R-01", name: "甲壳虫 1 号", battery: 72, status: "working", taskId: "T-2604" },
    { id: "R-02", name: "甲壳虫 2 号", battery: 35, status: "charging" },
    { id: "R-03", name: "甲壳虫 3 号", battery: 58, status: "idle" },
  ],
  spots: [
    { id: "C1", label: "充电位 C1", robotId: "R-02" },
    { id: "C2", label: "充电位 C2" },
  ],
  instruments: [
    { id: "PC-301", name: "粒子计数器", type: "particle", calibration: "confirmed", borrowedByTaskId: "T-2604" },
    { id: "PC-302", name: "粒子计数器", type: "particle", calibration: "pending" },
    { id: "DP-105", name: "微压差计", type: "pressure", calibration: "confirmed" },
    { id: "TH-88", name: "温湿度记录仪", type: "thermal", calibration: "expired" },
  ],
  tasks: [
    { id: "T-2601", room: "CR-1201", kind: "0.5μm 粒子巡检", instrumentType: "particle", status: "pending", progress: 0, generation: 1, note: "夜班排班，等待派发" },
    { id: "T-2602", room: "CR-2107", kind: "压差巡检", instrumentType: "pressure", status: "pending", progress: 0, generation: 1, note: "夜班排班，等待派发" },
    { id: "T-2603", room: "Y-0302", kind: "温湿度复测", instrumentType: "thermal", status: "pending", progress: 0, generation: 1, note: "夜班排班，等待派发" },
    { id: "T-2604", room: "CR-1201", kind: "粒子复检", instrumentType: "particle", robotId: "R-01", instrumentId: "PC-301", status: "in-progress", progress: 40, generation: 1 },
  ],
  ledger: [
    { id: "FR-9001", taskId: "T-2604", instrumentId: "PC-301", robotId: "R-01", summary: "CR-1201 粒子复检 进度 20%", progress: 20 },
    { id: "FR-9002", taskId: "T-2604", instrumentId: "PC-301", robotId: "R-01", summary: "CR-1201 粒子复检 进度 40%", progress: 40 },
  ],
  outbox: [],
  conflicts: [],
  audit: [
    { id: 1, time: "22:00:00", actor: "系统", action: "夜间巡检班次开始，调度台上线", result: "info" },
    { id: 2, time: "22:05:12", actor: "系统", action: "甲壳虫 2 号 电量 35% 低于 40%，自动申请充电 → 充电位 C1", result: "ok" },
  ],
  syncLog: [{ id: 1, text: "基站链路正常，历史记录已入账", kind: "info" }],
  seq: { task: 2605, record: 9003, conflict: 1, audit: 3, sync: 2 },
};

// ---------- 基础工具 ----------

function now(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function alloc(state: State, kind: keyof State["seq"], prefix: string): [string, State] {
  const n = state.seq[kind];
  return [`${prefix}-${n}`, { ...state, seq: { ...state.seq, [kind]: n + 1 } }];
}

function pushAudit(state: State, actor: string, action: string, result: AuditEntry["result"]): State {
  const entry: AuditEntry = { id: state.seq.audit, time: now(), actor, action, result };
  return {
    ...state,
    seq: { ...state.seq, audit: state.seq.audit + 1 },
    audit: [entry, ...state.audit].slice(0, 60),
  };
}

function pushSync(state: State, text: string, kind: SyncEntry["kind"]): State {
  const entry: SyncEntry = { id: state.seq.sync, text, kind };
  return {
    ...state,
    seq: { ...state.seq, sync: state.seq.sync + 1 },
    syncLog: [entry, ...state.syncLog].slice(0, 40),
  };
}

function withToast(state: State, text: string, kind: Toast["kind"]): State {
  return { ...state, toast: { text, kind } };
}

function updateTask(state: State, id: string, patch: Partial<Task>): State {
  return { ...state, tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

function updateRobot(state: State, id: string, patch: Partial<Robot>): State {
  return { ...state, robots: state.robots.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
}

function updateInstrument(state: State, id: string, patch: Partial<Instrument>): State {
  return { ...state, instruments: state.instruments.map((i) => (i.id === id ? { ...i, ...patch } : i)) };
}

function spotFree(spot: ChargingSpot): boolean {
  return !spot.robotId && !spot.heldBy;
}

// ---------- 充电联动 ----------

function requestCharge(state: State, robot: Robot): State {
  const spot = state.spots.find(spotFree);
  if (spot) {
    let s = {
      ...state,
      spots: state.spots.map((sp) => (sp.id === spot.id ? { ...sp, robotId: robot.id } : sp)),
    };
    s = updateRobot(s, robot.id, { status: "charging" });
    return pushAudit(s, "系统", `${robot.name} 电量 ${robot.battery}% 低于 ${BATTERY_LOW}%，申请充电 → ${spot.label}`, "ok");
  }
  let s = updateRobot(state, robot.id, { status: "charge-waiting" });
  s = pushAudit(s, "系统", `${robot.name} 电量 ${robot.battery}% 需充电，但充电位容量已满，排队等待`, "info");
  return s;
}

// 每次状态变化后兜底：低电量机器人申请充电、等位机器人补位、排队任务重试下发
function sweep(state: State): State {
  let s = state;
  for (const robot of s.robots) {
    if (robot.status === "idle" && robot.battery < BATTERY_LOW) {
      s = requestCharge(s, robot);
    }
  }
  for (const robot of s.robots) {
    if (robot.status === "charge-waiting") {
      const spot = s.spots.find(spotFree);
      if (spot) {
        s = {
          ...s,
          spots: s.spots.map((sp) => (sp.id === spot.id ? { ...sp, robotId: robot.id } : sp)),
        };
        s = updateRobot(s, robot.id, { status: "charging" });
        s = pushAudit(s, "系统", `${robot.name} 补位 ${spot.label}，开始充电`, "info");
      }
    }
  }
  for (const task of s.tasks) {
    if (task.status === "queued") {
      s = attemptDispatch(s, task.id, "系统");
    }
  }
  return s;
}

// ---------- 任务下发 ----------

function attemptDispatch(state: State, taskId: string, actor: string): State {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task || (task.status !== "pending" && task.status !== "queued")) return state;

  let robot: Robot | undefined;
  if (task.robotId) {
    const preset = state.robots.find((r) => r.id === task.robotId);
    if (preset && preset.status === "idle" && preset.battery >= BATTERY_LOW) robot = preset;
  }
  if (!robot) robot = state.robots.find((r) => r.status === "idle" && r.battery >= BATTERY_LOW);
  if (!robot) {
    const spotsFull = state.spots.every((sp) => !spotFree(sp));
    const anyCharging = state.robots.some((r) => r.status === "charging" || r.status === "charge-waiting");
    const note = anyCharging
      ? spotsFull
        ? "机器人电量不足且充电位容量已满，任务先排队，不能下发"
        : "机器人充电中，任务排队等待"
      : "无电量 ≥40% 的空闲机器人，任务排队";
    return updateTask(state, taskId, { status: "queued", note });
  }

  let instrument: Instrument | undefined;
  if (task.instrumentId) {
    const preset = state.instruments.find((i) => i.id === task.instrumentId);
    if (preset && preset.calibration === "confirmed" && (!preset.borrowedByTaskId || preset.borrowedByTaskId === task.id)) {
      instrument = preset;
    }
  }
  if (!instrument) {
    instrument = state.instruments.find(
      (i) => i.type === task.instrumentType && i.calibration === "confirmed" && !i.borrowedByTaskId
    );
  }
  if (!instrument) {
    return updateTask(state, taskId, {
      status: "queued",
      note: "无可用仪器（校准未确认或已被机器人/复检员借用），任务排队",
    });
  }

  let s = updateRobot(state, robot.id, { status: "working", taskId: task.id });
  s = updateInstrument(s, instrument.id, { borrowedByTaskId: task.id });
  s = updateTask(s, taskId, {
    status: "dispatched",
    robotId: robot.id,
    instrumentId: instrument.id,
    note: undefined,
  });
  return pushAudit(s, actor, `${task.id} 下发 ${robot.name}，借用仪器 ${instrument.id}`, "ok");
}

// ---------- 校准确认变化：未开始任务失效并按可用仪器重排 ----------

function calibrationChange(state: State, instrumentId: string, status: Calibration, actor: string): State {
  const instrument = state.instruments.find((i) => i.id === instrumentId);
  if (!instrument || instrument.calibration === status) return state;

  let s = updateInstrument(state, instrumentId, { calibration: status });
  s = pushAudit(s, actor, `${instrument.id} ${instrument.name} 校准确认 → ${CALIBRATION_LABEL[status]}`, "ok");

  if (status !== "confirmed") {
    const affected = s.tasks.filter(
      (t) => t.instrumentId === instrumentId && (t.status === "pending" || t.status === "queued" || t.status === "dispatched")
    );
    const running = s.tasks.some((t) => t.instrumentId === instrumentId && t.status === "in-progress");
    if (running) {
      s = pushAudit(s, "系统", `${instrumentId} 有进行中任务，不受影响，建议完成后复检`, "info");
    }
    for (const t of affected) {
      s = updateTask(s, t.id, { status: "invalidated", note: `仪器 ${instrumentId} 校准确认变化，未开始任务立即失效` });
      s = pushAudit(s, "系统", `${t.id} 未开始，立即失效`, "info");
      if (instrument.borrowedByTaskId === t.id) {
        s = updateInstrument(s, instrumentId, { borrowedByTaskId: undefined });
      }
      if (t.robotId) {
        const robot = s.robots.find((r) => r.id === t.robotId);
        if (robot && robot.taskId === t.id) {
          s = updateRobot(s, robot.id, { status: "idle", taskId: undefined });
        }
      }
      // 按可用仪器重排：生成新一代任务
      const [newId, s1] = alloc(s, "task", "T");
      s = s1;
      const alt = s.instruments.find(
        (i) => i.type === t.instrumentType && i.calibration === "confirmed" && !i.borrowedByTaskId
      );
      const newTask: Task = {
        id: newId,
        room: t.room,
        kind: t.kind,
        instrumentType: t.instrumentType,
        status: "pending",
        progress: 0,
        generation: t.generation + 1,
        instrumentId: alt?.id,
        note: alt ? `由 ${t.id} 失效重排，改用可用仪器 ${alt.id}` : `由 ${t.id} 失效重排，暂无可用仪器，等待重排`,
      };
      s = { ...s, tasks: [...s.tasks, newTask] };
      s = pushAudit(s, "系统", `${t.id} 重排为 ${newId}${alt ? `，改用 ${alt.id}` : "，等待可用仪器"}`, "info");
      s = attemptDispatch(s, newId, "系统");
    }
  }
  return sweep(s);
}

// ---------- 断网暂存与合并 ----------

function mergeRecord(state: State, record: FieldRecord): State {
  // 幂等：重复回传只入账一次
  if (state.ledger.some((r) => r.id === record.id)) {
    return pushSync(state, `${record.id} 重复回传，只入账一次，本次忽略`, "duplicate");
  }
  const task = state.tasks.find((t) => t.id === record.taskId);
  if (!task) {
    return pushSync(state, `${record.id} 任务号 ${record.taskId} 不存在，记录搁置待查`, "info");
  }
  // 仪器号与任务号对不上：两版都留，班长裁决前任务阻断
  if (task.instrumentId && record.instrumentId !== task.instrumentId) {
    const [cid, s1] = alloc(state, "conflict", "CF");
    const conflict: Conflict = {
      id: cid,
      taskId: task.id,
      recordId: record.id,
      systemInstrumentId: task.instrumentId,
      fieldInstrumentId: record.instrumentId,
      fieldRecord: record,
    };
    let s: State = { ...s1, conflicts: [...s1.conflicts, conflict] };
    s = updateTask(s, task.id, {
      status: "blocked",
      note: `仪器号对不上（系统 ${task.instrumentId} / 现场 ${record.instrumentId}），两版保留，待班长选完才能继续`,
    });
    s = pushSync(s, `${record.id} 仪器号与任务号对不上，两版保留，待班长裁决`, "conflict");
    return pushAudit(s, "系统", `${task.id} 阻断：等待班长在 ${cid} 中选择版本`, "info");
  }
  let s: State = { ...state, ledger: [...state.ledger, record] };
  s = updateTask(s, task.id, { progress: Math.max(task.progress, record.progress) });
  return pushSync(s, `${record.id} 入账：${record.summary}`, "merged");
}

function toggleOnline(state: State): State {
  if (state.online) {
    let s: State = { ...state, online: false };
    s = pushAudit(s, "基站", "基站断网：现场任务进度继续留在本地暂存", "info");
    return withToast(s, "基站已断网：任务进度将暂存本地，恢复后自动合并", "info");
  }
  let s: State = { ...state, online: true };
  const pending = s.outbox;
  s = { ...s, outbox: [] };
  s = pushAudit(s, "基站", `基站恢复联网，合并 ${pending.length} 条现场记录`, "info");
  if (pending.length === 0) {
    s = pushSync(s, "恢复联网：无待合并记录", "info");
  }
  for (const record of pending) {
    s = mergeRecord(s, record);
  }
  return withToast(s, "已恢复联网，现场记录合并完成", "ok");
}

function simulateUpload(state: State): State {
  const task = state.tasks.find((t) => t.status === "in-progress" && t.instrumentId && t.robotId);
  if (!task || !task.instrumentId || !task.robotId) {
    return withToast(state, "没有进行中的任务，无法模拟现场回传", "info");
  }
  let s = state;
  const records: FieldRecord[] = [];
  // 1) 正常新记录
  const [rid, s1] = alloc(s, "record", "FR");
  s = s1;
  const nextProgress = Math.min(100, task.progress + 20);
  records.push({
    id: rid,
    taskId: task.id,
    instrumentId: task.instrumentId,
    robotId: task.robotId,
    summary: `${task.room} ${task.kind} 进度 ${nextProgress}%`,
    progress: nextProgress,
  });
  // 2) 重复回传（与账上最后一条同号）
  const last = s.ledger[s.ledger.length - 1];
  if (last) records.push(last);
  // 3) 复检员拿错仪器：仪器号与任务号对不上
  const other = s.instruments.find((i) => i.id !== task.instrumentId);
  if (other) {
    const [rid2, s2] = alloc(s, "record", "FR");
    s = s2;
    records.push({
      id: rid2,
      taskId: task.id,
      instrumentId: other.id,
      robotId: task.robotId,
      summary: `复检员现场回传（仪器 ${other.id}）`,
      progress: Math.min(100, task.progress + 35),
    });
  }
  if (s.online) {
    s = pushAudit(s, "现场基站", `在线回传 ${records.length} 条记录`, "info");
    for (const r of records) s = mergeRecord(s, r);
    return s;
  }
  s = { ...s, outbox: [...s.outbox, ...records] };
  s = pushAudit(s, "现场基站", `断网中，${records.length} 条现场记录暂存本地`, "info");
  return withToast(s, `断网中：${records.length} 条现场记录已暂存，恢复联网后合并`, "info");
}

// ---------- 班长裁决 ----------

function resolveConflict(state: State, conflictId: string, choice: "system" | "field", actor: string): State {
  const conflict = state.conflicts.find((c) => c.id === conflictId);
  if (!conflict || conflict.resolvedBy) return state;
  const task = state.tasks.find((t) => t.id === conflict.taskId);
  if (!task) return state;

  let s: State = {
    ...state,
    conflicts: state.conflicts.map((c) => (c.id === conflictId ? { ...c, resolvedBy: choice } : c)),
  };
  const chosenInstrument = choice === "field" ? conflict.fieldInstrumentId : conflict.systemInstrumentId;

  if (choice === "field" && task.instrumentId !== conflict.fieldInstrumentId) {
    if (task.instrumentId) {
      s = updateInstrument(s, task.instrumentId, { borrowedByTaskId: undefined });
    }
    s = updateInstrument(s, conflict.fieldInstrumentId, { borrowedByTaskId: task.id });
    s = updateTask(s, task.id, { instrumentId: conflict.fieldInstrumentId });
  }
  s = pushAudit(
    s,
    actor,
    `${conflict.id} 裁决：采用${choice === "field" ? "现场" : "系统"}版（仪器 ${chosenInstrument}），任务继续`,
    "ok"
  );
  // 按选定版本入账，只入账一次
  if (!s.ledger.some((r) => r.id === conflict.recordId)) {
    const record = { ...conflict.fieldRecord, instrumentId: chosenInstrument };
    s = { ...s, ledger: [...s.ledger, record] };
    s = updateTask(s, task.id, { progress: Math.max(task.progress, record.progress) });
    s = pushSync(s, `${record.id} 按班长裁决入账（仪器 ${chosenInstrument}）`, "merged");
  }
  s = updateTask(s, task.id, { status: "in-progress", note: undefined });
  return withToast(s, `${conflict.id} 已裁决，任务 ${task.id} 继续`, "ok");
}

// ---------- 时间推进 ----------

function tick(state: State): State {
  let s = state;
  for (const robot of s.robots) {
    if (robot.status === "working") {
      s = updateRobot(s, robot.id, { battery: Math.max(0, robot.battery - 12) });
    } else if (robot.status === "idle") {
      s = updateRobot(s, robot.id, { battery: Math.max(0, robot.battery - 4) });
    } else if (robot.status === "charge-waiting") {
      s = updateRobot(s, robot.id, { battery: Math.max(0, robot.battery - 2) });
    } else if (robot.status === "charging") {
      const nb = Math.min(100, robot.battery + 30);
      s = updateRobot(s, robot.id, { battery: nb });
      if (nb >= 100) {
        s = updateRobot(s, robot.id, { status: "idle" });
        s = { ...s, spots: s.spots.map((sp) => (sp.robotId === robot.id ? { ...sp, robotId: undefined } : sp)) };
        s = pushAudit(s, "系统", `${robot.name} 充电完成，释放充电位`, "info");
      }
    }
  }
  for (const robot of s.robots) {
    if (robot.status === "working" && robot.battery < BATTERY_LOW) {
      s = pushAudit(s, "系统", `${robot.name} 电量 ${robot.battery}% 低于 ${BATTERY_LOW}%，本任务完成后将申请充电`, "info");
    }
  }
  return sweep(s);
}

// ---------- Reducer ----------

function reject(state: State, actor: string, actionType: string, reason: string): State {
  const label = ACTION_LABEL[actionType] ?? actionType;
  const s = pushAudit(state, actor, `${label} 被拒绝：${reason}`, "rejected");
  return withToast(s, `${label}被拒绝：${reason}`, "rejected");
}

export function reducer(state: State, action: Action): State {
  // 模拟器控制（断网/时间/现场回传）与角色切换对所有角色开放
  switch (action.type) {
    case "SET_ROLE":
      return { ...state, role: action.role, toast: { text: `已切换为${ROLE_LABEL[action.role]}：${ROLE_HINT[action.role]}`, kind: "info" } };
    case "DISMISS_TOAST":
      return { ...state, toast: undefined };
    case "TOGGLE_ONLINE":
      return toggleOnline(state);
    case "TICK":
      return tick(state);
    case "SIMULATE_UPLOAD":
      return simulateUpload(state);
    default:
      break;
  }

  const actor = ROLE_LABEL[state.role];

  // 审计员只读
  if (state.role === "auditor") {
    return reject(state, actor, action.type, "审计员只读，不能改动调度数据");
  }
  // 充电位占用/释放、校准确认、冲突裁决仅班长
  if (
    (action.type === "OCCUPY_SPOT" || action.type === "RELEASE_SPOT" || action.type === "CALIBRATION" || action.type === "RESOLVE") &&
    state.role !== "supervisor"
  ) {
    const reason =
      action.type === "OCCUPY_SPOT" || action.type === "RELEASE_SPOT"
        ? "巡检员越权占用充电位，仅班长可操作"
        : "仅班长可执行，需要班长权限";
    return reject(state, actor, action.type, reason);
  }

  switch (action.type) {
    case "ADD_TASK": {
      if (!action.room.trim() || !action.kind.trim()) {
        return withToast(state, "请填写房间编号和巡检内容", "rejected");
      }
      const [id, s1] = alloc(state, "task", "T");
      const task: Task = {
        id,
        room: action.room.trim(),
        kind: action.kind.trim(),
        instrumentType: action.instrumentType,
        status: "pending",
        progress: 0,
        generation: 1,
        note: "新建任务，等待派发",
      };
      const s: State = { ...s1, tasks: [...s1.tasks, task] };
      return pushAudit(s, actor, `新建任务 ${id}（${task.room} ${task.kind}）`, "ok");
    }
    case "DISPATCH": {
      const s = attemptDispatch(state, action.taskId, actor);
      const task = s.tasks.find((t) => t.id === action.taskId);
      if (task && task.status !== "dispatched") {
        const s2 = pushAudit(s, actor, `派发 ${action.taskId} 未成功：${task.note ?? "条件不满足"}`, "info");
        return withToast(s2, task.note ?? "任务不能下发", "info");
      }
      return s;
    }
    case "START": {
      const task = state.tasks.find((t) => t.id === action.taskId);
      if (!task || task.status !== "dispatched") return state;
      const s = updateTask(state, task.id, { status: "in-progress" });
      return pushAudit(s, actor, `${task.id} 开始巡检`, "ok");
    }
    case "REPORT": {
      const task = state.tasks.find((t) => t.id === action.taskId);
      if (!task) return state;
      if (task.status === "blocked") {
        return withToast(state, "任务阻断中：仪器号两版待班长选完才能继续", "rejected");
      }
      if (task.status !== "in-progress" || !task.instrumentId || !task.robotId) {
        return withToast(state, "任务未在进行中，不能回传进度", "rejected");
      }
      const progress = Math.min(100, task.progress + 20);
      const [rid, s1] = alloc(state, "record", "FR");
      const record: FieldRecord = {
        id: rid,
        taskId: task.id,
        instrumentId: task.instrumentId,
        robotId: task.robotId,
        summary: `${task.room} ${task.kind} 进度 ${progress}%`,
        progress,
      };
      let s = s1;
      if (s.online) {
        s = pushAudit(s, actor, `${task.id} 回传进度 ${progress}%`, "ok");
        return mergeRecord(s, record);
      }
      s = { ...s, outbox: [...s.outbox, record] };
      s = pushAudit(s, actor, `${task.id} 进度 ${progress}% 暂存本地（基站断网）`, "info");
      return withToast(s, "基站断网：进度已暂存本地，恢复联网后自动合并", "info");
    }
    case "COMPLETE": {
      const task = state.tasks.find((t) => t.id === action.taskId);
      if (!task || task.status !== "in-progress") {
        return withToast(state, "任务未在进行中，不能完成", "rejected");
      }
      let s = updateTask(state, task.id, { status: "done", progress: 100, note: undefined });
      if (task.instrumentId) s = updateInstrument(s, task.instrumentId, { borrowedByTaskId: undefined });
      if (task.robotId) s = updateRobot(s, task.robotId, { status: "idle", taskId: undefined });
      s = pushAudit(s, actor, `${task.id} 完成，仪器 ${task.instrumentId ?? "-"} 已归还`, "ok");
      return sweep(s);
    }
    case "OCCUPY_SPOT": {
      const spot = state.spots.find((sp) => sp.id === action.spotId);
      if (!spot) return state;
      if (!spotFree(spot)) {
        return withToast(state, `${spot.label} 已被占用`, "rejected");
      }
      let s: State = {
        ...state,
        spots: state.spots.map((sp) => (sp.id === spot.id ? { ...sp, heldBy: actor } : sp)),
      };
      s = pushAudit(s, actor, `占用 ${spot.label}（维护锁定）`, "ok");
      return sweep(s);
    }
    case "RELEASE_SPOT": {
      const spot = state.spots.find((sp) => sp.id === action.spotId);
      if (!spot) return state;
      if (spot.robotId) {
        return reject(state, actor, action.type, `${spot.label} 上机器人正在充电，不能释放`);
      }
      if (!spot.heldBy) return state;
      let s: State = {
        ...state,
        spots: state.spots.map((sp) => (sp.id === spot.id ? { ...sp, heldBy: undefined } : sp)),
      };
      s = pushAudit(s, actor, `释放 ${spot.label}`, "ok");
      return sweep(s);
    }
    case "CALIBRATION":
      return calibrationChange(state, action.instrumentId, action.status, actor);
    case "RESOLVE":
      return resolveConflict(state, action.conflictId, action.choice, actor);
    default:
      return state;
  }
}
