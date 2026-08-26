// SINGLE SOURCE OF TRUTH for the n8n "Transform to Canonical Schema" code node
// (workflow: zepp-hc-ingest-transform). The n8n node body is deployed FROM this string
// (see scripts/sync-hc-transform-node.mjs) and this same string is exercised verbatim by
// src/__tests__/zepp-transform-own-day.test.ts via `new Function`, so the tested code is
// byte-identical to what runs in n8n -- no drift between the repo and the deployed node.
//
// F1 (card 75337cdc): files every record under its own local (Budapest) day and emits one
// canonical snapshot per day, replacing the old single-date (localDate(syncedAt)) filing
// that mis-filed a 48h rolling window onto the push day.
//
// The store/n8n-workflows JSON is gitignored (runtime data), so this module -- not that
// file -- is the reviewable, version-controlled source.

export const HC_TRANSFORM_NODE_JS = `const _in = $input.first().json;
const body = (_in && _in.body && typeof _in.body === 'object') ? _in.body : _in;
function num(v){ if(v==null) return undefined; const n=Number(v); return Number.isFinite(n)?n:undefined; }
function localDate(isoStr){ const d=new Date(isoStr); if(isNaN(d.getTime())) return undefined; const mo=d.getUTCMonth()+1; const off=(mo>=3&&mo<=10)?2:1; return new Date(d.getTime()+off*3600*1000).toISOString().slice(0,10); }
function pick(obj, keys){ for(const k of keys){ const v=num(obj[k]); if(v!=null) return v; } return undefined; }
const syncedAt = body.timestamp || new Date().toISOString();

// --- F1 own-day filing (card 75337cdc) ---
// Bucket every record under its own local (Budapest) day, then emit ONE canonical
// snapshot per day. Replaces the old single-date filing (date = localDate(syncedAt))
// that mis-filed a 48h rolling window's data onto the push day (midnight dead-zone bug).
// fallbackDay keeps an undatable record from being silently dropped: it files under the
// push day instead (no-loss; better a possibly-mis-dated record than a vanished one).
const fallbackDay = localDate(syncedAt);
function bucket(arr, dayFn){
  const m = {};
  for (const r of (arr || [])) {
    const d = dayFn(r) || fallbackDay;
    if (!d) continue;
    (m[d] = m[d] || []).push(r);
  }
  return m;
}
// Own-day resolvers per type. Sleep files under the WAKE day (session end); every other
// type files under the record's own start/measurement day. Steps/distance/calories come as
// per-Budapest-day windows (start = D 00:00 CEST = (D-1) 22:00Z), so localDate(start) == D.
function sleepDay(s){
  const stages = s.stages || [];
  const end = s.session_end_time || s.end_time || (stages.length ? stages[stages.length-1].end_time : undefined);
  return localDate(end);
}
const startDay = (r) => localDate(r.start_time);
const timeDay  = (r) => localDate(r.time);

const stepsByDay = bucket(body.steps, startDay);
const distByDay  = bucket(body.distance, startDay);
const calByDay   = bucket(body.active_calories, startDay);
const exByDay    = bucket(body.exercise, startDay);
const sleepByDay = bucket(body.sleep, sleepDay);
const rhrByDay   = bucket(body.resting_heart_rate, timeDay);
const hrvByDay   = bucket(body.heart_rate_variability, timeDay);
const spo2ByDay  = bucket(body.oxygen_saturation, timeDay);
const rrByDay    = bucket(body.respiratory_rate, timeDay);
const hrByDay    = bucket(body.heart_rate, timeDay);

function buildSleep(sleepArr){
  if (!sleepArr || sleepArr.length === 0) return undefined;
  const s = sleepArr[0];
  const stages = s.stages || [];
  const startAt = s.session_start_time || s.start_time || (stages.length ? stages[0].start_time : undefined);
  const endAt   = s.session_end_time   || s.end_time   || (stages.length ? stages[stages.length-1].end_time : undefined);
  const STAGE = { '1':'awake','4':'light','5':'deep','6':'rem','7':'awake','deep':'deep','light':'light','rem':'rem','awake':'awake' };
  const acc = { deep_min:0, light_min:0, rem_min:0, awake_min:0 };
  let asleepMin = 0;
  for (const st of stages) {
    const durMin = (num(st.duration_seconds)!=null) ? num(st.duration_seconds)/60 : (num(st.duration)||0);
    const name = STAGE[String(st.stage)];
    if (name === 'awake') { acc.awake_min += durMin; }
    else { asleepMin += durMin; if (name) acc[name+'_min'] += durMin; }
  }
  if (asleepMin === 0 && num(s.duration_seconds)!=null) asleepMin = num(s.duration_seconds)/60;
  return { total_min: Math.round(asleepMin), start: startAt, end: endAt,
           stages: { deep_min:Math.round(acc.deep_min), light_min:Math.round(acc.light_min), rem_min:Math.round(acc.rem_min), awake_min:Math.round(acc.awake_min) } };
}
function buildVitals(rhrArr, hrvArr, spo2Arr, rrArr, hrArr){
  const vitals = {};
  if (rhrArr && rhrArr.length > 0) { const v = pick(rhrArr[rhrArr.length-1], ['bpm','avg']); if (v!=null) vitals.resting_hr_bpm = v; }
  if (hrvArr && hrvArr.length > 0) { const v = pick(hrvArr[hrvArr.length-1], ['rmssd_millis','rmssd','avg']); if (v!=null) vitals.hrv_rmssd_ms = v; }
  if (spo2Arr && spo2Arr.length > 0) { const vals = spo2Arr.map(x=>pick(x,['avg','percentage'])).filter(v=>v!=null); if (vals.length){ vals.sort((a,b)=>a-b); vitals.spo2_pct = vals[Math.floor(vals.length/2)]; } }
  if (rrArr && rrArr.length > 0) { const v = pick(rrArr[rrArr.length-1], ['rate','avg']); if (v!=null) vitals.respiratory_rate_bpm = v; }
  if (hrArr && hrArr.length > 0) {
    const avgs = hrArr.map(x=>pick(x,['avg','bpm'])).filter(v=>v!=null);
    const mins = hrArr.map(x=>pick(x,['min','bpm'])).filter(v=>v!=null);
    const maxs = hrArr.map(x=>pick(x,['max','bpm'])).filter(v=>v!=null);
    if (avgs.length) vitals.hr_avg_bpm = Math.round(avgs.reduce((a,b)=>a+b,0)/avgs.length);
    if (mins.length) vitals.hr_min_bpm = Math.min.apply(null, mins);
    if (maxs.length) vitals.hr_max_bpm = Math.max.apply(null, maxs);
  }
  return vitals;
}
function buildWorkouts(exArr){
  if (!exArr || exArr.length === 0) return undefined;
  return exArr.map(function(ex){
    const durMin = (num(ex.duration_seconds)!=null) ? Math.round(num(ex.duration_seconds)/60)
                  : ((ex.start_time&&ex.end_time) ? Math.round((new Date(ex.end_time)-new Date(ex.start_time))/60000) : undefined);
    const w = { type: ex.type, start: ex.start_time };
    if (durMin!=null) w.duration_min = durMin;
    const dist = pick(ex, ['distance_meters','distance']);
    if (dist!=null) w.distance_m = dist;
    return w;
  });
}
function buildActivity(stepsArr, calsArr, distArr, exArr){
  const activity = {};
  if (stepsArr && stepsArr.length > 0) activity.steps = stepsArr.reduce((s,x)=>s+(num(x.count)||0),0);
  if (calsArr && calsArr.length > 0) activity.active_kcal = calsArr.reduce((s,x)=>s+(num(x.calories)||0),0);
  const dArr = distArr || [];
  let distTotal = dArr.reduce((s,x)=>s+(pick(x,['meters','distance_m'])||0),0);
  if (distTotal===0) distTotal = (exArr||[]).reduce((s,e)=>s+(pick(e,['distance_meters','distance'])||0),0);
  if (distTotal>0) activity.distance_m = Math.round(distTotal);
  return activity;
}

const days = Object.keys(Object.assign({}, stepsByDay, distByDay, calByDay, exByDay, sleepByDay, rhrByDay, hrvByDay, spo2ByDay, rrByDay, hrByDay)).sort();
const out = [];
for (const day of days) {
  const snap = { date: day, synced_at: syncedAt };
  const vitals = buildVitals(rhrByDay[day], hrvByDay[day], spo2ByDay[day], rrByDay[day], hrByDay[day]);
  if (Object.values(vitals).some(v=>v!=null)) snap.vitals = vitals;
  const sleep = buildSleep(sleepByDay[day]);
  if (sleep) snap.sleep = sleep;
  const workouts = buildWorkouts(exByDay[day]);
  if (workouts && workouts.length>0) snap.workouts = workouts;
  const activity = buildActivity(stepsByDay[day], calByDay[day], distByDay[day], exByDay[day]);
  if (Object.keys(activity).length>0) snap.activity = activity;
  if (snap.vitals || snap.sleep || snap.workouts || snap.activity) out.push({ json: snap });
}
return out;
`
