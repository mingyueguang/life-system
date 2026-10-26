// Deterministic pre-plan data audit and anomaly guard (no AI involved).
// Runs before plan generation and against submitted plan output, so that
// "completed items that still enter the plan" style problems are caught by
// code, not by the AI's good will. Also produces anomaly signals used by the
// nightly review and the plan tasks (request confirmation, never silently
// auto-adjust beyond agreed scope).
export const norm = s => (typeof s === 'string' ? s : '').trim().toLowerCase().replace(/[\s\u3000\p{P}\p{S}]+/gu, '');

// issues: hard guard rules that must not be silently scheduled again.
// anomalies: soft signals that need user confirmation (severe input drop,
// energy drop, repeated skip, large time overrun). The auto_adjust.enabled
// switch gates anomalies and carryover; it never affects raw data saving.
export function auditContext(d, user, day, {all, recent, adjust = {overrun_factor: 2, energy_drop_threshold: 2, skip_carryover: true}}) {
  const enabled = adjust.enabled !== false;
  const goals = all.filter(r => r.kind === 'goal');
  const tasks = all.filter(r => r.kind === 'task');
  // 被用户否定的记录不是有效规划依据：不作为完成/过期清单或待办引用。
  const reviewed = r => r.metadata?.review?.status === 'rejected';
  const doneGoals = goals.filter(r => !reviewed(r) && r.data.progress >= 100);
  const doneTasks = tasks.filter(r => !reviewed(r) && r.data.done === true);
  const staleGoals = goals.filter(r => !reviewed(r) && r.data.progress < 100 && r.data.due && r.data.due < day);
  const staleTasks = tasks.filter(r => !reviewed(r) && !r.data.done && r.data.due && r.data.due < day);
  const issues = [];
  const anomalies = [];

  // Titles from the previous 7 natural days' confirmed/feedback plans.
  const recentDoneTitles = new Set();
  const recentSkips = {}; // title -> {count, domain}
  const recentOverruns = [];
  // Carryover keyed by a stable identity (task_id when linked, otherwise title
  // as an ambiguous candidate), decided by the LATEST feedback state: once an
  // item is done, earlier skips/partials no longer re-enter the next day.
  const carryover = new Map();
  for (const r of recent) { // recent is ordered newest-day first
    if (!r.plan) continue;
    for (const it of r.plan.items) {
      const fb = r.feedback && r.feedback[it.id];
      if (!fb) continue;
      const key = it.task_id || ('title:' + norm(it.title));
      if (fb.status === 'done') {
        recentDoneTitles.add(norm(it.title));
        if (!carryover.has(key)) carryover.set(key, {done: true, title: it.title, domain: it.domain || null});
        if (enabled && fb.actual_minutes != null && fb.actual_minutes > it.minutes * (adjust.overrun_factor ?? 2)) {
          recentOverruns.push({title: it.title, planned: it.minutes, actual: fb.actual_minutes, day: r.day, domain: it.domain || null});
        }
        continue;
      }
      if (!enabled) continue;
      if (fb.status === 'skipped') {
        const prev = recentSkips[norm(it.title)] || {count: 0, domain: it.domain || null};
        recentSkips[norm(it.title)] = {count: prev.count + 1, domain: it.domain || prev.domain};
      }
      if (adjust.skip_carryover !== false && (fb.status === 'skipped' || fb.status === 'partial')) {
        const existing = carryover.get(key);
        if (existing?.done) continue; // latest state is done → do not carry
        if (!existing) carryover.set(key, {title: it.title, skipped: 1, last: r.day, ambiguous: !it.task_id, domain: it.domain || null});
        else { existing.skipped++; if (r.day > existing.last) existing.last = r.day; }
      }
    }
  }
  const carryoverList = [...carryover.values()].filter(x => !x.done).map(x => ({title: x.title, skipped: x.skipped, last: x.last, ...(x.ambiguous ? {ambiguous: true} : {}), domain: x.domain || null}));
  const guardTitles = new Set();
  const collect = (list, code, label, severity) => {
    const seen = new Set();
    for (const g of list) {
      const t = norm(g.data.title);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      guardTitles.add(t);
      const doneTxt = code.includes('stale')
        ? `${label}「${g.data.title}」已过期且未完成，排入计划前请确认是否继续；确需继续请在 reason 说明理由`
        : `${label}「${g.data.title}」已标记完成（标题匹配仅供参考：周期事项或相似事项不受此限制，仅同名任务通过 task_id 关联时会被硬拦截）`;
      issues.push({code, severity, detail: doneTxt, affected: t});
    }
  };
  collect(doneGoals, 'completed_goal_reused', '目标', 'high');
  collect(doneTasks, 'completed_task_reused', '待办', 'high');
  collect(staleGoals, 'stale_goal_pending', '目标', 'medium');
  collect(staleTasks, 'stale_task_pending', '待办', 'medium');

  // Input / energy anomalies compared with the last 7 days (same weekday ignored).
  if (enabled) {
    const recentInputs = recent.map(r => r.input && r.input.available_minutes).filter(x => Number.isInteger(x));
    const recentEnergy = recent.map(r => r.input && r.input.energy).filter(x => Number.isInteger(x));
    const todayInput = d.prepare('SELECT input FROM daily_days WHERE user_id=? AND day=?').get(user, day)?.input;
    const input = todayInput ? JSON.parse(todayInput) : {};
    if (Number.isInteger(input.available_minutes) && recentInputs.length >= 2) {
      const avg = recentInputs.reduce((a, b) => a + b, 0) / recentInputs.length;
      if (avg > 0 && input.available_minutes < avg * 0.5) {
        anomalies.push({code: 'input_drop', severity: 'medium', detail: `今日可用时间 ${input.available_minutes} 分钟，不足近 7 天均值（${Math.round(avg)}）的一半，请确认计划是否需要缩减或另行调整`});
      }
    }
    if (Number.isInteger(input.energy) && recentEnergy.length >= 2) {
      const avg = recentEnergy.reduce((a, b) => a + b, 0) / recentEnergy.length;
      const threshold = adjust.energy_drop_threshold ?? 2;
      if (input.energy <= avg - threshold) {
        anomalies.push({code: 'energy_drop', severity: 'medium', detail: `今日精力自评 ${input.energy}，明显低于近 7 天均值（${avg.toFixed(1)}），请确认任务量是否合适`});
      }
    }
    for (const [t, rec] of Object.entries(recentSkips)) {
      if (rec.count >= 2) anomalies.push({code: 'repeated_skip', severity: 'medium', domain: rec.domain || null, detail: `「${t}」近 7 天已跳过 ${rec.count} 次，继续安排前请确认是否保留或调整`});
    }
    for (const o of recentOverruns.slice(0, 5)) {
      anomalies.push({code: 'time_overrun', severity: 'low', detail: `「${o.title}」计划 ${o.planned} 分钟实际 ${o.actual} 分钟（${o.day}），请评估后续安排是否合理`});
    }
  }

  return {
    issues,
    anomalies,
    carryover: carryoverList,
    guards: {
      completedTitles: [...guardTitles],            // advisory only: title match never blocks a plan item
      recentDoneTitles: [...recentDoneTitles],      // soft signal for continuation reason
    },
  };
}
