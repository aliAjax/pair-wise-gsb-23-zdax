import { useReducer, useState } from "react";
import type { Dispatch } from "react";
import "./styles.css";
import {
  BATTERY_LOW,
  CALIBRATION_LABEL,
  INSTRUMENT_TYPE_LABEL,
  ROBOT_STATUS_LABEL,
  ROLE_HINT,
  ROLE_LABEL,
  TASK_STATUS_LABEL,
  initialState,
  reducer,
} from "./store";
import type { Action, Calibration, InstrumentType, Role, State, Task, TaskStatus } from "./store";

const ROLES: Role[] = ["inspector", "supervisor", "auditor"];
const CALIBRATIONS: Calibration[] = ["confirmed", "pending", "expired"];
const INSTRUMENT_TYPES: InstrumentType[] = ["particle", "pressure", "thermal"];

const TASK_RANK: Record<TaskStatus, number> = {
  blocked: 0,
  "in-progress": 1,
  dispatched: 2,
  queued: 3,
  pending: 4,
  done: 5,
  invalidated: 6,
};

function taskBadge(status: TaskStatus): string {
  switch (status) {
    case "in-progress":
      return "badge badge-ok";
    case "dispatched":
      return "badge badge-info";
    case "queued":
    case "pending":
      return "badge badge-warn";
    case "blocked":
      return "badge badge-danger";
    case "invalidated":
      return "badge badge-muted";
    case "done":
      return "badge badge-done";
  }
}

function batteryClass(battery: number): string {
  if (battery >= BATTERY_LOW) return "ok";
  if (battery >= 20) return "warn";
  return "danger";
}

function Meter({ value, tone }: { value: number; tone: string }) {
  return (
    <div className="meter">
      <i className={tone} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

function Hero({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  return (
    <section className="hero">
      <div>
        <p className="eyebrow">hxwl-09 · port 5109 · 夜班调度</p>
        <h1>半导体洁净室巡检调度台</h1>
        <p className="subtitle">
          巡检任务、充电位与仪器借用联动：电量低于 {BATTERY_LOW}% 自动申请充电，充电位满则任务排队不下发；
          校准确认一变，未开始任务立即失效并按可用仪器重排；断网暂存、恢复合并、重复回传只入账一次。
        </p>
      </div>
      <div className="stack-card">
        <span>当前角色</span>
        <div className="role-switch">
          {ROLES.map((role) => (
            <button
              key={role}
              className={state.role === role ? "role active" : "role"}
              onClick={() => dispatch({ type: "SET_ROLE", role })}
            >
              {ROLE_LABEL[role]}
            </button>
          ))}
        </div>
        <p className="role-hint">{ROLE_HINT[state.role]}</p>
        <span>基站链路</span>
        <div className="hero-actions">
          <button
            className={state.online ? "net online" : "net offline"}
            onClick={() => dispatch({ type: "TOGGLE_ONLINE" })}
          >
            {state.online ? "在线 · 点击断网" : "断网 · 点击恢复合并"}
          </button>
          <button onClick={() => dispatch({ type: "TICK" })}>推进 15 分钟</button>
        </div>
      </div>
    </section>
  );
}

function Metrics({ state }: { state: State }) {
  const inProgress = state.tasks.filter((t) => t.status === "in-progress").length;
  const waiting = state.tasks.filter((t) => t.status === "queued" || t.status === "pending").length;
  const spotsUsed = state.spots.filter((s) => s.robotId || s.heldBy).length;
  const openConflicts = state.conflicts.filter((c) => !c.resolvedBy).length;
  const cards = [
    { label: "进行中任务", value: String(inProgress), tone: "status-ok" },
    { label: "排队 / 待派发", value: String(waiting), tone: "status-watch" },
    { label: "充电位占用", value: `${spotsUsed}/${state.spots.length}`, tone: "status-ok" },
    { label: "待裁决冲突", value: String(openConflicts), tone: openConflicts > 0 ? "status-danger" : "status-ok" },
  ];
  return (
    <section className="metrics-grid">
      {cards.map((card) => (
        <article key={card.label} className="metric-card">
          <span>{card.label}</span>
          <strong>{card.value}</strong>
          <i className={card.tone} />
        </article>
      ))}
    </section>
  );
}

function RobotPanel({ state }: { state: State; dispatch: Dispatch<Action> }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>车队</p>
          <h2>巡检机器人</h2>
        </div>
      </div>
      <div className="stack-list">
        {state.robots.map((robot) => (
          <article key={robot.id} className="unit-card">
            <div className="unit-head">
              <h3>{robot.name}</h3>
              <span className={robot.status === "idle" ? "badge badge-muted" : robot.status === "working" ? "badge badge-ok" : "badge badge-info"}>
                {ROBOT_STATUS_LABEL[robot.status]}
              </span>
            </div>
            <Meter value={robot.battery} tone={batteryClass(robot.battery)} />
            <p className="unit-meta">
              电量 {robot.battery}%{robot.battery < BATTERY_LOW ? `（低于 ${BATTERY_LOW}%，需充电）` : ""}
              {robot.taskId ? ` · 执行 ${robot.taskId}` : ""}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ChargingPanel({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>充电位</p>
          <h2>容量 {state.spots.length} 个</h2>
        </div>
      </div>
      <div className="stack-list">
        {state.spots.map((spot) => {
          const robot = state.robots.find((r) => r.id === spot.robotId);
          const occupied = Boolean(spot.robotId || spot.heldBy);
          return (
            <article key={spot.id} className="unit-card">
              <div className="unit-head">
                <h3>{spot.label}</h3>
                <span className={occupied ? "badge badge-info" : "badge badge-ok"}>
                  {robot ? `充电中 · ${robot.name}` : spot.heldBy ? `维护锁定 · ${spot.heldBy}` : "空闲"}
                </span>
              </div>
              {robot && <Meter value={robot.battery} tone={batteryClass(robot.battery)} />}
              <div className="task-actions">
                {!occupied && (
                  <button onClick={() => dispatch({ type: "OCCUPY_SPOT", spotId: spot.id })}>占用（维护）</button>
                )}
                {spot.heldBy && (
                  <button onClick={() => dispatch({ type: "RELEASE_SPOT", spotId: spot.id })}>释放</button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <p className="panel-note">占用/释放仅班长可操作；巡检员越权占用会被拒绝并记入审计。</p>
    </section>
  );
}

function TaskCard({ task, state, dispatch }: { task: Task; state: State; dispatch: Dispatch<Action> }) {
  const robot = state.robots.find((r) => r.id === task.robotId);
  const instrument = state.instruments.find((i) => i.id === task.instrumentId);
  return (
    <article className="unit-card">
      <div className="unit-head">
        <h3>
          {task.id} · {task.room} {task.kind}
          {task.generation > 1 && <em className="gen">第 {task.generation} 次重排</em>}
        </h3>
        <span className={taskBadge(task.status)}>{TASK_STATUS_LABEL[task.status]}</span>
      </div>
      <Meter value={task.progress} tone="info" />
      <p className="unit-meta">
        进度 {task.progress}% · 需要{INSTRUMENT_TYPE_LABEL[task.instrumentType]}仪器
        {robot ? ` · 机器人 ${robot.name}` : ""}
        {instrument ? ` · 仪器 ${instrument.id}` : ""}
      </p>
      {task.note && <p className="task-note">{task.note}</p>}
      <div className="task-actions">
        {(task.status === "pending" || task.status === "queued") && (
          <button className="primary-action" onClick={() => dispatch({ type: "DISPATCH", taskId: task.id })}>
            派发
          </button>
        )}
        {task.status === "dispatched" && (
          <button className="primary-action" onClick={() => dispatch({ type: "START", taskId: task.id })}>
            开始巡检
          </button>
        )}
        {task.status === "in-progress" && (
          <>
            <button onClick={() => dispatch({ type: "REPORT", taskId: task.id })}>回传进度 +20%</button>
            <button className="primary-action" onClick={() => dispatch({ type: "COMPLETE", taskId: task.id })}>
              完成
            </button>
          </>
        )}
        {task.status === "blocked" && <span className="blocked-hint">待班长在下方裁决后才能继续</span>}
      </div>
    </article>
  );
}

function TaskPanel({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  const [room, setRoom] = useState("CR-1201");
  const [kind, setKind] = useState("");
  const [instrumentType, setInstrumentType] = useState<InstrumentType>("particle");
  const sorted = [...state.tasks].sort((a, b) => TASK_RANK[a.status] - TASK_RANK[b.status] || a.id.localeCompare(b.id));

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>任务队列</p>
          <h2>巡检任务调度</h2>
        </div>
      </div>
      <div className="new-task">
        <input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="房间编号" />
        <input value={kind} onChange={(e) => setKind(e.target.value)} placeholder="巡检内容，如 0.5μm 粒子巡检" />
        <select value={instrumentType} onChange={(e) => setInstrumentType(e.target.value as InstrumentType)}>
          {INSTRUMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {INSTRUMENT_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <button
          className="primary-action"
          onClick={() => {
            dispatch({ type: "ADD_TASK", room, kind, instrumentType });
            setKind("");
          }}
        >
          新增任务
        </button>
      </div>
      <div className="stack-list">
        {sorted.map((task) => (
          <TaskCard key={task.id} task={task} state={state} dispatch={dispatch} />
        ))}
      </div>
    </section>
  );
}

function InstrumentPanel({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>仪器借用</p>
          <h2>仪器与校准确认</h2>
        </div>
      </div>
      <div className="stack-list">
        {state.instruments.map((instrument) => {
          const borrower = state.tasks.find((t) => t.id === instrument.borrowedByTaskId);
          return (
            <article key={instrument.id} className="unit-card">
              <div className="unit-head">
                <h3>
                  {instrument.id} · {instrument.name}
                </h3>
                <span
                  className={
                    instrument.calibration === "confirmed"
                      ? "badge badge-ok"
                      : instrument.calibration === "pending"
                        ? "badge badge-warn"
                        : "badge badge-danger"
                  }
                >
                  {CALIBRATION_LABEL[instrument.calibration]}
                </span>
              </div>
              <p className="unit-meta">
                类型 {INSTRUMENT_TYPE_LABEL[instrument.type]}
                {borrower ? ` · 借出给 ${borrower.id}（${borrower.room}）` : " · 未借出"}
              </p>
              <label className="calibration-select">
                <span>校准确认（仅班长可改，变更即触发未开始任务失效重排）</span>
                <select
                  value={instrument.calibration}
                  onChange={(e) =>
                    dispatch({ type: "CALIBRATION", instrumentId: instrument.id, status: e.target.value as Calibration })
                  }
                >
                  {CALIBRATIONS.map((c) => (
                    <option key={c} value={c}>
                      {CALIBRATION_LABEL[c]}
                    </option>
                  ))}
                </select>
              </label>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ConflictPanel({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>版本冲突</p>
          <h2>待班长裁决（{state.conflicts.filter((c) => !c.resolvedBy).length}）</h2>
        </div>
      </div>
      {state.conflicts.length === 0 && <p className="panel-note">暂无冲突。仪器号与任务号对不上时，两版都会留在这里。</p>}
      <div className="stack-list">
        {state.conflicts.map((conflict) => (
          <article key={conflict.id} className="unit-card">
            <div className="unit-head">
              <h3>{conflict.id} · 任务 {conflict.taskId}</h3>
              <span className={conflict.resolvedBy ? "badge badge-done" : "badge badge-danger"}>
                {conflict.resolvedBy ? "已裁决" : "待裁决"}
              </span>
            </div>
            <div className="version-grid">
              <div className="version">
                <strong>系统版 · 调度台</strong>
                <p>任务号 {conflict.taskId}</p>
                <p>仪器号 {conflict.systemInstrumentId}</p>
              </div>
              <div className="version">
                <strong>现场版 · {conflict.recordId}</strong>
                <p>任务号 {conflict.fieldRecord.taskId}</p>
                <p>仪器号 {conflict.fieldInstrumentId}</p>
              </div>
            </div>
            {conflict.resolvedBy ? (
              <p className="panel-note">已采用{conflict.resolvedBy === "system" ? "系统" : "现场"}版，两版记录均保留备查。</p>
            ) : (
              <div className="task-actions">
                <button onClick={() => dispatch({ type: "RESOLVE", conflictId: conflict.id, choice: "system" })}>
                  采用系统版
                </button>
                <button
                  className="primary-action"
                  onClick={() => dispatch({ type: "RESOLVE", conflictId: conflict.id, choice: "field" })}
                >
                  采用现场版
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function SyncPanel({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>断网容错</p>
          <h2>现场记录暂存与合并</h2>
        </div>
        <div className="task-actions">
          <button onClick={() => dispatch({ type: "SIMULATE_UPLOAD" })}>模拟现场回传（含重复与错号）</button>
          <button className={state.online ? "net online" : "net offline"} onClick={() => dispatch({ type: "TOGGLE_ONLINE" })}>
            {state.online ? "基站在线" : "基站断网"}
          </button>
        </div>
      </div>
      <div className="sync-grid">
        <div>
          <h3 className="subhead">本地暂存（{state.outbox.length}）</h3>
          <div className="log-list">
            {state.outbox.length === 0 && <p className="panel-note">断网期间的任务进度会留在这里，恢复后自动合并。</p>}
            {state.outbox.map((record, index) => (
              <div key={`${record.id}-${index}`} className="log-item">
                <span>{record.id}</span>
                <span>
                  任务 {record.taskId} · 仪器 {record.instrumentId} · {record.summary}
                </span>
              </div>
            ))}
          </div>
          <h3 className="subhead">合并日志</h3>
          <div className="log-list">
            {state.syncLog.map((entry) => (
              <div key={entry.id} className={`log-item log-${entry.kind}`}>
                <span>{entry.text}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h3 className="subhead">已入账记录（{state.ledger.length}）</h3>
          <div className="log-list">
            {state.ledger.map((record) => (
              <div key={record.id} className="log-item log-merged">
                <span>{record.id}</span>
                <span>
                  任务 {record.taskId} · 仪器 {record.instrumentId} · 进度 {record.progress}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function AuditPanel({ state }: { state: State }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>审计</p>
          <h2>操作日志（审计员只读）</h2>
        </div>
      </div>
      <div className="log-list tall">
        {state.audit.map((entry) => (
          <div key={entry.id} className={`log-item audit-${entry.result}`}>
            <span className="when">{entry.time}</span>
            <span className="who">{entry.actor}</span>
            <span>{entry.action}</span>
            <span
              className={
                entry.result === "ok" ? "badge badge-ok" : entry.result === "rejected" ? "badge badge-danger" : "badge badge-muted"
              }
            >
              {entry.result === "ok" ? "通过" : entry.result === "rejected" ? "拒绝" : "记录"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  return (
    <main className="app-shell">
      <Hero state={state} dispatch={dispatch} />

      {state.toast && (
        <div className={`toast toast-${state.toast.kind}`} role="status">
          <span>{state.toast.text}</span>
          <button onClick={() => dispatch({ type: "DISMISS_TOAST" })}>知道了</button>
        </div>
      )}

      <Metrics state={state} />

      <section className="console-grid">
        <div className="column">
          <RobotPanel state={state} dispatch={dispatch} />
          <ChargingPanel state={state} dispatch={dispatch} />
        </div>
        <div className="column">
          <TaskPanel state={state} dispatch={dispatch} />
        </div>
        <div className="column">
          <InstrumentPanel state={state} dispatch={dispatch} />
          <ConflictPanel state={state} dispatch={dispatch} />
        </div>
      </section>

      <div className="bottom-grid">
        <SyncPanel state={state} dispatch={dispatch} />
        <AuditPanel state={state} />
      </div>
    </main>
  );
}

export default App;
