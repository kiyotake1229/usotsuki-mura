#!/usr/bin/env node
// 嘘つき村の事件簿 — 画面の決まりの検査（日付と連続日数・週・事件簿の並び・はじめての事件ほか）
// 使い方: node tools/check-app.mjs [index.html]
// index.html の「// ==DAYRULES START==」〜「// ==DAYRULES END==」（日付と連続日数・週・事件簿の並びの決まり）と
// 「// ==TUTORIAL START==」〜「// ==TUTORIAL END==」（はじめての事件の3話）を取り出し、
// エンジン（ENGINE START〜END）と一緒に評価して、日付をまたぐ・開き直す・読み込み直す・戻る・先へ進めて戻す・No.1 より前、の場面を確かめる。
// 今週の難問の週の決まり（月曜はじまり・第N週・年またぎ）、事件簿の全日の並び（新しい順・月の見出し・No.1 で止まる・もっと見る）、
// はじめての事件の問題が固定で変わらないこと（ハッシュ）と案内の文の対応、今週の難問の問題が変わらないこと（156週の回帰ハッシュ）も確かめる。
// 「// ==STORE START==」〜「// ==STORE END==」（保存の読み書き）も取り出し、壊れた保存・古い版のタブの保存・記録を消した別のタブ、の場面で実際に動かす。
// はじめての事件の案内（tutGuide）とホームの「はじめての方へ」（showTutCard）も、関数を取り出して動かす。
// あわせて、画面の不具合の直しが消えていないか（文字の選択を消す・記録の消去の目印・読み込み直しの戻る）を、ソースで確かめる。
// 外部パッケージは使わない（Node.js だけで動く）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
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
const ENGINE_SRC = between('// ==ENGINE START==', '// ==ENGINE END==') + '\n;this.Engine = (typeof Engine !== "undefined") ? Engine : module.exports;';
// 事件簿を初めて開くときの重さは、ほかの検査でエンジンが温まる前に、新しいコンテキスト（エンジンを読み直した直後）で測る
let coldMs = null, coldRows = 0;
try {
  const c0 = { module: { exports: {} } };
  vm.createContext(c0);
  vm.runInContext(ENGINE_SRC, c0);
  vm.runInContext(between('// ==DAYRULES START==', '// ==DAYRULES END==') + '\n;this.R = { bookDays };', c0);
  const t0 = process.hrtime.bigint();
  const list = c0.R.bookDays('2029-10-04').slice(0, 90);
  list.forEach((d) => c0.Engine.dailyConfig(d));
  coldMs = Number(process.hrtime.bigint() - t0) / 1e6; coldRows = list.length;
} catch (e) { coldMs = null; }
const ctx = { module: { exports: {} } };
vm.createContext(ctx);
// 保存の検査用: localStorage の代わり（Map）。プラグイン（iOS の Preferences）は無い環境として動かす
const LS = new Map();
ctx.localStorage = { getItem: (k) => (LS.has(k) ? LS.get(k) : null), setItem: (k, v) => { LS.set(k, String(v)); }, removeItem: (k) => { LS.delete(k); } };
ctx.plug = () => null;
ctx.quiet = (p) => p;
const lineOf = (head) => { const l = SRC.split('\n').find((x) => x.trim().startsWith(head)); if (!l) throw new Error(head + ' が見つかりません'); return l; };
const fnSrc = (name) => { const i = SRC.indexOf('function ' + name + '('); if (i < 0) throw new Error(name + ' が見つかりません'); return SRC.slice(i, SRC.indexOf('\n  }\n', i)) + '\n}'; };
try {
  vm.runInContext(between('// ==ENGINE START==', '// ==ENGINE END==') + '\n;this.Engine = (typeof Engine !== "undefined") ? Engine : module.exports;', ctx);
  vm.runInContext(between('// ==DAYRULES START==', '// ==DAYRULES END==') +
    '\n;this.R = { FIRST_DAY, TZ_SLACK, clampDay, clockBehind, openedOnDayOf, countsOnDay, pendingDay, addStreak, shownStreak,' +
    ' FIRST_WEEK, utcOf, mondayOf, weekNoOf, weekMonday, weekSeed, weekRange, isThisWeek, weekName, bookDays, bookWeeks, bookRows, monthOf, yearOf };', ctx);
  vm.runInContext(between('// ==TUTORIAL START==', '// ==TUTORIAL END==') + '\n;this.TU = { TUTORIAL, TUTORIAL_HASH, tutorialPuzzle };', ctx);
  // 保存の読み書き（起動時の let S = readStore() || defaults() も、この中で空の保存から動く）
  vm.runInContext(between('// ==STORE START==', '// ==STORE END==') +
    '\n;this.ST = { KEY, defaults, sanitize, readStore, persist, update, carryNew, getS: () => S, setS: (v) => { S = v; } };', ctx);
  // ホームの「はじめての方へ」を出すかの判定（S を見る）
  vm.runInContext([lineOf('function tutNext()'), lineOf('const tutStarted = '), lineOf('const weeksSolved = '), fnSrc('showTutCard')].join('\n') +
    '\n;this.HC = { showTutCard, tutNext };', ctx);
  // はじめての事件の案内（P を見る。ヒントは Engine.hint）
  vm.runInContext('let P = null;\n' + [lineOf('const answerKey = '), lineOf('const sameAsWrong = '), fnSrc('hintFor'), fnSrc('tutGuide')].join('\n') +
    '\n;this.TG = { tutGuide, answerKey, setP: (p) => { P = p; } };', ctx);
} catch (e) {
  console.log('検査対象: ' + target + '\n\nFAIL  読み込めません: ' + e.message);
  process.exit(1);
}
const { Engine } = ctx;
const R = ctx.R;
const TU = ctx.TU;
const ST = ctx.ST, HC = ctx.HC, TG = ctx.TG;
const sha = (str) => crypto.createHash('sha256').update(str).digest('hex');

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


/* ---------- 今週の難問: 週の決まり（月曜はじまり。No.1 を含む週が第1週） ---------- */
{
  const days = (n, from) => Array.from({ length: n }, (_, i) => Engine.addDays(from || R.FIRST_DAY, i));
  check('週: 2026-10-14（水）は第3週・月曜 10-12', R.mondayOf('2026-10-14') === '2026-10-12' && R.weekNoOf('2026-10-14') === 3, R.mondayOf('2026-10-14') + ' ' + R.weekNoOf('2026-10-14'));
  check('週: 月曜はその日が月曜', R.mondayOf('2026-10-12') === '2026-10-12', R.mondayOf('2026-10-12'));
  check('週: 日曜は前の月曜の週（10-18 → 10-12・第3週）', R.mondayOf('2026-10-18') === '2026-10-12' && R.weekNoOf('2026-10-18') === 3, R.mondayOf('2026-10-18'));
  check('週: 次の月曜 10-19 で第4週', R.weekNoOf('2026-10-19') === 4, R.weekNoOf('2026-10-19'));
  check('週: No.1（10-01・木）は第1週・月曜 09-28', R.mondayOf('2026-10-01') === '2026-09-28' && R.weekNoOf('2026-10-01') === 1 && R.FIRST_WEEK === '2026-09-28', R.weekNoOf('2026-10-01'));
  check('週: 10-04（日）まで第1週、10-05 から第2週', R.weekNoOf('2026-10-04') === 1 && R.weekNoOf('2026-10-05') === 2, R.weekNoOf('2026-10-04') + '/' + R.weekNoOf('2026-10-05'));
  check('週: No.1 より前の時計（09-28・09-25・1970-01-01）は第1週に丸める', ['2026-09-28', '2026-09-25', '1970-01-01'].every((d) => R.weekNoOf(d) === 1), ['2026-09-28', '2026-09-25', '1970-01-01'].map(R.weekNoOf).join(','));
  check('週: 年またぎ 2027-01-01（金）→ 月曜 2026-12-28、範囲「12/28〜1/3」', R.mondayOf('2027-01-01') === '2026-12-28' && R.weekRange('2026-12-28') === '12/28〜1/3', R.weekRange('2026-12-28'));
  check('週: 2026-12-28〜2027-01-03 は第14週、2027-01-04 は第15週', R.weekNoOf('2026-12-28') === 14 && R.weekNoOf('2027-01-03') === 14 && R.weekNoOf('2027-01-04') === 15, R.weekNoOf('2026-12-28') + '/' + R.weekNoOf('2027-01-04'));
  check('週: うるう年（2028-02-29（火）・03-01（水）→ 月曜 2028-02-28）', R.mondayOf('2028-02-29') === '2028-02-28' && R.mondayOf('2028-03-01') === '2028-02-28', R.mondayOf('2028-03-01'));
  check('週: 1,200日で weekMonday(weekNoOf(d)) が mondayOf(d) と同じ', days(1200).every((d) => R.weekMonday(R.weekNoOf(d)) === R.mondayOf(d)), '');
  let up = true, prev = R.weekNoOf(R.FIRST_DAY);
  for (const d of days(1200).slice(1)) { const w = R.weekNoOf(d), wd = new Date(R.utcOf(d)).getUTCDay(); if (w !== prev + (wd === 1 ? 1 : 0)) { up = false; break; } prev = w; }
  check('週: 1日ずつ進めると、週の番号は月曜にだけ1つ増える（1,200日）', up, '');
  check('週: 曜日はアプリの parseD（端末のローカル日付）・Engine.dailyConfig と同じ',
    days(1200).every((d) => { const p = d.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]).getDay() === new Date(R.utcOf(d)).getUTCDay(); }) &&
    days(120).every((d) => Engine.dailyConfig(d).weekday === new Date(R.utcOf(d)).getUTCDay()), '');
  check('週: 今週の seed は usotsuki-week-20261012、第156週の月曜は 2029-09-17', R.weekSeed(R.mondayOf('2026-10-14')) === 'usotsuki-week-20261012' && R.weekMonday(156) === '2029-09-17', R.weekMonday(156));
  check('週: 範囲の表示「10/12〜10/18」', R.weekRange('2026-10-12') === '10/12〜10/18', R.weekRange('2026-10-12'));
  check('週: 名前は今週だけ「今週の難問」、終わった週は「週の難問」（日曜まで今週・次の月曜から前の週）',
    R.weekName('2026-10-12', '2026-10-14') === '今週の難問' && R.weekName('2026-10-12', '2026-10-18') === '今週の難問' && R.weekName('2026-10-12', '2026-10-19') === '週の難問' &&
    R.weekName('2026-09-28', '2026-10-14') === '週の難問' && R.weekName('2026-09-28', '2026-09-25') === '今週の難問' && R.isThisWeek('2026-12-28', '2027-01-03') && !R.isThisWeek('2026-12-28', '2027-01-04'),
    [R.weekName('2026-10-12', '2026-10-14'), R.weekName('2026-09-28', '2026-10-14')].join('/'));
}

/* ---------- 今週の難問: 問題が変わっていないか（回帰。エンジンが変わると、週の記録に残った途中の判子が別の問題に付く） ---------- */
{
  const t0 = Date.now();
  let acc = '', bad = [];
  for (let n = 1; n <= 156; n++) {
    const m = R.weekMonday(n);
    const pz = Engine.generate({ seed: R.weekSeed(m), people: 9, star: 3 });
    if (pz.people !== 9 || pz.star !== 3 || (pz.stats && pz.stats.unused && pz.stats.unused.length)) bad.push(n);
    acc += JSON.stringify(pz) + '\n';
  }
  const h = sha(acc).slice(0, 32);
  check('今週の難問: 156週すべて9人・★3・使わない証言なし', bad.length === 0, bad.join(','));
  check('今週の難問: 156週の問題が基準と同じ（回帰ハッシュ）', h === '4bad2d4cb7bcd9060c37cb77b53c5968', h + '（' + (Date.now() - t0) + 'ms）');
  const a = JSON.stringify(Engine.generate({ seed: R.weekSeed('2026-10-12'), people: 9, star: 3 }));
  check('今週の難問: 同じ週は何度作っても同じ問題（第3週「ひっくり返った花の鉢」）', a === JSON.stringify(Engine.generate({ seed: 'usotsuki-week-20261012', people: 9, star: 3 })) && JSON.parse(a).story.title === 'ひっくり返った花の鉢', JSON.parse(a).story.title);
}

/* ---------- 事件簿: 全日の並び ---------- */
{
  const d1 = R.bookDays('2026-10-14');
  check('事件簿: 2026-10-14 は14日（今日から No.1 まで・新しい順）', d1.length === 14 && d1[0] === '2026-10-14' && d1[13] === R.FIRST_DAY, d1.length + ' ' + d1[0] + '…' + d1[d1.length - 1]);
  const far = '2029-10-04', d2 = R.bookDays(far);
  let seq = d2[0] === far && d2[d2.length - 1] === R.FIRST_DAY;
  for (let i = 1; i < d2.length && seq; i++) if (Engine.addDays(d2[i], 1) !== d2[i - 1]) seq = false;
  check('事件簿: 3年後（2029-10-04）は1,100日。1日ずつ新しい順で、No.1 で止まる', seq && d2.length === 1100 && Engine.dailyConfig(far).no === 1100, d2.length);
  check('事件簿: 行の No. は 1,100 から 1 まで（日付と No. が合う）', d2.every((d, i) => Engine.dailyConfig(d).no === d2.length - i), '');
  check('事件簿: 端末の日付が No.1 より前なら No.1 の1日だけ', JSON.stringify(R.bookDays('2026-09-25')) === JSON.stringify([R.FIRST_DAY]) && R.bookDays(R.FIRST_DAY).length === 1, R.bookDays('2026-09-25').join(','));
  const full = R.bookRows(d2, 0, d2.length, R.monthOf);
  const heads = full.filter((r) => r.head).map((r) => r.head);
  check('事件簿: 月の見出しは月が変わる所だけ（2026年10月〜2029年10月の37個・新しい順）', heads.length === 37 && heads[0] === '2029-10' && heads[36] === '2026-10' && new Set(heads).size === 37, heads.length + ' ' + heads[0] + '…' + heads[heads.length - 1]);
  let headOk = true, curM = null;
  for (const r of full) { if (r.head) curM = r.head; else if (R.monthOf(r.item) !== curM) { headOk = false; break; } }
  check('事件簿: どの行も、その月の見出しの下に並ぶ', headOk, '');
  // 30行 → 60行ずつ足す（もっと見る）。つないだものが、全部を一度に作ったものと同じ（見出しが重ならない）
  let parts = R.bookRows(d2, 0, 30, R.monthOf);
  for (let from = 30; from < d2.length; from += 60) parts = parts.concat(R.bookRows(d2, from, from + 60, R.monthOf));
  check('事件簿: 30行ずつ・60行ずつ足しても、見出しが重ならず全部そろう', JSON.stringify(parts) === JSON.stringify(full) && parts.filter((r) => !r.head).length === 1100, parts.length + '/' + full.length);
  check('事件簿: 見出しの途中から足すときは見出しを重ねない（10月の途中の続き）', JSON.stringify(R.bookRows(d1, 5, 9, R.monthOf)) === JSON.stringify([5, 6, 7, 8].map((i) => ({ item: d1[i], i }))), '');
  const w1 = R.bookWeeks('2026-10-14');
  check('事件簿: 今週の難問は今週から第1週まで（2026-10-14 は3週）', JSON.stringify(w1) === JSON.stringify(['2026-10-12', '2026-10-05', '2026-09-28']), w1.join(','));
  const w2 = R.bookWeeks('2029-09-23');
  check('事件簿: 3年後の今週の難問は156週。どれも月曜で、7日ずつ新しい順', w2.length === 156 && w2.every((m, i) => R.mondayOf(m) === m && (i === 0 || Engine.addDays(m, 7) === w2[i - 1])) && w2[155] === R.FIRST_WEEK, w2.length);
  const wh = R.bookRows(w2, 0, w2.length, R.yearOf).filter((r) => r.head).map((r) => r.head);
  check('事件簿: 今週の難問の見出しは年ごと（2029〜2026）', JSON.stringify(wh) === JSON.stringify(['2029', '2028', '2027', '2026']), wh.join(','));
  check('事件簿: 3年後でも、事件簿を初めて開くとき（エンジンを読み直した直後）に並びを作って最初の90行の事件を引くのは軽い（100ms 未満）',
    coldMs != null && coldRows === 90 && coldMs < 100, coldMs == null ? '測れませんでした' : coldMs.toFixed(1) + 'ms（' + coldRows + '行）');
}

/* ---------- はじめての事件: 3話が固定で、案内の文と合っているか ---------- */
{
  const T = TU.TUTORIAL;
  const pzs = T.map((t) => TU.tutorialPuzzle(t.ep));
  check('はじめての事件: 3話ある（第1話〜第3話）', T.length === 3 && T.every((t, i) => t.ep === i + 1), T.length);
  const hs = pzs.map((pz) => sha(JSON.stringify(pz)).slice(0, 16));
  check('はじめての事件: 3話の問題が固定のまま（各話のハッシュ）', T.every((t, i) => hs[i] === t.hash), hs.join(' '));
  const all = sha(pzs.map((pz) => JSON.stringify(pz) + '\n').join('')).slice(0, 32);
  check('はじめての事件: 3話まとめたハッシュが基準と同じ', all === TU.TUTORIAL_HASH && all === '44d921d916798acb5c5089c47d182a1b', all);
  check('はじめての事件: 何度作っても同じ問題', T.every((t, i) => JSON.stringify(TU.tutorialPuzzle(t.ep)) === JSON.stringify(pzs[i])), '');
  const [a, b, c] = pzs;
  check('はじめての事件: 第1話は3人・★1・メモから4手（仮定なし）', a.people === 3 && a.star === 1 && !!a.given && a.steps.length === 4 && a.steps.every((s) => s.kind !== 'hypo'), a.people + '人 ★' + a.star + ' ' + a.steps.length + '手');
  check('はじめての事件: 第2話は4人・★1・メモから5手（仮定なし）・「同じ側」を使う', b.people === 4 && b.star === 1 && !!b.given && b.steps.length === 5 && b.steps.every((s) => s.kind !== 'hypo') && b.statements.some((s) => s.type === 'SAME'), b.people + '人 ★' + b.star + ' ' + b.steps.length + '手');
  check('はじめての事件: 第3話は遊び方の例題（4人・メモなし・最初の一手が仮定1回）', JSON.stringify(c) === JSON.stringify(Engine.example()) && c.people === 4 && !c.given && c.steps[0].kind === 'hypo' && c.stats.hyps === 1, c.steps.map((s) => s.kind).join(','));
  const names = pzs.map((pz) => pz.villagers.map((v) => v.name));
  check('はじめての事件: 3話の顔ぶれ（11人）がすべて別人', new Set([].concat(...names)).size === 11, names.map((n) => n.join('・')).join(' ／ '));
  check('はじめての事件: 案内の文が手順の数だけある', T.every((t, i) => Array.isArray(t.steps) && t.steps.length === pzs[i].steps.length), T.map((t, i) => t.steps.length + '/' + pzs[i].steps.length).join(' '));
  // 案内の文に出てくる名前は、その話の村人だけ（問題が変わって名前がずれたら気づく）
  const pool = Engine._internal.POOL.map((p) => p.name);
  const textsOf = (t) => [t.lead, t.solved].concat(t.steps, t.hypo ? t.hypo.seq.map((x) => x.text).concat([t.hypo.ready, t.hypo.wrong]) : []);
  const strayNames = [];
  T.forEach((t, i) => textsOf(t).forEach((tx) => pool.forEach((nm) => { if (tx.indexOf(nm) >= 0 && names[i].indexOf(nm) < 0) strayNames.push(t.ep + ':' + nm); })));
  check('はじめての事件: 案内の文に出てくる名前は、その話の村人だけ', strayNames.length === 0, strayNames.join(' '));
  // 正しい判子を手順の順に押していくと、エンジンのヒントが次の手順を指す（案内の steps[j] が、その場面に出る）
  let flow = true; const why = [];
  pzs.forEach((pz, i) => {
    const st = { status: new Array(pz.people).fill(null), culprit: null };
    for (let j = 0; j < pz.steps.length; j++) {
      const h = Engine.hint(pz, st, 1);
      const k = h.steps && h.steps.length ? h.steps[h.steps.length - 1] : h.step;
      if (k !== j) { flow = false; why.push('第' + (i + 1) + '話 手順' + j + '→' + k); break; }
      for (const f of pz.steps[j].facts) { if (f.kind === 'status') st.status[f.person] = f.value; else if (f.cand.length === 1) st.culprit = f.cand[0]; }
    }
    if (Engine.hint(pz, st, 1).kind !== 'done' || !Engine.check(pz, st).ok) { flow = false; why.push('第' + (i + 1) + '話 そろわない'); }
  });
  check('はじめての事件: 手順の順に押すと、案内が1手ずつ進み、最後は解ける', flow, why.join(' '));
  // 第3話の仮定の案内: 仮の判子（イツキを嘘つき）は答えと逆で、案内どおりにそろえて提出すると食い違いが出る
  const hy = T[2].hypo;
  const hs3 = { status: new Array(4).fill(null), culprit: null };
  hs3.status[hy.p] = hy.v;
  hy.seq.forEach((x) => { hs3.status[x.p] = x.v; if (x.c != null) hs3.culprit = x.c; });
  const r3 = Engine.check(c, hs3);
  check('はじめての事件: 第3話の仮の判子は答えと逆で、案内どおりに提出すると食い違いが出る',
    c.solution.status[hy.p] !== hy.v && c.steps[0].assume && c.steps[0].assume.person === hy.p && hs3.status.every(Boolean) && !r3.ok && !!r3.contradiction, r3.contradiction ? r3.contradiction.message : JSON.stringify(r3));
  check('はじめての事件: 第3話のあらましは差し替えて、店の主人が自分の店の事件の犯人にならない', typeof T[2].story === 'string' && T[2].story.indexOf('パン屋') < 0 && T[2].story.indexOf('容疑者は4人') >= 0 && c.villagers[c.solution.culprit].job === 'パン屋', T[2].story);
}

/* ---------- はじめての事件: 案内（tutGuide を動かす） ---------- */
{
  const T = TU.TUTORIAL;
  const play = (ep, marks, culprit, lastWrong) => {
    const pz = TU.tutorialPuzzle(ep);
    TG.setP({ mode: 'tutorial', ep, tut: T[ep - 1], pz, state: 'playing', marks: marks.slice(), culprit: culprit == null ? null : culprit, lastWrong: lastWrong || null, seenSteps: [] });
    return pz;
  };
  const hy = T[2].hypo;
  check('はじめての事件: 第3話の仮定の案内は、どの段にも「仮定と逆の判子」のときの文がある', hy.seq.every((x) => typeof x.off === 'string' && x.off.indexOf('仮定のままだと') >= 0), '');
  // 仮定どおりに押していくと、順に次の案内が出て、そろうと［推理を提出］の案内
  play(3, [null, 'L', null, null], null);
  const g0 = TG.tutGuide('mark');
  play(3, ['H', 'L', 'L', 'L'], 0);
  const gReady = TG.tutGuide('mark');
  check('はじめての事件: 第3話でイツキの［嘘つき］を押すと仮定の案内、仮定どおりにそろうと提出の案内', g0.kind === '仮定' && g0.text === hy.seq[0].text && gReady.text === hy.ready, g0.text + ' / ' + gReady.text);
  // 仮定と逆の判子（エマを正直者・犯人を別の人）
  play(3, [null, 'L', null, 'H'], null);
  const gOff = TG.tutGuide('mark');
  play(3, ['H', 'L', 'L', 'L'], 3);
  const gOffC = TG.tutGuide('mark');
  check('はじめての事件: 第3話で仮定と逆の判子を押すと「仮定のままだと…」と知らせる（エマ・犯人）', gOff.text === hy.seq[0].off && gOff.tone === 'warn' && gOffC.text === hy.seq[2].off, gOff.text + ' / ' + gOffC.text);
  check('はじめての事件: 第3話の「残るアオイ」の案内に、嘘つきは犯人になれない理由がある', /嘘つきの3人は犯人になれない/.test(hy.seq[2].text), hy.seq[2].text);
  // 提出して食い違ったあと、押し直した・開き直した（lastWrong が同じ答え）ときは、提出の案内ではなく食い違いの続き
  play(3, ['H', 'L', 'L', 'L'], 0);
  const key = TG.answerKey();
  play(3, ['H', 'L', 'L', 'L'], 0, key);
  const gAgain = TG.tutGuide('mark'), gReopen = TG.tutGuide('start');
  check('はじめての事件: 第3話で食い違ったあと、同じ判子に押し直す・開き直すと、押せない提出ではなく食い違いの案内', gAgain.text === hy.wrong && gReopen.text === hy.wrong && gAgain.tone === 'warn', gAgain.text);
  // 第1話の見直し: 考え方（その手の証言）と付け替え方を添える
  play(1, ['H', 'H', null], null);
  const r1 = TG.tutGuide('mark');
  play(1, ['H', 'L', 'H'], 2);
  const r2 = TG.tutGuide('mark');
  check('はじめての事件: 第1話の見直しは、考え方（スズの証言）と［嘘つき］で付け替えられることを添える',
    r1.kind === '見直し' && r1.text.indexOf('スズは正直者なので、『ナギは嘘つきだよ』は本当。') >= 0 && r1.text.indexOf('［嘘つき］を押せば付け替えられます') >= 0 && r1.text.indexOf('もう一度押すと消せます') < 0 &&
    r2.kind === '見直し' && r2.text.indexOf('［犯人］は、ほかの人のカードで押せば付け替えられます') >= 0, r1.text + ' / ' + r2.text);
  // 第2話の見直しも考え方を添える（文が途中で切れる手は案内の文）
  play(2, [null, 'L', null, 'H'], null);
  const r3 = TG.tutGuide('mark');
  play(2, ['L', 'H', null, 'H'], null);
  const r4 = TG.tutGuide('mark');
  check('はじめての事件: 第2話の見直しも考え方を添え、文が「ので」で途切れない（途切れる手は案内の文）',
    r3.kind === '見直し' && r3.text.indexOf('ハルは正直者なので、『サクは正直者なんだ』は本当。') >= 0 && r3.text.indexOf('付け替え') < 0 &&
    r4.kind === '見直し' && r4.text.indexOf(T[1].steps[2]) >= 0 && !/ので$/.test(r4.text), r3.text + ' / ' + r4.text);
  check('はじめての事件: 第3話の最初の案内は、押すボタンの名前（［嘘つき］）で書く', /イツキの［嘘つき］を/.test(T[2].steps[0]) && !/仮の判子/.test(T[2].steps[0] + hy.ready), T[2].steps[0]);
  check('はじめての事件: 第3話の締めに、本番では食い違いを頭の中で確かめるとミスにならないことを書く', /本番/.test(T[2].solved) && /ミスにならない|ミスになりません/.test(T[2].solved), T[2].solved);
}

/* ---------- 保存: 壊れた保存・古い版のタブ・記録を消した別のタブ（STORE を動かす） ---------- */
{
  const KEY = ST.KEY;
  const base = () => ({
    v: 1, t: 5, epoch: '', settings: { sound: false, haptics: true, theme: 'dark' },
    daily: { '2026-10-13': { state: 'solved', marks: ['H', 'L', 'H', 'H', 'L'], culprit: 1, mistakes: 0, hints: 0, attempts: '■', elapsed: 90, v: 3, solvedOnDay: true, streak: 5 } },
    practice: { byStar: { 1: null, 2: null, 3: null }, hard: null, solved: 3 },
    stats: { streak: 5, bestStreak: 9, lastDailyDate: '2026-10-13', totalSolved: 12, perfect: 4 },
    weekly: { '2026-10-12': { state: 'solved', marks: [], attempts: '□■', elapsed: 600, v: 3, title: 'ひっくり返った花の鉢' } },
    tutorial: { done: 2, dismissed: false, cur: null },
  });
  const kept = (r, bad) => !!r && r.stats.totalSolved === 12 && r.stats.streak === 5 && r.stats.bestStreak === 9 && !!r.daily['2026-10-13'] &&
    !!r.weekly['2026-10-12'] && r.weekly['2026-10-12'].state === 'solved' && (bad == null || !Object.prototype.hasOwnProperty.call(r.weekly, bad)) && r.tutorial.done === 2 && r.settings.sound === false && r.settings.theme === 'dark';
  // 1) weekly に実在しない日付・月曜でない日・第1週より前・形の違うキーがあっても、記録全体は読める
  const badKeys = ['2026-10-32', '2026-13-01', '2026-02-30', '2027-02-29', '2026-10-13', '2026-09-21', '2026-1-05', 'abc', '__proto__'];
  const failed = [];
  badKeys.forEach((k) => {
    // JSON の文字に直接入れる（__proto__ も、保存を読んだときと同じく自分のキーになる）
    LS.set(KEY, JSON.stringify(base()).replace('"weekly":{', '"weekly":{' + JSON.stringify(k) + ':{"state":"playing","marks":["H"],"v":3},'));
    let r = null; try { r = ST.readStore(); } catch (e) { r = null; }
    if (!kept(r, k)) failed.push(k);
  });
  check('保存: weekly に読めないキー（2026-10-32・2026-13-01・2026-02-30・月曜でない日など）があっても、ほかの記録は全部読める', failed.length === 0, failed.join(' '));
  // 2) その状態で起動して設定を1つ変えても（update → persist）、記録を消さない
  const o2 = base(); o2.weekly['2026-10-32'] = { state: 'playing', v: 3 };
  LS.set(KEY, JSON.stringify(o2));
  ST.setS(ST.readStore() || ST.defaults());   // 起動時と同じ
  ST.update((s) => { s.settings.haptics = false; });
  const sv2 = JSON.parse(LS.get(KEY));
  check('保存: 読めない weekly のキーがある保存で起動して設定を変えても、解決数・連続・日替わり・今週の難問の記録が残る（読めないキーだけ消える）',
    sv2.stats.totalSolved === 12 && sv2.stats.streak === 5 && !!sv2.daily['2026-10-13'] && !!sv2.weekly['2026-10-12'] && !sv2.weekly['2026-10-32'] && sv2.settings.haptics === false, JSON.stringify(sv2.stats) + ' ' + Object.keys(sv2.weekly).join(','));
  // 3) tutorial が壊れていても、ほかの記録は読め、tutorial は決まった範囲に収まる
  const tuts = ['x', 7, null, [], { done: 'abc', dismissed: 'yes', cur: 'x' }, { done: 99, cur: { ep: 7 } }, { done: -3, cur: { ep: 2, marks: 'zz', culprit: 'a', elapsed: 'NaN' } }, { done: 1.7, cur: { ep: 3.5 } }];
  const tf = [];
  tuts.forEach((t, i) => {
    const o = base(); o.tutorial = t;
    LS.set(KEY, JSON.stringify(o));
    let r = null; try { r = ST.readStore(); } catch (e) { r = null; }
    const tu = r && r.tutorial;
    const ok = !!r && r.stats.totalSolved === 12 && !!r.weekly['2026-10-12'] && Number.isInteger(tu.done) && tu.done >= 0 && tu.done <= 3 && typeof tu.dismissed === 'boolean' &&
      (tu.cur === null || (Number.isInteger(tu.cur.ep) && tu.cur.ep >= 1 && tu.cur.ep <= 3 && Array.isArray(tu.cur.marks) && Number.isFinite(tu.cur.elapsed)));
    if (!ok) tf.push(i + ':' + JSON.stringify(tu));
  });
  check('保存: 壊れた tutorial（文字・範囲外の話数・型違いの途中）でも、ほかの記録は読め、進み具合は 0〜3 話に収まる', tf.length === 0, tf.join(' '));
  // 4) 古い版のタブ（weekly・tutorial を知らない）が保存した直後に、このタブが保存する → 消された分を戻す
  const mineSrc = base();
  mineSrc.weekly['2026-10-05'] = { state: 'solved', attempts: '■', elapsed: 300, v: 3 };
  mineSrc.weekly['2026-10-12'] = { state: 'playing', marks: ['H', null, 'L'], elapsed: 40, v: 3 };
  mineSrc.tutorial = { done: 2, dismissed: true, cur: { ep: 3, marks: [null, 'L', null, null], v: 3 } };
  ST.setS(ST.sanitize(JSON.parse(JSON.stringify(mineSrc))));
  const old = base(); delete old.weekly; delete old.tutorial; old.t = 50;
  old.daily['2026-10-14'] = { state: 'solved', marks: ['H', 'L', 'H', 'H'], culprit: 1, attempts: '■', v: 3, solvedOnDay: true, streak: 6 };
  old.stats.totalSolved = 13; old.stats.streak = 6; old.stats.lastDailyDate = '2026-10-14';
  LS.set(KEY, JSON.stringify(old));
  ST.update((s) => { s.settings.sound = true; });
  const sv4 = JSON.parse(LS.get(KEY));
  check('保存: 古い版のタブが weekly・tutorial を消した保存に重ねても、このタブの今週の難問・はじめての事件を戻し、古いタブの解決も残す',
    !!sv4.weekly['2026-10-05'] && sv4.weekly['2026-10-05'].state === 'solved' && !!sv4.weekly['2026-10-12'] && sv4.tutorial.done === 2 && sv4.tutorial.dismissed === true && sv4.tutorial.cur && sv4.tutorial.cur.ep === 3 &&
    sv4.stats.totalSolved === 13 && !!sv4.daily['2026-10-14'] && sv4.settings.sound === true, JSON.stringify({ weekly: Object.keys(sv4.weekly || {}), tutorial: sv4.tutorial, total: sv4.stats.totalSolved }));
  // 5) 別のタブで記録を消した（epoch が違う）ときは戻さない
  ST.setS(ST.sanitize(JSON.parse(JSON.stringify(mineSrc))));
  const wiped = ST.defaults(); wiped.epoch = 'k2x9'; wiped.t = 60;
  LS.set(KEY, JSON.stringify(wiped));
  ST.update((s) => { s.settings.haptics = true; });
  const sv5 = JSON.parse(LS.get(KEY));
  check('保存: 別のタブで記録を消した（epoch が違う）あとは、このタブの今週の難問・はじめての事件を戻さない',
    sv5.epoch === 'k2x9' && Object.keys(sv5.weekly).length === 0 && sv5.tutorial.done === 0 && sv5.tutorial.cur === null && sv5.stats.totalSolved === 0, JSON.stringify({ epoch: sv5.epoch, weekly: Object.keys(sv5.weekly), tutorial: sv5.tutorial }));
  // 6) 同じ週は「解決」を優先（読み直した方が途中・手元が解決 → 解決。読み直した方が解決 → そのまま）
  const fr = ST.sanitize({ v: 1, weekly: { '2026-10-12': { state: 'playing', v: 3 }, '2026-10-05': { state: 'solved', attempts: '□■', v: 3 } } });
  const mn = ST.sanitize({ v: 1, weekly: { '2026-10-12': { state: 'solved', attempts: '■', v: 3 }, '2026-10-05': { state: 'playing', v: 3 } } });
  const cn = ST.carryNew(fr, mn);
  check('保存: 別のタブとの重ね合わせで、同じ週は解決を優先する（どちらのタブで解いても消えない）', cn.weekly['2026-10-12'].state === 'solved' && cn.weekly['2026-10-05'].state === 'solved' && cn.weekly['2026-10-05'].attempts === '□■', JSON.stringify(cn.weekly));
  // 7) 古い形の保存（weekly・tutorial なし）をそのまま読むと、空の weekly と最初の tutorial になる
  const r7 = ST.sanitize({ v: 1, stats: { totalSolved: 4 } });
  check('保存: 古い版の保存（weekly・tutorial なし）も読め、形の v は 1 のまま', r7.v === 1 && Object.keys(r7.weekly).length === 0 && r7.tutorial.done === 0 && r7.tutorial.cur === null && r7.stats.totalSolved === 4, JSON.stringify(r7.tutorial));
  LS.clear(); ST.setS(ST.defaults());
}

/* ---------- ホーム: 「はじめての方へ」を出すか（showTutCard を動かす） ---------- */
{
  const at = (f) => { const s = ST.defaults(); f(s); ST.setS(s); return HC.showTutCard(); };
  const cases = [
    ['記録が何も無い（初回）', (s) => {}, true],
    ['今日の事件を開いただけ（解決0）', (s) => { s.daily['2026-10-14'] = { state: 'playing', marks: [], v: 3 }; }, true],
    ['日替わりを1件解いた・はじめての事件は未着手', (s) => { s.stats.totalSolved = 1; }, false],
    ['練習を1件解いた', (s) => { s.practice.solved = 1; }, false],
    ['今週の難問を解いた', (s) => { s.weekly['2026-10-12'] = { state: 'solved' }; }, false],
    ['日替わりを解いたが、はじめての事件を進めている', (s) => { s.stats.totalSolved = 1; s.tutorial.done = 1; }, true],
    ['閉じた', (s) => { s.tutorial.dismissed = true; }, false],
    ['3話とも解いた', (s) => { s.tutorial.done = 3; }, false],
  ];
  const bad = cases.filter((c) => at(c[1]) !== c[2]).map((c) => c[0]);
  check('ホーム: 「はじめての方へ」は初回と、はじめての事件を進めている人に出し、閉じた・3話解いた・ほかを解いた人には出さない', bad.length === 0, bad.join(' / '));
  ST.setS(ST.defaults());
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
  // 今週の難問・はじめての事件・事件簿
  check('保存: 既定の形に weekly・tutorial があり、形の v は 1 のまま', /v: 1,/.test(fnBody('defaults') || SRC.slice(SRC.indexOf('const defaults = () => ({'), SRC.indexOf('const defaults = () => ({') + 1500)) &&
    has(/weekly: \{\},/) && has(/tutorial: \{ done: 0, dismissed: false, cur: null \},/), '');
  check('保存: 読み込み（sanitize）で weekly（月曜の日付だけ）と tutorial を残す（読み込み直しで消えない）',
    /mondayOf\(k\) !== k/.test(fnBody('sanitize')) && /d\.weekly\[k\] = x;/.test(fnBody('sanitize')) && /d\.tutorial\.cur = /.test(fnBody('sanitize')) && /d\.tutorial\.done = /.test(fnBody('sanitize')), '');
  check('保存: 古い版のタブが消した weekly・tutorial を戻す（update と別タブの読み直し）', /S = carryNew\(fresh, S\)/.test(fnBody('update')) && has(/S = wiped \? fresh : carryNew\(fresh, S\);/), '');
  check('事件: 今週の難問・はじめての事件は、練習の途中を上書きしない（saveProgress の分岐）',
    /P\.mode === 'weekly'/.test(fnBody('saveProgress')) && /P\.mode === 'tutorial'/.test(fnBody('saveProgress')) && /s\.weekly\[P\.week\]/.test(fnBody('saveProgress')) && /s\.tutorial\.cur = /.test(fnBody('saveProgress')), '');
  const solvedBody = fnBody('onSolved');
  const wkPart = solvedBody.slice(solvedBody.indexOf("P.mode === 'weekly'"), solvedBody.indexOf("P.mode === 'tutorial'"));
  const tuPart = solvedBody.slice(solvedBody.indexOf("P.mode === 'tutorial'"), solvedBody.indexOf('} else {', solvedBody.indexOf("P.mode === 'tutorial'")));
  check('事件: 今週の難問・はじめての事件を解いても、連続日数・解決数・練習の解決数に数えない',
    wkPart.length > 0 && tuPart.length > 0 && !/totalSolved|addStreak|perfect|practice\.solved/.test(wkPart + tuPart) && /s\.tutorial\.done = Math\.max/.test(tuPart), '');
  check('事件: ［次の事件］の3か所は nextCase を通す（今週の難問で★1の練習を開かない）',
    (SRC.match(/newPractice\(P\.slot\)/g) || []).length === 1 && /newPractice\(P\.slot\)/.test(fnBody('nextCase')) && (SRC.match(/nextCase\(\)/g) || []).length >= 3, '');
  check('事件: 今週の難問は Worker の経路（heavy）で作る', has(/const heavy = \(spec\.mode === 'practice' && spec\.people >= 7\) \|\| weekly;/) && has(/seed: weekSeed\(spec\.week\), people: 9, star: 3/), '');
  check('事件: はじめての事件ではミスもヒントも数えない', /if \(!tut\) \{ P\.mistakes\+\+; P\.attempts \+= '□'; \}/.test(fnBody('submit')) && /!done && isNew && !free/.test(fnBody('showHint')), '');
  check('事件: 今週の難問の題名は日付の題名（titleCache）を上書きしない', /if \(P\.date\) titleCache\[P\.date\]/.test(fnBody('startCase')) && !/week: spec\.week[^}]*date:/.test(fnBody('startCase')), '');
  check('ホーム: はじめての方への案内は、まだ1件も解いていない人か、進めている人に出す（開いただけでは消さない）',
    /totalSolved/.test(fnBody('showTutCard')) && /practice\.solved/.test(fnBody('showTutCard')) && /weeksSolved\(S\)/.test(fnBody('showTutCard')) && /dismissed/.test(fnBody('showTutCard')), '');
  check('事件簿: 全日を並べ、最初は30行・もっと見るで60行ずつ（直近14日の決め打ちが無い）',
    has(/const BOOK_FIRST = 30, BOOK_MORE = 60;/) && /bookItemsHTML\(tab, list, 0, shown\)/.test(fnBody('renderBook')) && !/i < 14/.test(fnBody('renderBook')) && /insertAdjacentHTML\('beforeend'/.test(fnBody('bookMore')), '');
  check('事件簿: 描き直しても出している行数を保つ（開き直したときだけ30行に戻す）', has(/if \(v === 'book'\) \{ if \(!opt\.restore\) book\.shown = /), '');
  check('文言: 「直近14日」が残っていない', !/直近14日/.test(SRC), '');
}

let fail = 0;
console.log('検査対象: ' + target + '\n');
for (const r of results) {
  if (!r.ok) fail++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}` + (r.ok || !r.detail ? '' : '\n        ' + r.detail));
}
console.log(`\n${fail ? 'FAIL' : 'PASS'}  ${results.length}項目`);
process.exit(fail ? 1 : 0);
