import { build } from 'esbuild';
import { writeFileSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, '.engine.bundle.mjs');
const res = await build({
  entryPoints: [join(here, '..', 'src', 'engine.ts')],
  bundle: true, format: 'esm', write: false, platform: 'node',
});
writeFileSync(bundlePath, res.outputFiles[0].text);
const { initialState, reducer } = await import('file://' + bundlePath);

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra); }
}
const find = (s, id) => s.tasks.find((t) => t.id === id);
const deniedLast = (s) => s.audit[0]?.denied === true;
// 初始：T-1001 自动下发给 R-01，T-1002/T-1003 因 R-02 低电量排队
const bootstrap = () => reducer(initialState('班组长'), { type: 'addTask', room: 'CR-INIT', isoClass: 'ISO 7', instrumentKind: '微压差计' });
// 完成所有进行中任务（复检员不占机器人，可用来快速清空排队任务）
function drainInsp(st, taskId, inspector, instrumentId) {
  st = reducer(st, { type: 'dispatchTask', taskId, manualAssignee: inspector, manualInstrumentId: instrumentId });
  for (let i = 0; i < 4; i++) st = reducer(st, { type: 'advanceProgress', taskId });
  return reducer(st, { type: 'completeTask', taskId });
}
function drainAllRobots(st, max = 20) {
  let n = 0;
  while (n++ < max) {
    const t = st.tasks.find((x) => x.status === 'dispatched');
    if (!t) break;
    for (let i = 0; i < 4; i++) st = reducer(st, { type: 'advanceProgress', taskId: t.id });
    st = reducer(st, { type: 'completeTask', taskId: t.id });
  }
  return st;
}

// 1. 初始自动下发 + 低电量机器人不接任务
let s = bootstrap();
check('1a 有可用机器人时任务自动下发', find(s, 'T-1001').status === 'dispatched' && find(s, 'T-1001').robotId === 'R-01' && find(s, 'T-1001').instrumentId === 'PC-A01');
check('1b 低电量机器人不接任务，其余排队', find(s, 'T-1002').status === 'queued');
check('1c 已确认仪器被借用登记', s.instruments.find((i) => i.id === 'PC-A01').borrowedBy === 'T-1001');

// 2. 低电量自动申请充电
s = reducer(s, { type: 'requestCharge', robotId: 'R-02' });
let ch = s.chargeRequests.find((r) => r.robotId === 'R-02');
check('2a 低电量机器人自动申请并入位', ch.status === 'allocated' && ch.dockNo === 1);
check('2b 入位后机器人 charging', s.robots.find((r) => r.id === 'R-02').status === 'charging');
s = reducer(s, { type: 'releaseCharge', requestId: ch.id });
s = reducer(s, { type: 'setBattery', robotId: 'R-02', battery: 55 });
s = reducer(s, { type: 'requestCharge', robotId: 'R-02' });
check('2c 电量未低于40%不允许申请', deniedLast(s));

// 3. 容量满排队，任务不能下发
s = reducer(s, { type: 'setDockCapacity', capacity: 1 });
s = reducer(s, { type: 'setBattery', robotId: 'R-02', battery: 30 });
s = reducer(s, { type: 'requestCharge', robotId: 'R-02' }); // 占 1 号桩
s = reducer(s, { type: 'setBattery', robotId: 'R-01', battery: 35 });
s = reducer(s, { type: 'requestCharge', robotId: 'R-01' });
ch = s.chargeRequests.find((r) => r.robotId === 'R-01');
check('3a 容量满时新充电申请排队', ch.status === 'queued');
const queuedTask = s.tasks.find((t) => (t.status === 'pending' || t.status === 'queued') && t.id !== 'T-1001');
check('3b 无可用机器人时任务排队不能下发', queuedTask.status === 'queued' && (queuedTask.blockReason || '').length > 0, queuedTask.blockReason);
s = reducer(s, { type: 'dispatchTask', taskId: queuedTask.id, manualRobotId: 'R-01' });
check('3c 作业中机器人手动下发被拒', deniedLast(s) && find(s, queuedTask.id).status === 'queued', s.audit[0]?.detail);
for (let i = 0; i < 4; i++) s = reducer(s, { type: 'advanceProgress', taskId: 'T-1001' });
s = reducer(s, { type: 'completeTask', taskId: 'T-1001' }); // R-01 回库后补位
check('3d 任务完成后低电量机器人自动入位充电', s.chargeRequests.find((r) => r.robotId === 'R-01').status === 'allocated', JSON.stringify(s.chargeRequests.map((r) => ({ id: r.robotId, st: r.status }))));
s = reducer(s, { type: 'dispatchTask', taskId: queuedTask.id, manualRobotId: 'R-01' });
check('3e 等待充电的机器人手动下发被拒并排队', find(s, queuedTask.id).status === 'queued' && /充电/.test(s.audit[0]?.detail || ''), s.audit[0]?.detail);
check('3f 排队充电申请不与作业冲突，回库后才补位', s.chargeRequests.some(r=>r.robotId==='R-02'&&r.status==='queued') && s.chargeRequests.some(r=>r.robotId==='R-01'&&r.status==='allocated'));

// 4. 校准确认一变，未开始任务立即失效重排
let s4 = bootstrap();
s4 = drainInsp(s4, 'T-1002', 'INSP-WQ', 'DP-B01');
s4 = drainInsp(s4, 'T-1003', 'INSP-LM', 'TH-C01');
s4 = reducer(s4, { type: 'setBattery', robotId: 'R-02', battery: 85 });
s4 = drainAllRobots(s4);
check('4pre 初始任务清空、两机器人空闲', s4.tasks.every((t) => t.status === 'done') && s4.robots.every((r) => r.status === 'idle'));

s4 = reducer(s4, { type: 'addTask', room: 'CR-4A', isoClass: 'ISO 5', instrumentKind: '尘埃粒子计数器' });
const tA = s4.tasks.find((t) => t.room === 'CR-4A');
check('4a T-A 自动借用 PC-A01 下发', find(s4, tA.id).status === 'dispatched' && find(s4, tA.id).instrumentId === 'PC-A01' && find(s4, tA.id).robotId === 'R-01');

s4 = reducer(s4, { type: 'addTask', room: 'CR-4B', isoClass: 'ISO 5', instrumentKind: '尘埃粒子计数器' });
const tB = s4.tasks.find((t) => t.room === 'CR-4B');
check('4b 唯一已确认仪器被占用，新任务排队失效', find(s4, tB.id).status === 'queued' && /尘埃粒子计数器/.test(find(s4, tB.id).blockReason || ''), find(s4, tB.id).blockReason);

s4 = reducer(s4, { type: 'setCalibration', instrumentId: 'PC-A02', calibration: '已确认' });
check('4c 新仪器确认后排队任务立即重排下发', find(s4, tB.id).status === 'dispatched' && find(s4, tB.id).instrumentId === 'PC-A02' && find(s4, tB.id).robotId === 'R-02');

s4 = reducer(s4, { type: 'setCalibration', instrumentId: 'PC-A01', calibration: '停用' });
check('4d 进行中任务持机不受校准停用影响', find(s4, tA.id).status === 'dispatched' && find(s4, tA.id).instrumentId === 'PC-A01');

s4 = reducer(s4, { type: 'addTask', room: 'CR-4C', isoClass: 'ISO 5', instrumentKind: '尘埃粒子计数器' });
const tC = s4.tasks.find((t) => t.room === 'CR-4C');
check('4e 无可用已确认仪器，未开始任务失效排队', find(s4, tC.id).status === 'queued' && /尘埃粒子计数器/.test(find(s4, tC.id).blockReason || ''), find(s4, tC.id).blockReason);

for (let i = 0; i < 4; i++) s4 = reducer(s4, { type: 'advanceProgress', taskId: tB.id });
s4 = reducer(s4, { type: 'completeTask', taskId: tB.id });
check('4f 仪器归还后失效任务自动重排下发', find(s4, tC.id).status === 'dispatched' && find(s4, tC.id).instrumentId === 'PC-A02', find(s4, tC.id).status + '/' + find(s4, tC.id).blockReason);

// 5. 审计员只读
let sa = reducer(s, { type: 'switchRole', role: '审计员' });
const before = sa.tasks.length;
sa = reducer(sa, { type: 'addTask', room: 'X', isoClass: 'ISO 7', instrumentKind: '微压差计' });
check('5a 审计员不能新建任务(被拒)', sa.tasks.length === before && deniedLast(sa));
sa = reducer(sa, { type: 'setCalibration', instrumentId: 'DP-B01', calibration: '停用' });
check('5b 审计员不能改校准', sa.instruments.find((i) => i.id === 'DP-B01').calibration === '已确认' && deniedLast(sa));
sa = reducer(sa, { type: 'requestCharge', robotId: 'R-02' });
check('5c 审计员不能申请充电', deniedLast(sa));
check('5d 审计员可查看审计日志', sa.audit.length > 0);

// 6. 巡检员越权占用充电位
let si = reducer(s, { type: 'switchRole', role: '巡检员' });
const reqsBefore = si.chargeRequests.length;
si = reducer(si, { type: 'requestCharge', robotId: 'R-02', actor: '巡检员' });
check('6 巡检员手动占位被拒绝且不产生申请', si.chargeRequests.length === reqsBefore && deniedLast(si), si.audit[0]?.detail);

// 7. 机器人/复检员争用同一台仪器
let s7 = bootstrap();
s7 = reducer(s7, { type: 'addTask', room: 'CR-2', isoClass: 'ISO 5', instrumentKind: '尘埃粒子计数器' });
const tNew2 = s7.tasks.find((t) => t.room === 'CR-2');
check('7a 第二个粒子任务因仪器占用排队', find(s7, tNew2.id).status === 'queued');
s7 = reducer(s7, { type: 'dispatchTask', taskId: tNew2.id, manualAssignee: 'INSP-WQ', manualInstrumentId: 'PC-A01' });
check('7b 复检员抢已借仪器被拒', deniedLast(s7) && s7.instruments.find((i) => i.id === 'PC-A01').borrowedBy === 'T-1001');
s7 = reducer(s7, { type: 'dispatchTask', taskId: tNew2.id, manualAssignee: 'INSP-WQ', manualInstrumentId: 'PC-A02' });
check('7c 借用待复检仪器被拒', deniedLast(s7));
s7 = reducer(s7, { type: 'setCalibration', instrumentId: 'PC-A02', calibration: '已确认' });
s7 = reducer(s7, { type: 'dispatchTask', taskId: tNew2.id, manualAssignee: 'INSP-WQ', manualInstrumentId: 'PC-A02' });
check('7d 复检员借用另一台已确认仪器成功', find(s7, tNew2.id).status === 'dispatched' && find(s7, tNew2.id).assignee === 'INSP-WQ' && s7.instruments.find((i) => i.id === 'PC-A02').borrowedBy === tNew2.id);

// 8. 断网续存 + 恢复合并 + 幂等
let s8 = bootstrap();
s8 = reducer(s8, { type: 'toggleNetwork' });
check('8a 离线', s8.online === false);
const rep = { id: 'r1', taskId: 'T-1001', instrumentId: 'PC-A01', progress: 50, note: '复测中', source: '现场', createdAt: Date.now() };
s8 = reducer(s8, { type: 'fieldReport', report: rep });
s8 = reducer(s8, { type: 'fieldReport', report: { ...rep, id: 'r1-dup' } });
check('8b 离线两条仅进本地发件箱、不入台账、不改进度', s8.outbox.filter((o) => o.taskId === 'T-1001').length === 2 && s8.ledger.length === 0 && find(s8, 'T-1001').progress === 0);
s8 = reducer(s8, { type: 'toggleNetwork' });
check('8c 恢复后只入账一次', s8.ledger.filter((e) => e.dedupKey === 'T-1001|PC-A01|50|复测中').length === 1);
check('8d 发件箱 synced/duplicate 各一', s8.outbox.filter((o) => o.taskId === 'T-1001' && o.syncStatus === 'synced').length === 1 && s8.outbox.some((o) => o.syncStatus === 'duplicate'));
check('8e 合并后进度更新到任务', find(s8, 'T-1001').progress === 50);

let s8f = bootstrap();
const rep2 = { id: 'x1', taskId: 'T-1001', instrumentId: 'PC-A01', progress: 25, note: '在线', source: '现场', createdAt: Date.now() };
s8f = reducer(s8f, { type: 'fieldReport', report: rep2 });
s8f = reducer(s8f, { type: 'fieldReport', report: { ...rep2, id: 'x2' } });
s8f = reducer(s8f, { type: 'fieldReport', report: { ...rep2, id: 'x3' } });
check('8f 在线三次相同回传仅一条入账', s8f.ledger.filter((e) => e.dedupKey === 'T-1001|PC-A01|25|在线').length === 1);

// 9. 仪器号对不上：两版都留、挂起、班长裁决
let s9 = bootstrap();
s9 = reducer(s9, { type: 'simulateMismatchReport', taskId: 'T-1001', fieldInstrumentId: 'PC-A09', note: '现场扫错码' });
const cf = s9.conflicts.find((c) => c.taskId === 'T-1001' && c.status === 'open');
check('9a 冲突生成且双版本保留', !!cf && cf.dispatchInstrumentId === 'PC-A01' && cf.fieldInstrumentId === 'PC-A09');
check('9b 现场版记录已入账并挂接冲突', s9.ledger.some((e) => e.id === cf.ledgerReportId && e.instrumentId === 'PC-A09'));
check('9c 任务挂起', find(s9, 'T-1001').conflictId === cf.id);
s9 = reducer(s9, { type: 'advanceProgress', taskId: 'T-1001' });
check('9d 未裁决不能推进', deniedLast(s9) && find(s9, 'T-1001').progress === 0);
s9 = reducer(s9, { type: 'completeTask', taskId: 'T-1001' });
check('9e 未裁决不能完成', deniedLast(s9) && find(s9, 'T-1001').status === 'dispatched');
let s9i = reducer(s9, { type: 'switchRole', role: '巡检员' });
s9i = reducer(s9i, { type: 'resolveConflict', conflictId: cf.id, resolution: 'field' });
check('9f 非班组长裁决被拒', deniedLast(s9i) && s9i.conflicts.find((c) => c.id === cf.id).status === 'open');
let s9a = reducer(s9, { type: 'switchRole', role: '审计员' });
s9a = reducer(s9a, { type: 'resolveConflict', conflictId: cf.id, resolution: 'field' });
check('9g 审计员裁决被拒', deniedLast(s9a));
s9 = reducer(s9, { type: 'resolveConflict', conflictId: cf.id, resolution: 'field' });
check('9h 选用不存在的仪器被拒', deniedLast(s9) && s9.conflicts.find((c) => c.id === cf.id).status === 'open');
s9 = reducer(s9, { type: 'resolveConflict', conflictId: cf.id, resolution: 'dispatch' });
check('9i 班组长裁决调度版后解除挂起', find(s9, 'T-1001').instrumentId === 'PC-A01' && !find(s9, 'T-1001').conflictId);
s9 = reducer(s9, { type: 'advanceProgress', taskId: 'T-1001' });
check('9j 裁决后任务可继续', find(s9, 'T-1001').progress === 25 && !deniedLast(s9));

let s9k = bootstrap();
s9k = reducer(s9k, { type: 'setCalibration', instrumentId: 'PC-A02', calibration: '已确认' });
s9k = reducer(s9k, { type: 'simulateMismatchReport', taskId: 'T-1001', fieldInstrumentId: 'PC-A02', note: '换机' });
const cf2 = s9k.conflicts[0];
s9k = reducer(s9k, { type: 'resolveConflict', conflictId: cf2.id, resolution: 'field' });
check('9k 裁决采用另一台已确认仪器成功、原机释放', find(s9k, 'T-1001').instrumentId === 'PC-A02' && s9k.instruments.find((i) => i.id === 'PC-A01').borrowedBy === null && s9k.instruments.find((i) => i.id === 'PC-A02').borrowedBy === 'T-1001');

let s9l = bootstrap();
s9l = reducer(s9l, { type: 'toggleNetwork' });
s9l = reducer(s9l, { type: 'simulateMismatchReport', taskId: 'T-1001', fieldInstrumentId: 'PC-A02', note: '离线换机' });
const cfO = s9l.conflicts.find((c) => c.taskId === 'T-1001');
check('9l-1 离线冲突立即挂起、双版留存发件箱', !!cfO && cfO.status === 'open' && find(s9l, 'T-1001').conflictId === cfO.id && s9l.outbox.some((o) => o.pendingConflict));
check('9l-2 离线时现场版暂不入账', s9l.ledger.length === 0);
s9l = reducer(s9l, { type: 'toggleNetwork' });
check('9l-3 恢复后现场版补入账并回填冲突', s9l.ledger.some((e) => e.taskId === 'T-1001' && e.instrumentId === 'PC-A02') && s9l.conflicts.find((c) => c.id === cfO.id).ledgerReportId);
s9l = reducer(s9l, { type: 'setCalibration', instrumentId: 'PC-A02', calibration: '已确认' });
s9l = reducer(s9l, { type: 'resolveConflict', conflictId: cfO.id, resolution: 'field' });
check('9l-4 恢复后可裁决并继续', find(s9l, 'T-1001').instrumentId === 'PC-A02' && !find(s9l, 'T-1001').conflictId);

// 10. 容量满排队 + 回库补位 + 充满自动完成（干净场景：两机器人空闲）
let s10 = bootstrap();
s10 = drainInsp(s10, 'T-1002', 'INSP-WQ', 'DP-B01');
s10 = drainInsp(s10, 'T-1003', 'INSP-LM', 'TH-C01');
s10 = reducer(s10, { type: 'setBattery', robotId: 'R-02', battery: 85 });
s10 = drainAllRobots(s10);
check('10pre 两机器人空闲', s10.robots.every((r) => r.status === 'idle' && r.activeTaskId === null));

s10 = reducer(s10, { type: 'setDockCapacity', capacity: 1 });
s10 = reducer(s10, { type: 'setBattery', robotId: 'R-02', battery: 33 });
s10 = reducer(s10, { type: 'requestCharge', robotId: 'R-02' }); // 占 1 号桩
s10 = reducer(s10, { type: 'setBattery', robotId: 'R-01', battery: 38 });
s10 = reducer(s10, { type: 'requestCharge', robotId: 'R-01' });
check('10a 容量满，R-01 申请排队', s10.chargeRequests.find((r) => r.robotId === 'R-01').status === 'queued');
s10 = reducer(s10, { type: 'tickCharge' });
check('10b 排队期间 R-01 不抢桩、不接任务', s10.chargeRequests.find((r) => r.robotId === 'R-01').status === 'queued' && s10.robots.find((r) => r.id === 'R-01').activeTaskId === null);
for (let i = 0; i < 5; i++) s10 = reducer(s10, { type: 'tickCharge' }); // R-02: 33+12*5=93
const r02d = s10.robots.find((r) => r.id === 'R-02');
check('10c R-02 充满(≥90)充电自动完成', r02d.battery >= 90 && s10.chargeRequests.find((r) => r.robotId === 'R-02').status === 'completed', JSON.stringify({ b: r02d.battery }));
const ch01 = s10.chargeRequests.find((r) => r.robotId === 'R-01');
check('10d 空桩后 R-01 自动补位', ch01.status === 'allocated' && ch01.dockNo === 1 && s10.robots.find((r) => r.id === 'R-01').status === 'charging', JSON.stringify(ch01));
s10 = reducer(s10, { type: 'setDockCapacity', capacity: 0 });
s10 = reducer(s10, { type: 'releaseCharge', requestId: ch01.id });
s10 = reducer(s10, { type: 'setBattery', robotId: 'R-01', battery: 25 }); // 补位充过电，重新拉低
s10 = reducer(s10, { type: 'setBattery', robotId: 'R-02', battery: 20 });
s10 = reducer(s10, { type: 'requestCharge', robotId: 'R-01' });
s10 = reducer(s10, { type: 'requestCharge', robotId: 'R-02' });
check('10e 容量为0时申请只能排队', s10.chargeRequests.filter((r) => r.status === 'queued').length >= 2);
s10 = reducer(s10, { type: 'addTask', room: 'CR-10X', isoClass: 'ISO 6', instrumentKind: '微压差计' });
const t10 = s10.tasks.find((t) => t.room === 'CR-10X');
check('10f 全机器人低电量时新任务排队不能下发', find(s10, t10.id).status === 'queued' && /机器人|充电/.test(find(s10, t10.id).blockReason || ''), find(s10, t10.id).blockReason);

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(bundlePath, { force: true });
process.exit(fail ? 1 : 0);
