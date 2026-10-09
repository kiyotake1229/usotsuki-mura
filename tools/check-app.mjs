#!/usr/bin/env node
// 嘘つき村の事件簿 — 画面の決まりの検査（日付と連続日数ほか）
// 使い方: node tools/check-app.mjs [index.html]
// index.html の「// ==DAYRULES START==」〜「// ==DAYRULES END==」（日付と連続日数の決まり）を取り出し、
// エンジン（ENGINE START〜END）と一緒に評価して、日付をまたぐ・開き直す・読み込み直す・戻る・先へ進めて戻す・No.1 より前、の場面を確かめる。
// あわせて、画面の不具合の直しが消えていないか（文字の選択を消す・記録の消去の目印・読み込み直しの戻る）を、ソースで確かめる。
// 外部パッケージは使わない（Node.js だけで動く）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(process.argv[2] || path.join(here, '..', 'index.html'));
const SRC = fs.readFileSync(target, 'utf8');
const between = (a, b) => {
  const lines = SRC.split('\n');
  const s = lines.findIndex((l) => l.includes(a)), e = lines.findIndex((l) => l.includes(b));
  if (s < 0 || e < 0 || e <= s) throw new Error(a + ' 〜 ' + b + ' の目印が見つかりません: ' + target);
  return lines.slice(s + 1, e).join('\n');
};
const ctx = { module: { exports: {} } };
vm.createContext(ctx);
try {
  vm.runInContext(between('// ==ENGINE START==', '// ==ENGINE END==') + '\n;this.Engine = (typeof Engine !== "undefined") ? Engine : module.exports;', ctx);
  vm.runInContext(between('// ==DAYRULES START==', '// ==DAYRULES END==') +
    '\n;this.R = { FIRST_DAY, TZ_SLACK, clampDay, clockBehind, openedOnDayOf, countsOnDay, pendingDay, addStreak, shownStreak };', ctx);
} catch (e) {
  console.log('検査対象: ' + target + '\n\nFAIL  読み込めません: ' + e.message);
  process.exit(1);
}
const { Engine } = ctx;
const R = ctx.R;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
}
const st = (o) => Object.assign({ streak: 0, bestStreak: 0, lastDailyDate: null, totalSolved: 0, perfect: 0 }, o);
// 解いたときの流れ（画面の onSolved と同じ順）: その日の分として数えるか → 数えるなら連続を更新
function solve(s, caseDate, openedOnDay, todayStr, hour) {
  const on = R.countsOnDay(caseDate, openedOnDay, todayStr, hour);
  if (on) R.addStreak(s, caseDate);
  return on;
}
// 開いたときの流れ（画面の startCase・saveProgress と同じ）: その日のうちに開いたかを決め、日替わりの記録に残す
function open(daily, caseDate, todayStr) {
  const old = daily[caseDate];
  const opened = R.openedOnDayOf(caseDate, todayStr, old);
  const rec = { state: old && old.state === 'solved' ? 'solved' : 'playing' };
  if (opened || (old && old.openedOnDay === true)) rec.openedOnDay = true;
  daily[caseDate] = rec;
  return opened;
}
// 読み込み直し: 保存（JSON）を通す
const reload = (daily) => JSON.parse(JSON.stringify(daily));

/* ---------- 0時をまたいで解く（#0010） ---------- */
{
  // 前日まで連続4日。10-10 の 23:59 に開き、0時を過ぎて 10-11 00:00 に解く
  const s = st({ streak: 4, bestStreak: 4, lastDailyDate: '2026-10-09' });
  const on = solve(s, '2026-10-10', true, '2026-10-11', 0);
  check('0時をまたいでも、開いた日の事件を3時までに解けば連続に数える', on && s.streak === 5 && s.lastDailyDate === '2026-10-10' && s.bestStreak === 5, JSON.stringify(s));
  check('翌日のホームでも連続が続いている', R.shownStreak(s, '2026-10-11') === 5, R.shownStreak(s, '2026-10-11'));
  // 翌日の事件も続けて解ける
  solve(s, '2026-10-11', true, '2026-10-11', 21);
  check('翌日の事件を解くと連続が1つのびる', s.streak === 6 && s.lastDailyDate === '2026-10-11', JSON.stringify(s));
}
{
  const s = st({ streak: 4, bestStreak: 4, lastDailyDate: '2026-10-09' });
  const on = solve(s, '2026-10-10', true, '2026-10-11', 3);
  check('3時を過ぎてから解いたときは数えない', !on && s.streak === 4 && s.lastDailyDate === '2026-10-09', JSON.stringify(s));
  const s2 = st({ streak: 4, bestStreak: 4, lastDailyDate: '2026-10-09' });
  const d2 = {};
  const o2 = open(d2, '2026-10-10', '2026-10-11');   // 前の日に一度も開いていない事件を、0時を過ぎてから事件簿で開く
  check('前の日に開いていない事件を、日付が変わってから事件簿で開いて解いても数えない', !o2 && !solve(s2, '2026-10-10', o2, '2026-10-11', 0) && s2.streak === 4, JSON.stringify(s2));
  const s3 = st({ streak: 4, bestStreak: 4, lastDailyDate: '2026-10-09' });
  check('2日前の事件は3時前でも数えない', !solve(s3, '2026-10-09', true, '2026-10-11', 1), JSON.stringify(s3));
  const s4 = st({ streak: 2, bestStreak: 7, lastDailyDate: '2026-10-07' });
  solve(s4, '2026-10-09', true, '2026-10-09', 12);
  check('1日あくと連続は1から（最高は残る）', s4.streak === 1 && s4.bestStreak === 7 && s4.lastDailyDate === '2026-10-09', JSON.stringify(s4));
  check('最後に解いた日が一昨日なら表示は0', R.shownStreak(st({ streak: 3, lastDailyDate: '2026-10-07' }), '2026-10-09') === 0, '');
}

/* ---------- 夜に開いて、ホームに戻る・読み込み直してから0時過ぎに解く（#0010） ---------- */
{
  // 10-09 を解いて連続1。10-10 23:59 にホームから No.10 を開き、判子を1つ押してホームへ戻る
  const s = st({ streak: 1, bestStreak: 1, lastDailyDate: '2026-10-09', totalSolved: 1 });
  const daily = { '2026-10-09': { state: 'solved', solvedOnDay: true } };
  check('今日の事件を開くと「その日のうちに開いた」が記録に残る', open(daily, '2026-10-10', '2026-10-10') === true && daily['2026-10-10'].openedOnDay === true, JSON.stringify(daily['2026-10-10']));
  // 0時を過ぎたホーム（10-11 00:00）
  check('0〜3時のホームに、前の日に開いた事件がまだ間に合うと出す', R.pendingDay(daily, '2026-10-11', 0) === '2026-10-10', R.pendingDay(daily, '2026-10-11', 0));
  check('0〜3時のホームでは、前の日の事件が間に合ううちは連続を切らない', R.shownStreak(s, '2026-10-11', !!R.pendingDay(daily, '2026-10-11', 0)) === 1, R.shownStreak(s, '2026-10-11', true));
  // ホームのお知らせ（または事件簿）から No.10 を開き直して、00:00:40 に解く
  const o = open(daily, '2026-10-10', '2026-10-11');
  const on = solve(s, '2026-10-10', o, '2026-10-11', 0);
  check('ホームに戻ってから開き直しても、3時までに解けば連続に数える', o && on && s.streak === 2 && s.lastDailyDate === '2026-10-10', JSON.stringify(s));
  // 読み込み直し（保存を通す）でも同じ
  const s2 = st({ streak: 1, bestStreak: 1, lastDailyDate: '2026-10-09' });
  const d2 = {}; open(d2, '2026-10-10', '2026-10-10');
  const d3 = reload(d2);
  const o2 = open(d3, '2026-10-10', '2026-10-11');
  check('読み込み直したあとに開き直しても、3時までに解けば連続に数える', o2 && solve(s2, '2026-10-10', o2, '2026-10-11', 2) && s2.streak === 2, JSON.stringify(s2));
  check('次の日に開き直しても「その日のうちに開いた」は記録から消えない', d3['2026-10-10'].openedOnDay === true, JSON.stringify(d3['2026-10-10']));
  // 3時を過ぎたら、お知らせも連続の表示も消える
  const d4 = { '2026-10-10': { state: 'playing', openedOnDay: true } };
  check('3時を過ぎたら、前の日の事件のお知らせは出さない', R.pendingDay(d4, '2026-10-11', 3) === null, '');
  check('3時を過ぎたら、前の日の事件を解いていなければ連続は0', R.shownStreak(st({ streak: 1, lastDailyDate: '2026-10-09' }), '2026-10-11', !!R.pendingDay(d4, '2026-10-11', 3)) === 0, '');
  check('解いた事件・前の日に開いていない事件は、お知らせに出さない', R.pendingDay({ '2026-10-10': { state: 'solved', openedOnDay: true } }, '2026-10-11', 1) === null && R.pendingDay({ '2026-10-10': { state: 'playing' } }, '2026-10-11', 1) === null, '');
  // 端末を起こしたときの知らせ（画面は countsOnDay(P.date, true, 今日, 時) で出し分ける）: 3時を過ぎて起こしたら「数えません」の方
  check('3時を過ぎてから端末を起こしたときは「3時までに解けば」の知らせにしない', !R.countsOnDay('2026-10-10', true, '2026-10-11', 7) && R.countsOnDay('2026-10-10', true, '2026-10-11', 1), '');
}

/* ---------- 端末の日付が戻る（#0010） ---------- */
{
  // A) 連続13日（最後に解いた日 01-03）のまま、端末の日付が 01-02 になる
  const A = st({ streak: 13, bestStreak: 13, lastDailyDate: '2027-01-03' });
  check('日付が戻っても連続をそのまま見せる', R.shownStreak(A, '2027-01-02') === 13, R.shownStreak(A, '2027-01-02'));
  // B) 01-03 だけ解いて西へ移動 → 01-02 の事件を解く → 01-04 にも解く
  const B = st({ streak: 1, bestStreak: 1, lastDailyDate: '2027-01-03' });
  solve(B, '2027-01-02', true, '2027-01-02', 12);
  check('日付が戻った日に解いても、連続と最後に解いた日を巻き戻さない', B.streak === 1 && B.lastDailyDate === '2027-01-03', JSON.stringify(B));
  solve(B, '2027-01-04', true, '2027-01-04', 12);
  check('戻ったあとも連続は切れない', B.streak === 2 && B.lastDailyDate === '2027-01-04', JSON.stringify(B));
  // A2) 時差で戻る日付は最大2日（UTC+14 → UTC-12）。2日戻っても連続をそのまま見せ、解いても巻き戻さない
  const A2 = st({ streak: 13, bestStreak: 13, lastDailyDate: '2027-01-03' });
  check('日付が2日戻っても連続をそのまま見せる（時差の幅）', R.TZ_SLACK === 2 && R.shownStreak(A2, '2027-01-01') === 13, R.shownStreak(A2, '2027-01-01'));
  solve(A2, '2027-01-01', true, '2027-01-01', 12);
  check('日付が2日戻った日に解いても巻き戻さない', A2.streak === 13 && A2.lastDailyDate === '2027-01-03', JSON.stringify(A2));
  // C) 手で 2026-12-01 に戻す。時差の幅を超えるので時計のずれとみなす。
  //    解かずに戻せば連続は残る。戻したまま解くと、ふつうに数え直す（最高は残る）。
  //    どちらの時計が正しいかは分からないので、先へ進めて戻す場面 D で連続が止まったままにならないことを優先した
  const C = st({ streak: 13, bestStreak: 13, lastDailyDate: '2027-01-03' });
  check('時計を大きく戻したホームでは連続0', R.shownStreak(C, '2026-12-01') === 0, R.shownStreak(C, '2026-12-01'));
  check('時計を大きく戻しても、解かずに元へ戻せば連続が残る', R.shownStreak(C, '2027-01-04') === 13, R.shownStreak(C, '2027-01-04'));
  solve(C, '2026-12-01', true, '2026-12-01', 12);
  check('時計を大きく戻して解くと、連続は1から（最高は残る）', C.streak === 1 && C.bestStreak === 13 && C.lastDailyDate === '2026-12-01', JSON.stringify(C));
}

/* ---------- 端末の日付を先へ進めて解き、元に戻す ---------- */
{
  // D) 連続5（最後に解いた日 10-09）のまま、時計を 2027-01-01 にして、その日の事件を解く
  const D = st({ streak: 5, bestStreak: 5, lastDailyDate: '2026-10-09' });
  solve(D, '2027-01-01', true, '2027-01-01', 12);
  check('先の日付で解くと、日があいたので連続は1から', D.streak === 1 && D.lastDailyDate === '2027-01-01' && D.bestStreak === 5, JSON.stringify(D));
  // 時計を正しく戻す（10-10）。先の日付の記録は時計のずれとみなす
  check('元に戻したホームでは、先の日付の連続を見せない', R.shownStreak(D, '2026-10-10') === 0, R.shownStreak(D, '2026-10-10'));
  let ok = true;
  for (let i = 0; i < 11; i++) {
    const d = Engine.addDays('2026-10-10', i);
    solve(D, d, true, d, 12);
    if (D.streak !== i + 1 || D.lastDailyDate !== d || R.shownStreak(D, d) !== i + 1) { ok = false; break; }
  }
  check('元に戻したあと毎日解けば、連続が1からのびる（止まったままにならない）', ok && D.streak === 11 && D.bestStreak === 11 && D.lastDailyDate === '2026-10-20', JSON.stringify(D));
  // E) 2日先まで（時差の幅）なら、戻っても巻き戻さず、その日を過ぎれば続く
  const E = st({ streak: 5, bestStreak: 5, lastDailyDate: '2026-10-09' });
  solve(E, '2026-10-10', true, '2026-10-10', 12);   // 6
  solve(E, '2026-10-12', true, '2026-10-12', 12);   // 1日あいた: 1
  solve(E, '2026-10-11', true, '2026-10-11', 12);   // 1日戻った: 巻き戻さない
  check('先の日付が2日以内なら、戻った日に解いても巻き戻さない', E.streak === 1 && E.lastDailyDate === '2026-10-12', JSON.stringify(E));
  solve(E, '2026-10-13', true, '2026-10-13', 12);
  check('その先の日に解けば連続がのびる', E.streak === 2 && E.lastDailyDate === '2026-10-13', JSON.stringify(E));
  check('表示は、最後に解いた日が今日より3日以上先なら0（時計のずれ）', R.shownStreak(st({ streak: 4, lastDailyDate: '2026-10-13' }), '2026-10-10') === 0 && R.shownStreak(st({ streak: 4, lastDailyDate: '2026-10-12' }), '2026-10-10') === 4, '');
}

/* ---------- 端末の日付が No.1 より前（#0010） ---------- */
{
  const ds = ['2026-09-25', '2026-09-30', '1970-01-01', '2000-02-29'];
  const bad = ds.filter((d) => { const t = R.clampDay(d); return t !== R.FIRST_DAY || Engine.dailyConfig(t).no !== 1; });
  check('No.1 より前の日付は No.1 の日として扱う', bad.length === 0, bad.join(' '));
  check('No.1 以降の日付はそのまま', R.clampDay('2026-10-01') === '2026-10-01' && R.clampDay('2027-05-21') === '2027-05-21', '');
  check('No.1 より前の日付のときは「日付を確かめて」の案内を出す', ds.every((d) => R.clockBehind(d)) && !R.clockBehind('2026-10-01') && !R.clockBehind('2026-10-09'), '');
  check('FIRST_DAY はエンジンの No.1 の日', Engine.dailyConfig(R.FIRST_DAY).no === 1 && Engine.dailyConfig(Engine.addDays(R.FIRST_DAY, -1)).no === 0, R.FIRST_DAY);
}

/* ---------- 直しが消えていないか（ソースで確かめる） ---------- */
{
  const has = (re) => re.test(SRC);
  const fnBody = (name) => { const i = SRC.indexOf('function ' + name + '('); return i < 0 ? '' : SRC.slice(i, SRC.indexOf('\n  }\n', i)); };
  check('画面: 今日は clampDay を通す', has(/const today = \(\) => clampDay\(/), '');
  check('画面: 連続日数は countsOnDay・addStreak・shownStreak を使う', has(/countsOnDay\(P\.date, P\.openedOnDay/) && has(/addStreak\(st, P\.date\)/) && has(/shownStreak\(S\.stats, today\(\)/), '');
  check('画面: 開いたときに「その日のうちに開いたか」を、記録も見て決める', has(/openedOnDay: openedOnDayOf\(spec\.date, today\(\), rec\)/), '');
  check('画面: 「その日のうちに開いた」を日替わりの記録に残し、読み込み直しても消さない',
    /if \(P\.openedOnDay \|\| \(old && old\.openedOnDay === true\)\) rec\.openedOnDay = true;/.test(fnBody('saveProgress')) &&
    /if \(r\.openedOnDay === true\) x\.openedOnDay = true;/.test(fnBody('sanitize')), '');
  check('画面: 連続の表示は 0〜3時の「まだ間に合う」を見る',
    has(/const pendingNow = \(\) => pendingDay\(S\.daily, today\(\), new Date\(\)\.getHours\(\)\);/) &&
    has(/const streakNow = \(\) => shownStreak\(S\.stats, today\(\), !!pendingNow\(\)\);/), '');
  check('画面: ホームに前の日の事件へ行くお知らせと、端末の日付の案内を出す',
    /pendingNow\(\)/.test(fnBody('renderHome')) && /data-pending=/.test(fnBody('renderHome')) && has(/t\.closest\('\[data-pending\]'\)/) &&
    /clockBehind\(rawToday\(\)\)/.test(fnBody('renderHome')) && /clockBehind\(rawToday\(\)\)/.test(fnBody('renderBook')), '');
  check('画面: 日付が変わった・3時を過ぎたときの知らせは、いまの時刻で数えるかを確かめてから出す',
    has(/if \(d !== lastDay \|\| early !== lastEarly\)/) &&
    has(/if \(countsOnDay\(P\.date, true, d, new Date\(\)\.getHours\(\)\)\) toast\('日付が変わりました。3時までに解けば/), '');
  check('画面: 結果・共有画像・盤面を出すときに文字の選択を消す（#0011）', /clearSel\(\)/.test(fnBody('showResult')) && /clearSel\(\)/.test(fnBody('openShareView')) && /clearSel\(\)/.test(fnBody('startCase')) && /clearSel\(\)/.test(fnBody('show')), '');
  check('画面: ボタン類は文字の選択が始まらない（user-select:none）（#0011）', has(/\.btn\{[^}]*user-select:none/) && has(/\.mk\{[^}]*user-select:none/), '');
  check('画面: 記録を消すと目印（epoch）を新しくし、書き戻さない（#0011）', has(/S\.epoch = Date\.now\(\)\.toString\(36\)/) && /s\.epoch \|\| ''\) !== \(P\.epoch/.test(fnBody('saveProgress')) && has(/const wiped = \(fresh\.epoch/), '');
  check('画面: 読み込み直したら最初の履歴まで戻る（#0011）', has(/if \(u0 > 0\) history\.go\(-u0\); else history\.replaceState\(\{ usd: 0 \}, ''\);/), '');
}

let fail = 0;
console.log('検査対象: ' + target + '\n');
for (const r of results) {
  if (!r.ok) fail++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}` + (r.ok || !r.detail ? '' : '\n        ' + r.detail));
}
console.log(`\n${fail ? 'FAIL' : 'PASS'}  ${results.length}項目`);
process.exit(fail ? 1 : 0);
