import { useEffect, useMemo, useReducer, useState } from "react";
import "./styles.css";
import { Action, INSPECTORS, LOW_BATTERY, FULL_BATTERY, executorName, initialState, isReadonly, reducer, uid } from "./engine";
import { AppState, Role, Task } from "./types";

const ROLES: Role[] = ["巡检员", "厂务工程师", "班组长", "审计员"];
const INSTRUMENT_KINDS = ["尘埃粒子计数器", "微压差计", "温湿度记录仪"];
const ISO_CLASSES = ["ISO 5", "ISO 6", "ISO 7", "黄光区"];

const STATUS_TEXT: Record<Task["status"], string> = {
  pending: "待下发",
  queued: "排队中",
  dispatched: "进行中",
  done: "已完成",
};

function fmtTime(t: number) {
  return new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState("班组长"));
  const readonly = isReadonly(state.role);

  // 充电推进：每 2.5s 充一格（断网不影响本地任务进度与充电）
  useEffect(() => {
    const timer = setInterval(() => dispatch({ type: "tickCharge" }), 2500);
    return () => clearInterval(timer);
  }, []);

  const metrics = useMemo(() => {
    const waiting = state.tasks.filter((t) => t.status === "pending" || t.status === "queued").length;
    const working = state.tasks.filter((t) => t.status === "dispatched").length;
    const chargeWait = state.chargeRequests.filter((r) => r.status === "queued").length;
    const conflicts = state.conflicts.filter((c) => c.status === "open").length;
    return [
      { label: "待下发/排队任务", value: String(waiting), cls: waiting ? "status-watch" : "status-ok" },
      { label: "进行中任务", value: String(working), cls: "status-ok" },
      { label: "充电排队机器人", value: String(chargeWait), cls: chargeWait ? "status-watch" : "status-ok" },
      { label: "待裁决冲突", value: String(conflicts), cls: conflicts ? "status-danger" : "status-ok" },
    ];
  }, [state.tasks, state.chargeRequests, state.conflicts]);

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-09 · 巡检调度台 · port 5109</p>
          <h1>半导体洁净室夜间巡检调度台</h1>
          <p className="subtitle">
            巡检任务、充电位与仪器借用统一编排：低电量自动申请充电、容量满排队、校准确认变更自动重排、断网留存进度、仪器号冲突双版待裁。
          </p>
        </div>
        <div className="stack-card">
          <span>当前角色</span>
          <div className="role-switch">
            {ROLES.map((r) => (
              <button
                key={r}
                className={state.role === r ? "role-btn active" : "role-btn"}
                onClick={() => dispatch({ type: "switchRole", role: r })}
              >
                {r}
              </button>
            ))}
          </div>
          <strong className={readonly ? "ro-badge" : ""}>{readonly ? "🔒 全站只读" : "可操作"}</strong>
        </div>
      </section>

      {!state.online && (
        <div className="offline-banner">⚠ 基站断网：任务进度与现场记录留存本地发件箱，恢复后自动合并，重复回传只入账一次</div>
      )}

      <section className="metrics-grid">
        {metrics.map((m) => (
          <article className="metric-card" key={m.label}>
            <span>{m.label}</span>
            <strong>{m.value}</strong>
            <i className={m.cls} />
          </article>
        ))}
      </section>

      <section className="toolbar panel">
        <div className="net-box">
          <span className={`net-dot ${state.online ? "on" : "off"}`} />
          <strong>{state.online ? "基站在线" : "基站离线"}</strong>
          <button
            className={state.online ? "" : "primary-action"}
            onClick={() => dispatch({ type: "toggleNetwork" })}
            disabled={readonly}
          >
            {state.online ? "模拟断网" : "恢复联网并合并"}
          </button>
        </div>
        <p className="toolbar-hint">
          断网期间所有现场回传进入发件箱；恢复后按「任务号+仪器号+进度+备注」幂等去重。
        </p>
      </section>

      <section className="board">
        <TasksPanel state={state} dispatch={dispatch} />
        <div className="side-col">
          <RobotsPanel state={state} dispatch={dispatch} />
          <ChargePanel state={state} dispatch={dispatch} />
        </div>
        <InstrumentsPanel state={state} dispatch={dispatch} />
      </section>

      <ConflictPanel state={state} dispatch={dispatch} />

      <section className="board bottom">
        <FieldReportPanel state={state} dispatch={dispatch} />
        <OutboxPanel state={state} />
        <LedgerPanel state={state} />
      </section>

      <AuditPanel state={state} />

      <div className="toast-stack">
        {state.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => dispatch({ type: "dismissToast", id: t.id })}>
            {t.kind === "deny" ? "⛔ " : t.kind === "warn" ? "⏳ " : "✓ "}
            {t.text}
          </div>
        ))}
      </div>
    </main>
  );
}

type PanelProps = { state: AppState; dispatch: React.Dispatch<Action> };

/* ---------------- 任务 ---------------- */
function TasksPanel({ state, dispatch }: PanelProps) {
  const [room, setRoom] = useState("");
  const [isoClass, setIsoClass] = useState(ISO_CLASSES[0]);
  const [kind, setKind] = useState(INSTRUMENT_KINDS[0]);
  const readonly = isReadonly(state.role);

  return (
    <section className="panel span-2">
      <div className="section-heading">
        <div>
          <p>任务调度</p>
          <h2>巡检任务队列</h2>
        </div>
      </div>

      <div className="new-task">
        <input placeholder="房间编号，如 CR-3309" value={room} onChange={(e) => setRoom(e.target.value)} disabled={readonly} />
        <select value={isoClass} onChange={(e) => setIsoClass(e.target.value)} disabled={readonly}>
          {ISO_CLASSES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={readonly}>
          {INSTRUMENT_KINDS.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <button
          className="primary-action"
          disabled={readonly || !room.trim()}
          onClick={() => {
            dispatch({ type: "addTask", room: room.trim(), isoClass, instrumentKind: kind });
            setRoom("");
          }}
        >
          新建巡检任务
        </button>
      </div>

      <div className="task-list">
        {state.tasks.map((t) => (
          <TaskCard key={t.id} task={t} state={state} dispatch={dispatch} />
        ))}
      </div>
    </section>
  );
}

function TaskCard({ task, state, dispatch }: { task: Task } & PanelProps) {
  const readonly = isReadonly(state.role);
  const [execPick, setExecPick] = useState("AUTO");
  const [instPick, setInstPick] = useState("AUTO");
  const openConflict = state.conflicts.find((c) => c.id === task.conflictId && c.status === "open");
  const kindInstruments = state.instruments.filter((i) => i.kind === task.instrumentKind);

  return (
    <article className={`task-card status-${task.status}${openConflict ? " conflict" : ""}`}>
      <header>
        <div>
          <h3>{task.id}</h3>
          <p className="task-meta">
            {task.room} · {task.isoClass} · 需「{task.instrumentKind}」
          </p>
        </div>
        <span className={`badge badge-${task.status}`}>{STATUS_TEXT[task.status]}</span>
      </header>

      <div className="task-rows">
        <div>
          <span>执行人</span>
          <strong>{executorName(task.assignee)}</strong>
        </div>
        <div>
          <span>借用仪器</span>
          <strong>{task.instrumentId ?? "—"}</strong>
        </div>
        <div className="progress-cell">
          <span>进度 {task.progress}%</span>
          <div className="progress-track">
            <i style={{ width: `${task.progress}%` }} />
          </div>
        </div>
      </div>

      {task.blockReason && <p className="block-reason">⏳ {task.blockReason}</p>}
      {openConflict && (
        <p className="conflict-reason">
          ⚠ 仪器号对不上：调度 {openConflict.dispatchInstrumentId} / 现场 {openConflict.fieldInstrumentId}，两版并存，
          {state.role === "班组长" ? "请在冲突中心裁决" : "待班组长裁决后才能继续"}
        </p>
      )}

      {task.status !== "done" && (
        <div className="task-actions">
          {task.status !== "dispatched" && (
            <>
              <select value={execPick} onChange={(e) => setExecPick(e.target.value)} disabled={readonly}>
                <option value="AUTO">自动选机器人</option>
                {state.robots.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id}（{r.battery}%）
                  </option>
                ))}
                {INSPECTORS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}（复检员）
                  </option>
                ))}
              </select>
              <select value={instPick} onChange={(e) => setInstPick(e.target.value)} disabled={readonly}>
                <option value="AUTO">自动匹配已确认仪器</option>
                {kindInstruments.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.id}（{i.calibration}
                    {i.borrowedBy ? ` · ${i.borrowedBy}占用` : ""}）
                  </option>
                ))}
              </select>
              <button
                className="primary-action"
                disabled={readonly || !!openConflict}
                onClick={() => {
                  const isInsp = execPick.startsWith("INSP-");
                  dispatch({
                    type: "dispatchTask",
                    taskId: task.id,
                    manualRobotId: execPick === "AUTO" || isInsp ? undefined : execPick,
                    manualAssignee: isInsp ? execPick : undefined,
                    manualInstrumentId: instPick === "AUTO" ? undefined : instPick,
                  });
                }}
              >
                下发
              </button>
            </>
          )}
          {task.status === "dispatched" && (
            <>
              <button disabled={readonly || !!openConflict} onClick={() => dispatch({ type: "advanceProgress", taskId: task.id })}>
                推进巡检 +25%
              </button>
              <button
                className="primary-action"
                disabled={readonly || !!openConflict || task.progress < 100}
                onClick={() => dispatch({ type: "completeTask", taskId: task.id })}
              >
                完成并归还仪器
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}

/* ---------------- 机器人 ---------------- */
function RobotsPanel({ state, dispatch }: PanelProps) {
  const readonly = isReadonly(state.role);
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>机器人编队</p>
          <h2>电量与状态</h2>
        </div>
      </div>
      <div className="robot-list">
        {state.robots.map((r) => {
          const low = r.battery < LOW_BATTERY;
          return (
            <article key={r.id} className={`robot-card ${low ? "low" : ""}`}>
              <header>
                <strong>{r.id}</strong>
                <span className={`badge badge-${r.status === "charging" ? "queued" : r.status === "working" ? "dispatched" : "pending"}`}>
                  {r.status === "idle" ? "空闲" : r.status === "working" ? "作业中" : "充电中"}
                </span>
              </header>
              <div className="battery-row">
                <div className="battery-track">
                  <i className={low ? "low-bat" : ""} style={{ width: `${r.battery}%` }} />
                </div>
                <strong className={low ? "low-text" : ""}>{r.battery}%</strong>
              </div>
              <p className="tiny-hint">{low ? `低于 ${LOW_BATTERY}%：仅可申请充电，不能下发任务` : `电量 ≥ ${LOW_BATTERY}% 可接任务，充满阈值 ${FULL_BATTERY}%`}</p>
              <div className="btn-row">
                <button disabled={readonly} onClick={() => dispatch({ type: "setBattery", robotId: r.id, battery: r.battery - 15 })}>
                  耗电 -15%
                </button>
                <button disabled={readonly} onClick={() => dispatch({ type: "setBattery", robotId: r.id, battery: r.battery + 10 })}>
                  补电 +10%
                </button>
                <button
                  className={low ? "primary-action" : ""}
                  disabled={readonly}
                  title="模拟机器人低电量自动申请（系统行为）"
                  onClick={() => dispatch({ type: "requestCharge", robotId: r.id })}
                >
                  低电量自动申请
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/* ---------------- 充电位 ---------------- */
function ChargePanel({ state, dispatch }: PanelProps) {
  const readonly = isReadonly(state.role);
  const allocated = state.chargeRequests.filter((r) => r.status === "allocated");
  const queued = state.chargeRequests.filter((r) => r.status === "queued");

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>充电调度</p>
          <h2>充电位（容量 {state.dockCapacity}）</h2>
        </div>
      </div>

      <div className="dock-row">
        <button disabled={readonly} onClick={() => dispatch({ type: "setDockCapacity", capacity: state.dockCapacity - 1 })}>
          容量 -1
        </button>
        <button disabled={readonly} onClick={() => dispatch({ type: "setDockCapacity", capacity: state.dockCapacity + 1 })}>
          容量 +1
        </button>
        <button
          className="danger-btn"
          disabled={readonly}
          title="巡检员无权手动占用充电位"
          onClick={() => dispatch({ type: "requestCharge", robotId: state.robots[0]?.id ?? "R-01", actor: state.role })}
        >
          巡检员手动占位（越权）
        </button>
      </div>

      <div className="dock-slots">
        {Array.from({ length: Math.max(1, state.dockCapacity) }, (_, i) => {
          const occ = allocated.find((r) => r.dockNo === i + 1);
          return (
            <div key={i} className={`dock-slot ${occ ? "busy" : "free"}`}>
              <span>{i + 1} 号桩</span>
              <strong>{occ ? occ.robotId : "空闲"}</strong>
              {occ && (
                <button disabled={readonly} onClick={() => dispatch({ type: "releaseCharge", requestId: occ.id })}>
                  结束充电
                </button>
              )}
            </div>
          );
        })}
      </div>

      <p className="tiny-hint">
        {queued.length > 0 ? `排队中：${queued.map((q) => q.robotId).join("、")}（容量满，任务保持排队不能下发）` : "无排队申请"}
      </p>
    </section>
  );
}

/* ---------------- 仪器 ---------------- */
function InstrumentsPanel({ state, dispatch }: PanelProps) {
  const readonly = isReadonly(state.role);
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>仪器借用与校准</p>
          <h2>仪器台账</h2>
        </div>
      </div>
      <div className="inst-list">
        {state.instruments.map((i) => (
          <article key={i.id} className={`inst-card cal-${i.calibration}`}>
            <header>
              <strong>{i.id}</strong>
              <span className={`badge cal-${i.calibration}`}>{i.calibration}</span>
            </header>
            <p className="task-meta">{i.kind}</p>
            <p className="tiny-hint">{i.borrowedBy ? `被任务 ${i.borrowedBy} 借用` : "未借出"}</p>
            <select
              value={i.calibration}
              disabled={readonly}
              onChange={(e) => dispatch({ type: "setCalibration", instrumentId: i.id, calibration: e.target.value as typeof i.calibration })}
            >
              <option>已确认</option>
              <option>待复检</option>
              <option>停用</option>
            </select>
          </article>
        ))}
      </div>
      <p className="tiny-hint">校准确认一变：未开始任务立即失效并按可用仪器重排；进行中任务持机不受影响。</p>
    </section>
  );
}

/* ---------------- 冲突中心 ---------------- */
function ConflictPanel({ state, dispatch }: PanelProps) {
  const open = state.conflicts.filter((c) => c.status === "open");
  if (state.conflicts.length === 0) return null;
  return (
    <section className="panel conflict-center">
      <div className="section-heading">
        <div>
          <p>双版并存</p>
          <h2>仪器号冲突裁决（仅班组长）</h2>
        </div>
      </div>
      <div className="conflict-list">
        {state.conflicts.map((c) => (
          <article key={c.id} className={`conflict-card ${c.status}`}>
            <div className="conflict-versions">
              <div className="version">
                <span>调度台账版</span>
                <strong>{c.dispatchInstrumentId}</strong>
              </div>
              <b className="vs">≠</b>
              <div className="version">
                <span>现场回传版</span>
                <strong>{c.fieldInstrumentId}</strong>
              </div>
            </div>
            <p className="task-meta">
              任务 {c.taskId} · {fmtTime(c.createdAt)}
              {c.status === "resolved" ? ` · 已裁决采用${c.resolution === "dispatch" ? "调度台版" : "现场版"}（${c.resolvedBy}）` : " · 两版都已留档，任务挂起"}
            </p>
            {c.status === "open" && (
              <div className="btn-row">
                <button
                  disabled={state.role !== "班组长"}
                  onClick={() => dispatch({ type: "resolveConflict", conflictId: c.id, resolution: "dispatch" })}
                >
                  采用调度台 {c.dispatchInstrumentId}
                </button>
                <button
                  className="primary-action"
                  disabled={state.role !== "班组长"}
                  onClick={() => dispatch({ type: "resolveConflict", conflictId: c.id, resolution: "field" })}
                >
                  采用现场 {c.fieldInstrumentId}
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {open.length === 0 && <p className="tiny-hint">所有冲突均已裁决。</p>}
    </section>
  );
}

/* ---------------- 现场回传模拟 ---------------- */
function FieldReportPanel({ state, dispatch }: PanelProps) {
  const readonly = isReadonly(state.role);
  const dispatched = state.tasks.filter((t) => t.status === "dispatched");
  const [taskId, setTaskId] = useState(dispatched[0]?.id ?? "");
  const [instrumentId, setInstrumentId] = useState("");
  const [progress, setProgress] = useState(50);
  const [note, setNote] = useState("压差正常，粒子计数复测中");

  useEffect(() => {
    if (!taskId && dispatched[0]) setTaskId(dispatched[0].id);
    if (taskId && !dispatched.some((t) => t.id === taskId) && dispatched[0]) setTaskId(dispatched[0].id);
  }, [dispatched, taskId]);

  const send = (duplicated: boolean, overrideInstrument?: string) => {
    const id = uid("RPT");
    const base = {
      id,
      taskId: taskId || dispatched[0]?.id || "",
      instrumentId: (overrideInstrument ?? instrumentId).trim(),
      progress,
      note,
      source: "现场" as const,
      createdAt: Date.now(),
    };
    if (!base.taskId || !base.instrumentId) return;
    dispatch({ type: "fieldReport", report: base, duplicated });
    if (!duplicated) {
      // 模拟现场重发同一包：验证只入账一次
      setTimeout(() => dispatch({ type: "fieldReport", report: { ...base, id: uid("RPT") }, duplicated: true }), 400);
    }
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>现场设备</p>
          <h2>现场记录回传</h2>
        </div>
      </div>
      <div className="field-form">
        <select value={taskId} onChange={(e) => setTaskId(e.target.value)} disabled={readonly || !dispatched.length}>
          {dispatched.length === 0 && <option>暂无进行中任务</option>}
          {dispatched.map((t) => (
            <option key={t.id} value={t.id}>
              {t.id}（调度仪器 {t.instrumentId}）
            </option>
          ))}
        </select>
        <input placeholder="现场扫码仪器号，如 PC-A02" value={instrumentId} onChange={(e) => setInstrumentId(e.target.value)} disabled={readonly} />
        <label className="range-label">
          进度 {progress}%
          <input type="range" min={0} max={100} step={25} value={progress} onChange={(e) => setProgress(Number(e.target.value))} disabled={readonly} />
        </label>
        <input placeholder="现场备注" value={note} onChange={(e) => setNote(e.target.value)} disabled={readonly} />
        <div className="btn-row">
          <button className="primary-action" disabled={readonly || !dispatched.length || !instrumentId.trim()} onClick={() => send(false)}>
            回传（含自动重发验重）
          </button>
          <button
            disabled={readonly || !dispatched.length}
            onClick={() => {
              const t = state.tasks.find((x) => x.id === (taskId || dispatched[0]?.id));
              if (!t) return;
              const wrong = t.instrumentId === "PC-A01" ? "PC-A09" : "PC-A01";
              dispatch({ type: "simulateMismatchReport", taskId: t.id, fieldInstrumentId: wrong, note });
            }}
          >
            模拟仪器号对不上
          </button>
        </div>
      </div>
    </section>
  );
}

/* ---------------- 发件箱 ---------------- */
function OutboxPanel({ state }: { state: AppState }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>断网续存</p>
          <h2>待同步发件箱（{state.outbox.length}）</h2>
        </div>
      </div>
      <div className="log-list compact">
        {state.outbox.length === 0 && <p className="tiny-hint">暂无回传记录</p>}
        {state.outbox.slice(0, 8).map((o) => (
          <div key={o.id} className={`log-row sync-${o.syncStatus}`}>
            <span className={`badge badge-${o.syncStatus === "synced" ? "done" : o.syncStatus === "duplicate" ? "queued" : "pending"}`}>
              {o.syncStatus === "synced" ? "已同步" : o.syncStatus === "duplicate" ? "重复丢弃" : "待同步"}
            </span>
            <p>
              {o.taskId} · {o.instrumentId} · {o.progress}% · {fmtTime(o.createdAt)}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------- 入账台账 ---------------- */
function LedgerPanel({ state }: { state: AppState }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>幂等入账</p>
          <h2>现场记录台账（{state.ledger.length}）</h2>
        </div>
      </div>
      <div className="log-list compact">
        {state.ledger.length === 0 && <p className="tiny-hint">暂无入账记录</p>}
        {state.ledger.slice(0, 8).map((e) => (
          <div key={e.id} className="log-row">
            <span className="badge badge-dispatched">{e.source}</span>
            <p>
              {e.taskId} · {e.instrumentId} · {e.progress}% · {e.note} · {fmtTime(e.createdAt)}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------- 审计日志 ---------------- */
function AuditPanel({ state }: { state: AppState }) {
  return (
    <section className="panel audit-panel">
      <div className="section-heading">
        <div>
          <p>全程留痕</p>
          <h2>审计日志（审计员可查，只读）</h2>
        </div>
      </div>
      <div className="log-list">
        {state.audit.length === 0 && <p className="tiny-hint">操作后在此留痕</p>}
        {state.audit.slice(0, 30).map((a) => (
          <div key={a.id} className={`log-row ${a.denied ? "denied" : ""}`}>
            <span className="log-time">{fmtTime(a.time)}</span>
            <span className="badge badge-pending">{a.actor}</span>
            <strong>{a.action}</strong>
            <p>{a.detail}</p>
            {a.denied && <span className="deny-tag">已拒绝</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
