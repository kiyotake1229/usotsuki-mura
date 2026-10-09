#!/usr/bin/env node
// 嘘つき村の事件簿 — エンジン検査
// 使い方: node tools/check-engine.mjs [index.html | engine.js] [--count 200] [--days 120] [--count-hard 100] [--story-days 1096] [--perf-seeds 400]
// .html なら「// ==ENGINE START==」〜「// ==ENGINE END==」の間を取り出して評価する。
// 検算はエンジンの関数を使わず、ここで独立に総当たり・論理チェックをする。
// --count = 3〜6人の★×人数ごとの問題数、--days = 日替わりの日数、--count-hard = 7〜9人（難問）の人数ごとの問題数
// --story-days = 事件の割り当て（季節・14日・7日）を dailyConfig だけで確かめる日数（既定 約3年）
// --perf-seeds = 生成時間の最悪値を探す数（★2 の5人・6人をアプリと同じ形の seed で。表示だけ）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : def;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const OPT_NAMES = ['--count', '--days', '--count-hard', '--story-days', '--perf-seeds'];
const optIdx = new Set(OPT_NAMES.map((n) => argv.indexOf(n)).filter((i) => i >= 0).map((i) => i + 1));
const target = path.resolve(argv.find((a, i) => !a.startsWith('--') && !optIdx.has(i)) || path.join(here, '..', 'index.html'));
const COUNT = parseInt(opt('--count', '200'), 10);
const DAYS = parseInt(opt('--days', '120'), 10);
const COUNT_HARD = parseInt(opt('--count-hard', '100'), 10);
const STORY_DAYS = parseInt(opt('--story-days', '1096'), 10);
const PERF_SEEDS = parseInt(opt('--perf-seeds', '400'), 10);

/* ---------- 回帰テストの基準（問題が変わっていないか） ----------
 * VERSION ごとに、次の3つの SHA-256（先頭32文字）を持つ。
 *   daily365    = 2026-10-01 から365日分の JSON.stringify(Engine.daily(日付)) + '\n' をつないだもの
 *   practice240 = ★1〜3 × 3〜6人 × seed 'r0'〜'r19' の JSON.stringify(Engine.generate(...)) + '\n' をつないだもの
 *   hard90      = 7〜9人 × seed 'h0'〜'h29'（★3）の JSON.stringify(Engine.generate(...)) + '\n' をつないだもの
 * 値が変わったら、全員の日替わり・練習・難問の問題が変わったということ。
 * 難問（7〜9人）の途中は seed だけを保存して開き直すときに作り直すので、作り方が変わると解きかけの難問が
 * 別の問題で再開される。意図した変更なら、エンジンの VERSION を上げて docs に書き、ここに新しい VERSION の値を足す。 */
const GOLDEN = {
  3: { daily365: '964b8ed41145a3cc4878e1c4afa8533e', practice240: 'fe126bada59957334b67c3251b261039', hard90: 'd953108b9d6771263fa37c11080f0660' },
};

/* ---------- 7〜9人（難問）の決まり（エンジンの HARD と同じ値。ここでは独立に持つ） ----------
 * hyps = 仮定の回数の範囲、sumMin = 仮定の手の合計の下限、chainMax = 連鎖の上限、lines = 解説の行数の上限、
 * chars = 解説の文字数の上限、minTypes = 証言の種類の数の下限、typeCap = 同じ種類の証言の数の上限 */
const HARD_SPEC = {
  7: { hyps: [2, 3], sumMin: 7, chainMax: 10, lines: 22, chars: 1300, minTypes: 4, typeCap: 2 },
  8: { hyps: [2, 4], sumMin: 7, chainMax: 11, lines: 24, chars: 1400, minTypes: 5, typeCap: 3 },
  9: { hyps: [2, 4], sumMin: 8, chainMax: 12, lines: 26, chars: 1500, minTypes: 5, typeCap: 3 },
};
const HARD_PERF = { avg: 150, max: 1500 }; // 7〜9人の生成時間の目標（ms。Node）
// 生成時間の目安（まだ合否に入れていない。#0012 の #22・#23 を直したら基準にする）
const PERF_GOAL = { main: 150, firstConfig: 50 };

/* ---------- 読み込み ---------- */
const SRC = fs.readFileSync(target, 'utf8');
function extractCode(file) {
  if (!file.endsWith('.html')) return SRC;
  const lines = SRC.split('\n');
  const s = lines.findIndex((l) => l.includes('// ==ENGINE START=='));
  const e = lines.findIndex((l) => l.includes('// ==ENGINE END=='));
  if (s < 0 || e < 0 || e <= s) throw new Error('ENGINE START/END の目印が見つかりません: ' + file);
  return lines.slice(s + 1, e).join('\n');
}
function loadEngine(code) {
  const sandbox = { module: { exports: {} } };
  vm.createContext(sandbox);
  vm.runInContext(code + '\n;module.exports = (typeof Engine !== "undefined") ? Engine : module.exports;', sandbox, { filename: path.basename(target) });
  const E = sandbox.module.exports;
  for (const fn of ['generate', 'daily', 'dailyConfig', 'check', 'hint', 'solve']) {
    if (typeof E[fn] !== 'function') throw new Error('Engine.' + fn + ' がありません');
  }
  return E;
}
// Web Worker と同じ条件で読む: window・document・module が無く、self（= グローバル）だけがある
function loadAsWorker(code) {
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.postMessage = () => {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: path.basename(target) + ' (worker)' });
  return sandbox.self.Engine;
}
const code = extractCode(target);
const E = loadEngine(code);
const E2 = loadEngine(code); // 再現性の確認用（キャッシュを共有しない別インスタンス）
const fresh = () => loadEngine(code);

/* ---------- 結果の記録 ---------- */
const results = [];
const failures = {};
function record(name, ok, detail) {
  let r = results.find((x) => x.name === name);
  if (!r) { r = { name, pass: 0, fail: 0 }; results.push(r); }
  if (ok) r.pass++;
  else {
    r.fail++;
    failures[name] = failures[name] || [];
    if (failures[name].length < 5) failures[name].push(detail);
  }
  return ok;
}

/* ---------- 独立した論理 ---------- */
const pc = (x) => { let n = 0; while (x) { n += x & 1; x >>>= 1; } return n; };
const isH = (h, p) => ((h >> p) & 1) === 1;
function truthIndep(S, h, c) {
  const { type, a, b, k } = S;
  switch (type) {
    case 'LIAR': return !isH(h, a);
    case 'HONEST': return isH(h, a);
    case 'CULPRIT': return c === a;
    case 'NOTCULPRIT': return c !== a;
    case 'CULPRIT_LIAR': return !isH(h, c);
    case 'CULPRIT_HONEST': return isH(h, c);
    case 'SAME': return isH(h, a) === isH(h, b);
    case 'DIFF': return isH(h, a) !== isH(h, b);
    case 'CULPRIT_IN': return c === a || c === b;
    case 'ATLEAST1LIAR': return !isH(h, a) || !isH(h, b);
    case 'HONESTCOUNT': return pc(h) === k;
  }
  throw new Error('unknown type ' + type);
}
const consistentStmt = (S, h, c) => truthIndep(S, h, c) === isH(h, S.speaker);
const WORLDS = {};
function allWorlds(N) {
  if (WORLDS[N]) return WORLDS[N];
  const out = [];
  for (let h = 0; h < (1 << N); h++) for (let c = 0; c < N; c++) out.push([h, c]);
  return (WORLDS[N] = out);
}
function bruteSolutions(pz) {
  const N = pz.people;
  return allWorlds(N).filter(([h, c]) => {
    if (pz.given && isH(h, pz.given.person) !== (pz.given.value === 'H')) return false;
    return pz.statements.every((S) => consistentStmt(S, h, c));
  });
}
const STAR_MIN = { LIAR: 1, HONEST: 1, CULPRIT: 1, NOTCULPRIT: 1, CULPRIT_LIAR: 2, CULPRIT_HONEST: 2, SAME: 1, DIFF: 1, CULPRIT_IN: 2, ATLEAST1LIAR: 3, HONESTCOUNT: 3 };
const CULPRIT_TYPES = { CULPRIT: 1, NOTCULPRIT: 1, CULPRIT_IN: 1, CULPRIT_LIAR: 1, CULPRIT_HONEST: 1 };
function stmtAllowed(S, star, N) {
  const s = S.speaker;
  const inR = (x) => Number.isInteger(x) && x >= 0 && x < N;
  if (!(S.type in STAR_MIN)) return false;
  let need = STAR_MIN[S.type];
  switch (S.type) {
    case 'LIAR': case 'HONEST': if (!inR(S.a) || S.a === s) return false; break;
    case 'CULPRIT': case 'NOTCULPRIT': if (!inR(S.a)) return false; break;
    case 'SAME': case 'DIFF': if (!inR(S.a) || !inR(S.b) || S.a === S.b) return false; if (S.a === s || S.b === s) need = 2; break;
    case 'CULPRIT_IN': case 'ATLEAST1LIAR': if (!inR(S.a) || !inR(S.b) || S.a === S.b) return false; break;
    case 'HONESTCOUNT': if (!Number.isInteger(S.k) || S.k < 0 || S.k > N) return false; break;
  }
  return star >= need;
}

// 事実（st: 'H'|'L'|null, cand: Set）と1つの証言から導けるかを総当たりで確かめる
function factWorlds(N, st, cand) {
  return allWorlds(N).filter(([h, c]) => cand.has(c) && st.every((v, p) => v == null || isH(h, p) === (v === 'H')));
}
// 世界の集まり W で、まだわかっていない人のうち決まる人と、残る犯人の候補
function derive(N, W, st, cand) {
  const H = new Set(), L = new Set();
  for (let p = 0; p < N; p++) {
    if (st[p] != null) continue;
    if (W.every(([h]) => isH(h, p))) H.add(p); else if (W.every(([h]) => !isH(h, p))) L.add(p);
  }
  const C = new Set(W.map(([, c]) => c));
  return { H, L, C, narrowed: C.size < cand.size };
}
function verifyDirect(pz, step, st, cand, where) {
  const N = pz.people;
  const errs = [];
  if (!Array.isArray(step.facts) || step.facts.length === 0) errs.push(where + ': 新しい事実がない');
  let W;
  if (step.source === 'given') {
    if (!pz.given) return [where + ': 手がかりが無いのに given を使っている'];
    W = factWorlds(N, st, cand).filter(([h]) => isH(h, pz.given.person) === (pz.given.value === 'H'));
  } else {
    const S = pz.statements[step.source];
    if (!S) return [where + ': 証言番号が不正 ' + step.source];
    W = factWorlds(N, st, cand).filter(([h, c]) => consistentStmt(S, h, c));
  }
  if (W.length === 0) errs.push(where + ': 事実と証言が矛盾しているのに直接の推論になっている');
  for (const f of step.facts || []) {
    if (f.kind === 'status') {
      if (st[f.person] != null) errs.push(where + ': 既にわかっている人の判定を再び導いている');
      if (!W.every(([h]) => isH(h, f.person) === (f.value === 'H'))) errs.push(where + ': ' + f.person + 'が' + f.value + 'とは言い切れない');
    } else if (f.kind === 'culprit') {
      const C = new Set(f.cand);
      if (!(C.size < cand.size) || ![...C].every((x) => cand.has(x))) errs.push(where + ': 犯人候補が絞れていない');
      if (!W.every(([, c]) => C.has(c))) errs.push(where + ': 犯人候補の絞り込みが言い切れない');
    } else errs.push(where + ': 不明な事実 ' + JSON.stringify(f));
  }
  return errs;
}
function applyFacts(step, st, cand) {
  for (const f of step.facts) {
    if (f.kind === 'status') st[f.person] = f.value;
    else cand = new Set(f.cand);
  }
  return cand;
}
// 「犯人は嘘つきだ」を話し手が未確定のまま使い、犯人候補だけを絞る手（自己言及のひっかけ）か
function selfRefTrick(pz, step, st) {
  if (step.source === 'given') return false;
  const S = pz.statements[step.source];
  return !!S && S.type === 'CULPRIT_LIAR' && st[S.speaker] == null && step.facts.length > 0 && step.facts.every((f) => f.kind === 'culprit');
}
// 話し手が未確定で、証言の真偽も事実から決まらない手（1証言内の場合分け）か
function caseSplit(pz, step, st, cand) {
  if (step.source === 'given') return false;
  const S = pz.statements[step.source];
  if (!S || st[S.speaker] != null) return false;
  const tv = new Set(factWorlds(pz.people, st, cand).map(([h, c]) => truthIndep(S, h, c)));
  return tv.size > 1;
}
function verifySteps(pz) {
  const N = pz.people;
  const errs = [];
  const st = Array(N).fill(null);
  let cand = new Set(Array.from({ length: N }, (_, i) => i));
  let hyps = 0, chain = 0, sum = 0;
  const used = new Set();
  if (!Array.isArray(pz.steps) || !pz.steps.length) return { errs: ['解説が空'], hyps, chain, used };
  pz.steps.forEach((step, si) => {
    const where = '手順' + (si + 1);
    if (step.kind === 'direct') {
      if (selfRefTrick(pz, step, st)) errs.push(where + ': 自己言及のひっかけ（犯人は嘘つきだ）を直接の推論に使っている');
      errs.push(...verifyDirect(pz, step, st, cand, where));
      if (step.source !== 'given') used.add(step.source);
      cand = applyFacts(step, st, cand);
    } else if (step.kind === 'hypo') {
      hyps++;
      const a = step.assume || {};
      const st2 = st.slice();
      let cand2 = new Set(cand);
      if (a.kind === 'status') {
        if (st[a.person] != null) errs.push(where + ': 既にわかっている人を仮定している');
        st2[a.person] = a.value;
      } else if (a.kind === 'culprit') {
        if (!cand.has(a.person) || cand.size < 2) errs.push(where + ': 犯人の仮定が不正');
        cand2 = new Set([a.person]);
      } else errs.push(where + ': 仮定の形が不正');
      if (!Array.isArray(step.sub)) { errs.push(where + ': sub が無い'); return; }
      step.sub.forEach((sub, j) => {
        if (sub.kind !== 'direct') errs.push(where + ': 仮定の中で別の仮定（入れ子）');
        if (selfRefTrick(pz, sub, st2)) errs.push(where + '-' + (j + 1) + ': 自己言及のひっかけを直接の推論に使っている');
        if (caseSplit(pz, sub, st2, cand2)) errs.push(where + '-' + (j + 1) + ': 仮定の中で場合分けをしている（入れ子）');
        errs.push(...verifyDirect(pz, sub, st2, cand2, where + '-' + (j + 1)));
        if (sub.source !== 'given') used.add(sub.source);
        cand2 = applyFacts(sub, st2, cand2);
      });
      const CS = pz.statements[step.contraSource];
      if (!CS) errs.push(where + ': 矛盾の証言が無い');
      else {
        used.add(step.contraSource);
        const W = factWorlds(N, st2, cand2).filter(([h, c]) => consistentStmt(CS, h, c));
        if (W.length) errs.push(where + ': 矛盾が本物ではない');
      }
      const len = step.sub.length + 1;
      if (len > chain) chain = len;
      sum += len;
      // 結論 = 仮定の否定
      const f = step.facts || [];
      if (a.kind === 'status') {
        const opp = a.value === 'H' ? 'L' : 'H';
        if (!(f.length === 1 && f[0].kind === 'status' && f[0].person === a.person && f[0].value === opp)) errs.push(where + ': 結論が仮定の否定になっていない');
      } else if (a.kind === 'culprit') {
        const exp = [...cand].filter((x) => x !== a.person).sort((x, y) => x - y).join(',');
        if (!(f.length === 1 && f[0].kind === 'culprit' && f[0].cand.slice().sort((x, y) => x - y).join(',') === exp)) errs.push(where + ': 結論が仮定の否定になっていない');
      }
      cand = applyFacts(step, st, cand);
    } else errs.push(where + ': 不明な手順 ' + step.kind);
  });
  const sol = pz.solution;
  if (st.some((v) => v == null)) errs.push('解説の最後で決まっていない人がいる');
  if (cand.size !== 1) errs.push('解説の最後で犯人が1人に決まっていない');
  if (st.some((v, i) => v !== sol.status[i]) || !cand.has(sol.culprit)) errs.push('解説の結論が正解と違う');
  return { errs, hyps, chain, sum, used };
}
const starFrom = (hyps, chain) => (hyps === 0 ? 1 : hyps === 1 && chain <= 4 ? 2 : 3);

/* ---------- テキスト ---------- */
const BAD = /undefined|NaN|null|\[object/;
// 証言の文面を、人が読むとおりに解釈する（type を見ない）。語尾は話し方によって変わる
function readStmt(text, speaker, names) {
  const P = '(' + names.slice().sort((x, y) => y.length - x.length).join('|') + '|わたし)';
  const E = '(?:なんだ|なのよ|だよ|だぜ|だぞ|んだ|のよ|だ|さ|よ|ぜ|わ|ぞ)?';
  const idx = (x) => (x === 'わたし' ? speaker : names.indexOf(x));
  let m;
  const R = (re) => (m = new RegExp('^' + re + '$').exec(text));
  if (R(P + 'は嘘つき' + E)) { const x = idx(m[1]); return (h) => !isH(h, x); }
  if (R(P + 'は正直者' + E)) { const x = idx(m[1]); return (h) => isH(h, x); }
  if (R('(?:犯人は|やったのは)嘘つき' + E)) return (h, c) => !isH(h, c);
  if (R('(?:犯人は|やったのは)正直者' + E)) return (h, c) => isH(h, c);
  if (R('犯人は' + P + E) || R(P + 'が犯人' + E) || R('やったのは' + P + E)) { const x = idx(m[1]); return (h, c) => c === x; }
  if (R(P + 'は(?:犯人じゃない|やってない)' + E)) { const x = idx(m[1]); return (h, c) => c !== x; }
  if (R(P + 'と' + P + 'は(?:同じ側|、2人とも正直者か、2人とも嘘つき)' + E)) { const x = idx(m[1]), y = idx(m[2]); return (h) => isH(h, x) === isH(h, y); }
  if (R(P + 'と' + P + 'は(?:違う側|、片方が正直者で片方が嘘つき)' + E)) { const x = idx(m[1]), y = idx(m[2]); return (h) => isH(h, x) !== isH(h, y); }
  if (R('犯人は' + P + 'か' + P + 'のどちらか' + E) || R(P + 'か' + P + '、どちらかが犯人' + E)) { const x = idx(m[1]), y = idx(m[2]); return (h, c) => c === x || c === y; }
  if (R(P + 'と' + P + 'のうち、少なくとも1人は嘘つき' + E) || R(P + 'と' + P + 'が2人とも正直者ってことはない' + E)) { const x = idx(m[1]), y = idx(m[2]); return (h) => !isH(h, x) || !isH(h, y); }
  if (R('わたしたち(\\d)人のうち、正直者はちょうど(\\d)人' + E)) { if (+m[1] !== names.length) return null; const k = +m[2]; return (h) => pc(h) === k; }
  if (R('わたしも入れて数えると、正直者はちょうど(\\d)人' + E)) { const k = +m[1]; return (h) => pc(h) === k; }
  return null;
}
// 監査で直した言い回しが戻っていないか
const OLD_PHRASES = [
  [/とわかっているので/, '「〜とわかっているので」'], [/だから、話した/, '「だから、話した〜」'], [/すると、この証言は/, '「すると、この証言は」'],
  [/みな(正直者|嘘つき)/, '「みな」'], [/正直者がちょうど\d人になってしまう/, 'だれが正直者か書かない人数の説明'], [/で\d人そろっている/, '「〜で〇人そろっている」'],
];
function stepTexts(pz) {
  const out = [];
  for (const s of pz.steps) {
    out.push({ kind: s.kind, text: s.text });
    if (s.kind === 'hypo') { for (const x of s.sub || []) out.push({ kind: 'direct', text: x.text }); out.push({ kind: 'contra', text: s.contradiction }); out.push({ kind: 'conc', text: s.conclusion }); }
  }
  return out;
}
function collectStrings(o, out = []) {
  if (typeof o === 'string') out.push(o);
  else if (Array.isArray(o)) o.forEach((x) => collectStrings(x, out));
  else if (o && typeof o === 'object') Object.values(o).forEach((x) => collectStrings(x, out));
  return out;
}
function hasUndefined(o) {
  if (o === undefined) return true;
  if (typeof o === 'number' && !Number.isFinite(o)) return true;
  if (Array.isArray(o)) return o.some(hasUndefined);
  if (o && typeof o === 'object') return Object.values(o).some(hasUndefined);
  return false;
}
function textsOk(pz) {
  const errs = [];
  for (const s of collectStrings(pz)) if (BAD.test(s)) errs.push('不正な文字列: ' + s);
  if (hasUndefined(pz)) errs.push('undefined/NaN の値がある');
  const names = pz.villagers.map((v) => v.name);
  pz.statements.forEach((S, i) => {
    if (S.speaker !== i) errs.push('証言' + i + ' の話し手がカード順でない');
    if (typeof S.text !== 'string' || !S.text) { errs.push('証言' + i + ' の文が空'); return; }
    for (const x of [S.a, S.b]) {
      if (x == null) continue;
      if (x === S.speaker) { if (!S.text.includes('わたし')) errs.push('証言' + i + ' 自分を指すのに「わたし」が無い: ' + S.text); }
      else if (!S.text.includes(names[x])) errs.push('証言' + i + ' に ' + names[x] + ' が無い: ' + S.text);
    }
    if (S.type === 'HONESTCOUNT' && !S.text.includes(String(S.k))) errs.push('証言' + i + ' に人数が無い');
    if (S.type === 'HONESTCOUNT' && !S.text.includes('わたし')) errs.push('証言' + i + ' 「この中」に話し手が入るか分からない: ' + S.text);
    const f = readStmt(S.text, S.speaker, names);
    if (!f) errs.push('証言' + i + ' の文面を読めない: ' + S.text);
    else {
      let same = true;
      for (let h = 0; h < (1 << names.length) && same; h++) for (let c = 0; c < names.length; c++) if (f(h, c) !== truthIndep(S, h, c)) { same = false; break; }
      if (!same) errs.push('証言' + i + ' の文面と意味が違う: ' + S.text + ' ' + S.type);
    }
    if (/^わたし(は正直者|は嘘つき)/.test(S.text)) errs.push('自分の正直/嘘つきを言う証言');
  });
  if (pz.given) {
    const g = pz.given;
    if (!g.text || !g.text.includes(names[g.person]) || !g.text.includes(g.value === 'H' ? '正直者' : '嘘つき')) errs.push('手がかりの文が不正: ' + g.text);
  }
  const walk = (st, where) => {
    if (typeof st.text !== 'string' || !st.text.trim()) errs.push(where + ' の文が空');
    if (st.kind === 'hypo') {
      if (!st.contradiction || !st.conclusion) errs.push(where + ' の矛盾/結論の文が空');
      (st.sub || []).forEach((x, j) => walk(x, where + '-' + (j + 1)));
    }
  };
  pz.steps.forEach((st, i) => walk(st, '手順' + (i + 1)));
  for (const { kind, text } of stepTexts(pz)) {
    for (const [re, label] of OLD_PHRASES) if (re.test(text)) errs.push('直したはずの言い回し ' + label + ': ' + text);
    if (kind === 'direct') {
      const m = /つまり、([^。]+)。/.exec(text);
      const k = text.lastIndexOf('→ ');
      const f = k >= 0 ? text.slice(k + 2) : '';
      if (m && f && (m[1] === f || m[1].endsWith(f))) errs.push('「つまり」が結論のくり返し: ' + text);
    }
  }
  if (!pz.story || !pz.story.title || !pz.story.text || !pz.story.text.includes('容疑者は' + pz.people + '人')) errs.push('事件の文が不正');
  return errs;
}

/* ---------- 解説の文と区分の検査 ----------
 * 解説の文（プレイヤーが読むもの）が、中身（facts）とその時点の事実に合っているかを、文を読み直して確かめる。
 *  ・「→」の後（正直者・嘘つき・犯人の候補）が facts と同じ
 *  ・区分A の書き出し「Xは正直者なので、『…』は本当。」、区分B の理由「〜なので」、支えの文、区分C の形
 *  ・仮定の見出し「もしXが〜だとすると……」と結論「だから、Xは〜」、矛盾の文「ところが、…」
 *  ・区分（A＝話し手がわかっている／B＝話し手は未確定で、証言の真偽が事実で決まる／C＝どちらも未確定）が条件に合う
 *  ・仮定を置く前に、1つの証言と事実だけで決まる手が残っていない（残っていると仮定が増えて★が水増しされる）
 *  ・stats.back（仮定の外の区分B の数）と stats.unused（解説に使わない証言）が解説と同じ */
const SWv = { 正直者: 'H', 嘘つき: 'L' };
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const fmtSet = (s) => '{' + [...s].sort((x, y) => x - y).join(',') + '}';
function rx(names) {
  const NM = '(?:' + names.slice().sort((x, y) => y.length - x.length).join('|') + ')';
  return { NM, L: NM + '(?:(?:と|・)' + NM + ')*' };
}
const listOf = (s, names) => s.split(/と|・/).map((x) => names.indexOf(x));
// 結論（→ の後）を読む
function parseFacts(text, names) {
  const { NM, L } = rx(names);
  const out = { H: new Set(), L: new Set(), pos: null, exc: new Set(), bad: [] };
  for (const seg of text.split(/、|。/).filter((x) => x.length)) {
    let m;
    if ((m = new RegExp('^(' + L + ')は正直者$').exec(seg))) listOf(m[1], names).forEach((p) => out.H.add(p));
    else if ((m = new RegExp('^(' + L + ')は嘘つき$').exec(seg))) listOf(m[1], names).forEach((p) => out.L.add(p));
    else if ((m = new RegExp('^犯人は(' + NM + ')$').exec(seg))) out.pos = new Set([names.indexOf(m[1])]);
    else if ((m = new RegExp('^犯人は(' + NM + ')か(' + NM + ')$').exec(seg))) out.pos = new Set([names.indexOf(m[1]), names.indexOf(m[2])]);
    else if ((m = new RegExp('^犯人は(' + L + ')のだれか$').exec(seg))) out.pos = new Set(listOf(m[1], names));
    else if ((m = new RegExp('^(' + L + ')は犯人ではない(?:ので)?$').exec(seg))) listOf(m[1], names).forEach((p) => out.exc.add(p));
    else if ((m = new RegExp('^残る(' + NM + ')が犯人$').exec(seg))) out.pos = new Set([names.indexOf(m[1])]);
    else out.bad.push(seg);
  }
  return out;
}
// 理由の文（事実の主張）を、世界 (h, c) についての述語にする
function claimPred(R, names, N) {
  const { NM, L } = rx(names);
  const ix = (x) => names.indexOf(x);
  const V = (w) => w === '正直者';
  let m;
  const M = (re) => (m = new RegExp('^' + re + '$').exec(R));
  if (M('(' + NM + ')は(正直者|嘘つき)')) { const x = ix(m[1]), v = V(m[2]); return (h) => isH(h, x) === v; }
  if (M('(' + L + ')は(正直者|嘘つき)')) { const xs = listOf(m[1], names), v = V(m[2]); return (h) => xs.every((x) => isH(h, x) === v); }
  if (M('犯人は(' + NM + ')')) { const x = ix(m[1]); return (h, c) => c === x; }
  if (M('(' + NM + ')は犯人ではない')) { const x = ix(m[1]); return (h, c) => c !== x; }
  if (M('犯人の(' + NM + ')は(正直者|嘘つき)')) { const x = ix(m[1]), v = V(m[2]); return (h, c) => c === x && isH(h, x) === v; }
  if (M('全員が(正直者|嘘つき)で、犯人も(正直者|嘘つき)')) { const v = V(m[1]); return (h) => { for (let p = 0; p < N; p++) if (isH(h, p) !== v) return false; return true; }; }
  if (M('犯人の候補の(' + L + ')は(?:どちらも|\\d人とも)(正直者|嘘つき)')) { const xs = listOf(m[1], names), v = V(m[2]); return (h, c) => xs.includes(c) && xs.every((x) => isH(h, x) === v); }
  if (M('(' + NM + ')も(' + NM + ')も(正直者|嘘つき)')) { const x = ix(m[1]), y = ix(m[2]), v = V(m[3]); return (h) => isH(h, x) === v && isH(h, y) === v; }
  if (M('(' + NM + ')は(正直者|嘘つき)、(' + NM + ')は(正直者|嘘つき)')) { const x = ix(m[1]), y = ix(m[3]), v = V(m[2]), w = V(m[4]); return (h) => isH(h, x) === v && isH(h, y) === w; }
  if (M('犯人は(' + NM + ')か(' + NM + ')に絞られている')) { const x = ix(m[1]), y = ix(m[2]); return (h, c) => c === x || c === y; }
  if (M('(' + NM + ')も(' + NM + ')も犯人ではない')) { const x = ix(m[1]), y = ix(m[2]); return (h, c) => c !== x && c !== y; }
  if (M('正直者は1人もいない')) return (h) => h === 0;
  if (M('正直者は(' + NM + ')1人だけ')) { const x = ix(m[1]); return (h) => h === (1 << x); }
  if (M('正直者は(' + L + ')の(\\d)人')) { const xs = listOf(m[1], names); if (xs.length !== +m[2]) return null; const hm = xs.reduce((a, x) => a | (1 << x), 0); return (h) => h === hm; }
  if (M('正直者がすでに(' + L + ')の(\\d)人いる')) { const xs = listOf(m[1], names); if (xs.length !== +m[2]) return null; return (h) => xs.every((x) => isH(h, x)); }
  if (M('嘘つきがすでに(' + L + ')の(\\d)人いて、正直者は多くても(\\d)人')) { const xs = listOf(m[1], names); if (xs.length !== +m[2] || +m[3] !== N - xs.length) return null; return (h) => xs.every((x) => !isH(h, x)); }
  return null;
}
// 理由 R がその時点の事実（st, cand。または世界の一覧 FW）で本当で、しかも R だけで証言 S の真偽が want に決まるか
// cache（Map）を渡すと、同じ理由・証言・真偽の組の「R だけで決まるか」を使い回す
function checkClaim(R, S, want, st, cand, names, N, where, errs, FW, cache) {
  const f = claimPred(R, names, N);
  if (!f) { errs.push(where + ': 理由の文を読めない「' + R + '」'); return; }
  if (!(FW || factWorlds(N, st, cand)).every(([h, c]) => f(h, c))) errs.push(where + ': 理由の文がその時点の事実と合わない「' + R + '」');
  const key = R + '|' + S.speaker + '|' + want;
  let decides = cache ? cache.get(key) : undefined;
  if (decides === undefined) {
    const CW = allWorlds(N).filter(([h, c]) => f(h, c));
    decides = CW.length > 0 && CW.every(([h, c]) => truthIndep(S, h, c) === want);
    if (cache) cache.set(key, decides);
  }
  if (!decides) errs.push(where + ': 理由の文から証言の真偽が決まらない（または逆になる）「' + R + '」');
}
// 支えの文（「→」の前の「〜なので」）がその時点の事実と合うか
function checkSupport(sup, st, cand, speaker, names, N, where, errs) {
  const { NM, L } = rx(names);
  const ix = (x) => names.indexOf(x);
  const has = (p, v) => st[p] === v;
  const ng = () => errs.push(where + ': 支えの文がその時点の事実と合わない「' + sup + '」');
  let m;
  const M = (re) => (m = new RegExp('^' + re + '$').exec(sup));
  if (M('(' + L + ')は(正直者|嘘つき)なので')) { const v = SWv[m[2]]; if (!listOf(m[1], names).every((p) => has(p, v))) ng(); return; }
  if (M('(' + NM + ')自身も(正直者|嘘つき)なので')) { const v = SWv[m[2]]; if (!has(ix(m[1]), v) || ix(m[1]) !== speaker) ng(); return; }
  if (M('犯人は(' + NM + ')なので')) { if (!(cand.size === 1 && cand.has(ix(m[1])))) ng(); return; }
  if (M('(' + NM + ')は犯人ではないので')) { if (cand.has(ix(m[1]))) ng(); return; }
  if (M('正直者は(' + NM + ')1人だけなので')) { if (!has(ix(m[1]), 'H')) ng(); return; }
  if (M('正直者はもう(' + L + ')の(\\d)人がそろったので')) { const xs = listOf(m[1], names); if (xs.length !== +m[2] || !xs.every((p) => has(p, 'H'))) ng(); return; }
  if (M('正直者が(\\d)人なら、嘘つきは1人だけ。それは(' + NM + ')なので')) { if (N - +m[1] !== 1 || !has(ix(m[2]), 'L')) ng(); return; }
  if (M('正直者が(\\d)人なら、嘘つきは(\\d)人。もう(' + L + ')の(\\d)人がそろったので')) { const xs = listOf(m[3], names); if (N - +m[1] !== +m[2] || xs.length !== +m[2] || !xs.every((p) => has(p, 'L'))) ng(); return; }
  if (M('(' + NM + ')が(正直者|嘘つき)だと、正直者は(?:(' + NM + ')1人だけ|(' + L + ')の(\\d)人)になってしまうので')) {
    const x = ix(m[1]);
    const xs = m[3] ? [ix(m[3])] : listOf(m[4], names);
    const st2 = st.slice(); st2[x] = SWv[m[2]];
    const known = []; for (let p = 0; p < N; p++) if (st2[p] === 'H') known.push(p);
    if (!(xs.length === known.length && xs.every((p) => known.includes(p)))) ng();
    return;
  }
  errs.push(where + ': 支えの文を読めない「' + sup + '」');
}
// 結論の文（parseFacts の結果）と facts が同じか
function compareFacts(claim, facts, cand0, where, text, errs) {
  const H = new Set(), L = new Set();
  let c1 = null;
  for (const f of facts) { if (f.kind === 'status') (f.value === 'H' ? H : L).add(f.person); else c1 = new Set(f.cand); }
  if (claim.bad.length) { errs.push(where + ': 結論の文を読めない ' + JSON.stringify(claim.bad) + ' / ' + text); return; }
  if (!setEq(claim.H, H) || !setEq(claim.L, L)) errs.push(where + `: 結論の文（正直/嘘つき）が facts と違う 文H${fmtSet(claim.H)}L${fmtSet(claim.L)} factsH${fmtSet(H)}L${fmtSet(L)} / ` + text);
  if (c1) {
    const inferred = claim.pos ? claim.pos : new Set([...cand0].filter((x) => !claim.exc.has(x)));
    if (!setEq(inferred, c1)) errs.push(where + `: 結論の文（犯人の候補）が facts と違う 文から${fmtSet(inferred)} facts${fmtSet(c1)} / ` + text);
    for (const x of claim.exc) if (!cand0.has(x) || c1.has(x)) errs.push(where + ': 結論の文で「犯人ではない」とした人が不正 / ' + text);
  } else if (claim.pos || claim.exc.size) errs.push(where + ': 結論の文に犯人の話があるのに facts に無い / ' + text);
}
// 1つの直接の手（区分 G/A/B/C）の区分と文を確かめる。期待する区分を返す
function auditDirect(pz, step, st, cand, where, out, names) {
  const N = pz.people;
  const { NM } = rx(names);
  const T = out.text;
  const text = step.text;
  if (step.source === 'given') {
    if (step.cat !== 'G') out.cat.push(where + ': 村長のメモの手順なのに区分が G でない（' + step.cat + '）');
    const m = new RegExp('^村長のメモは必ず本当。→ (' + NM + ')は(正直者|嘘つき)$').exec(text);
    if (!m || !pz.given || names.indexOf(m[1]) !== pz.given.person || SWv[m[2]] !== pz.given.value) T.push(where + ': 村長のメモの手順の文が違う: ' + text);
    return 'G';
  }
  const S = pz.statements[step.source];
  if (!S) return null;   // 証言番号の不正は verifySteps が見る
  const FW = factWorlds(N, st, cand);
  const tv = new Set(FW.map(([h, c]) => truthIndep(S, h, c)));
  const exp = st[S.speaker] != null ? 'A' : tv.size === 1 ? 'B' : 'C';
  if (step.cat !== exp) out.cat.push(where + ': 区分が ' + step.cat + ' だが、条件からは ' + exp + '（話し手' + (st[S.speaker] != null ? 'は既知' : 'は未確定') + '・真偽の候補' + tv.size + '通り）');
  const quotes = [...text.matchAll(/『([^』]*)』/g)].map((x) => x[1]);
  if (!quotes.length || quotes.some((q) => q !== S.text)) T.push(where + ': 解説の引用が手順の証言と違う: ' + text);
  const k = text.lastIndexOf('→ ');
  const arrow = k >= 0 ? text.slice(k + 2) : '';
  if (exp === 'A') {
    const m = new RegExp('^(' + NM + ')は(正直者|嘘つき)なので、『[^』]*』は(本当|ウソ)。').exec(text);
    if (!m || names.indexOf(m[1]) !== S.speaker || SWv[m[2]] !== st[S.speaker] || (m[3] === '本当') !== (st[S.speaker] === 'H')) T.push(where + ': 区分A の書き出しが事実と違う: ' + text);
    else {
      let rest = text.slice(m[0].length, k);
      const mm = /^つまり、([^。]*)。/.exec(rest);
      if (mm) rest = rest.slice(mm[0].length);
      rest = rest.trim();
      if (rest) checkSupport(rest, st, cand, S.speaker, names, N, where, T);
    }
    compareFacts(parseFacts(arrow, names), step.facts, cand, where, text, T);
  } else if (exp === 'B') {
    const t = FW.length ? truthIndep(S, FW[0][0], FW[0][1]) : null;
    const m = new RegExp('^(?:(.*?)(?:なので|ので)|わかっていることから)、(' + NM + ')の『[^』]*』は(本当|ウソ)。→ ').exec(text);
    if (!m || names.indexOf(m[2]) !== S.speaker || (m[3] === '本当') !== t) T.push(where + ': 区分B の文の本当/ウソが違う: ' + text);
    else if (m[1] != null) checkClaim(m[1], S, t, st, cand, names, N, where + '（区分B の理由）', T);
    compareFacts(parseFacts(arrow, names), step.facts, cand, where, text, T);
  } else {
    const mDet = new RegExp('^(' + NM + ')が(正直者|嘘つき)だとすると、(?:(.*?)(?:なので|ので)、)?『[^』]*』が(本当|ウソ)になってしまい、合わない。だから、(' + NM + ')は(正直者|嘘つき)').exec(text);
    if (mDet) {
      const s = names.indexOf(mDet[1]), bad = SWv[mDet[2]], v = SWv[mDet[6]];
      if (s !== S.speaker || names.indexOf(mDet[5]) !== s || bad === v) T.push(where + ': 区分C（話し手が決まる）の文が不正: ' + text);
      const fsp = step.facts.find((f) => f.kind === 'status' && f.person === s);
      if (!fsp || fsp.value !== v) T.push(where + ': 区分C（話し手が決まる）の結論が facts と違う: ' + text);
      const wantTruth = mDet[4] === '本当';
      if ((bad === 'H') === wantTruth) T.push(where + ': 区分C の「合わない」の向きが逆: ' + text);
      const st1 = st.slice(); st1[s] = bad;
      if (mDet[3] != null) checkClaim(mDet[3], S, wantTruth, st1, cand, names, N, where + '（区分C の理由）', T);
      const rest = step.facts.filter((f) => !(f.kind === 'status' && f.person === s));
      if (rest.length) {
        const mt = new RegExp('\\n(' + NM + ')は(正直者|嘘つき)なので、『[^』]*』は(本当|ウソ)。(.*?)→ ').exec(text);
        if (!mt) T.push(where + ': 区分C の続きの文が無い: ' + text);
        else {
          if ((mt[3] === '本当') !== (v === 'H')) T.push(where + ': 区分C の続きの本当/ウソが違う: ' + text);
          const st2 = st.slice(); st2[s] = v;
          if (mt[4].trim()) checkSupport(mt[4].trim(), st2, cand, s, names, N, where + '（区分C の続き）', T);
          compareFacts(parseFacts(arrow, names), rest, cand, where, text, T);
        }
      } else if (k >= 0) T.push(where + ': 区分C の文に余計な結論: ' + text);
    } else if (text.indexOf('で分けて考える。\n') >= 0) {
      for (const ln of text.split('\n').slice(1, 3)) {
        const mb = /^・(正直者|嘘つき)なら(?:『[^』]*』は)?(本当|ウソ)で、(.*)。$/.exec(ln);
        if (!mb) { T.push(where + ': 区分C の場合分けの行を読めない: ' + ln); continue; }
        const v = SWv[mb[1]];
        if ((mb[2] === '本当') !== (v === 'H')) T.push(where + ': 区分C の場合分けの本当/ウソが違う: ' + ln);
        const st2 = st.slice(); st2[S.speaker] = v;
        const d2 = derive(N, factWorlds(N, st2, cand).filter(([h, c]) => consistentStmt(S, h, c)), st2, cand);
        const facts2 = [];
        d2.H.forEach((p) => facts2.push({ kind: 'status', person: p, value: 'H' }));
        d2.L.forEach((p) => facts2.push({ kind: 'status', person: p, value: 'L' }));
        if (d2.narrowed) facts2.push({ kind: 'culprit', cand: [...d2.C] });
        let claim = parseFacts(mb[3], names);
        if (claim.bad.length) {
          const ms = /^(.*?ので)、(.*)$/.exec(mb[3]);
          if (ms) { checkSupport(ms[1], st2, cand, S.speaker, names, N, where + '（場合分け）', T); claim = parseFacts(ms[2], names); }
        }
        compareFacts(claim, facts2, cand, where + '（場合分け ' + v + '）', ln, T);
      }
      compareFacts(parseFacts(arrow, names), step.facts, cand, where, text, T);
    } else if (new RegExp('^(' + NM + ')は『[^』]*』と言っている。').test(text) || text.indexOf('どちらの場合でも → ') >= 0) {
      compareFacts(parseFacts(arrow, names), step.facts, cand, where, text, T);
    } else T.push(where + ': 区分C の文を読めない: ' + text);
  }
  return exp;
}
// 仮定を置く前に、1つの証言（または村長のメモ）と事実だけで決まる手が残っていないか
function auditExhausted(pz, st, cand, where, out) {
  const N = pz.people;
  const FW = factWorlds(N, st, cand);
  if (pz.given && st[pz.given.person] == null) out.exhaust.push(where + ': 仮定の前に、村長のメモがまだ使われていない');
  pz.statements.forEach((S, i) => {
    const W = FW.filter(([h, c]) => consistentStmt(S, h, c));
    if (!W.length) { out.exhaust.push(where + ': 仮定の前にすでに証言' + (i + 1) + 'と矛盾'); return; }
    const d = derive(N, W, st, cand);
    if (d.H.size || d.L.size) out.exhaust.push(where + ': 仮定の前に、証言' + (i + 1) + '（' + S.type + '）と事実だけで決まる人が残っている（★の水増し）');
    else if (d.narrowed && !(S.type === 'CULPRIT_LIAR' && st[S.speaker] == null)) out.exhaust.push(where + ': 仮定の前に、証言' + (i + 1) + '（' + S.type + '）で犯人の候補を直接しぼれる');
  });
}
function auditSteps(pz) {
  const N = pz.people, names = pz.villagers.map((v) => v.name);
  const { NM } = rx(names);
  const out = { cat: [], text: [], exhaust: [], back: 0, used: new Set() };
  if (!Array.isArray(pz.steps)) return out;
  const st = Array(N).fill(null);
  let cand = new Set(Array.from({ length: N }, (_, i) => i));
  const T = out.text;
  pz.steps.forEach((step, si) => {
    const where = '手順' + (si + 1);
    if (step.kind === 'direct') {
      const exp = auditDirect(pz, step, st, cand, where, out, names);
      if (exp === 'B') out.back++;
      if (step.source !== 'given') out.used.add(step.source);
      cand = applyFacts(step, st, cand);
      return;
    }
    if (step.kind !== 'hypo' || !step.assume || !Array.isArray(step.sub)) return;   // 形の不正は verifySteps が見る
    auditExhausted(pz, st, cand, where, out);
    const a = step.assume;
    const st2 = st.slice();
    let c2 = new Set(cand);
    if (a.kind === 'status') {
      st2[a.person] = a.value;
      const m = new RegExp('^もし(' + NM + ')が(正直者|嘘つき)だとすると……$').exec(step.text);
      if (!m || names.indexOf(m[1]) !== a.person || SWv[m[2]] !== a.value) T.push(where + ': 仮定の見出しが仮定（assume）と違う: ' + step.text);
      const mc = new RegExp('^だから、(' + NM + ')は(正直者|嘘つき)$').exec(step.conclusion || '');
      if (!mc || names.indexOf(mc[1]) !== a.person || SWv[mc[2]] === a.value) T.push(where + ': 仮定の結論の文が仮定の否定になっていない: ' + step.conclusion);
    } else {
      c2 = new Set([a.person]);
      const m = new RegExp('^もし犯人が(' + NM + ')だとすると……$').exec(step.text);
      if (!m || names.indexOf(m[1]) !== a.person) T.push(where + ': 仮定の見出しが仮定（assume）と違う: ' + step.text);
      const left = [...cand].filter((x) => x !== a.person);
      const mc = new RegExp('^だから、(' + NM + ')は犯人ではない(?:。残る(' + NM + ')が犯人)?$').exec(step.conclusion || '');
      if (!mc || names.indexOf(mc[1]) !== a.person || (left.length === 1) !== !!mc[2] || (mc[2] && names.indexOf(mc[2]) !== left[0])) T.push(where + ': 仮定の結論の文が違う: ' + step.conclusion);
    }
    step.sub.forEach((sub, j) => {
      if (sub.kind !== 'direct') return;
      auditDirect(pz, sub, st2, c2, where + '-' + (j + 1), out, names);
      if (sub.source !== 'given') out.used.add(sub.source);
      c2 = applyFacts(sub, st2, c2);
    });
    const CS = pz.statements[step.contraSource];
    if (CS) {
      out.used.add(step.contraSource);
      const ct = step.contradiction || '';
      const q = [...ct.matchAll(/『([^』]*)』/g)].map((x) => x[1]);
      if (!q.length || q.some((x) => x !== CS.text)) T.push(where + ': 矛盾の文の引用が矛盾の証言と違う: ' + ct);
      let m;
      if ((m = new RegExp('^ところが、(' + NM + ')は(正直者|嘘つき)なので『[^』]*』は(本当|ウソ)のはず。でも(.*?)(?:なので|ので)、(ウソ|本当)になってしまう。$').exec(ct))) {
        const s = names.indexOf(m[1]);
        if (s !== CS.speaker || st2[s] !== SWv[m[2]] || (m[3] === '本当') !== (SWv[m[2]] === 'H') || m[3] === m[5]) T.push(where + ': 矛盾の文（話し手が既知）が事実と違う: ' + ct);
        checkClaim(m[4], CS, m[5] === '本当', st2, c2, names, N, where + '（矛盾の理由）', T);
      } else if ((m = new RegExp('^ところが、犯人が(' + NM + ')なら、(' + NM + ')の『[^』]*』は「わたしは嘘つきだ」と言っているのと同じ。').exec(ct))) {
        const s = names.indexOf(m[1]);
        if (CS.type !== 'CULPRIT_LIAR' || s !== CS.speaker || names.indexOf(m[2]) !== s || !(c2.size === 1 && c2.has(s)) || st2[s] != null) T.push(where + ': 自己言及の矛盾の文が不正: ' + ct);
      } else if ((m = new RegExp('^ところが、(' + NM + ')が正直者だと(?:(.*?)(?:なので|ので)、)?『[^』]*』はウソ。嘘つきだと(?:(.*?)(?:なので|ので)、)?本当になってしまう。どちらでも合わない。$').exec(ct))) {
        const s = names.indexOf(m[1]);
        if (s !== CS.speaker || st2[s] != null) T.push(where + ': 矛盾の文（話し手が未確定）が不正: ' + ct);
        const sH = st2.slice(); sH[s] = 'H';
        const sL = st2.slice(); sL[s] = 'L';
        if (m[2] != null) checkClaim(m[2], CS, false, sH, c2, names, N, where + '（矛盾の理由・正直者のとき）', T);
        if (m[3] != null) checkClaim(m[3], CS, true, sL, c2, names, N, where + '（矛盾の理由・嘘つきのとき）', T);
      } else T.push(where + ': 矛盾の文を読めない: ' + ct);
    }
    cand = applyFacts(step, st, cand);
  });
  return out;
}

/* ---------- check() の答え合わせの文 ---------- */
// 誤答 (h, c) の check() の結果を確かめる。返すのは { real: 矛盾が本物か, cul: 犯人の書き方, msg: 文の中身 } のエラー文（空なら OK）
function auditCheck(pz, status, h, c, r, cache) {
  const N = pz.people, names = pz.villagers.map((v) => v.name);
  const e = { real: '', cul: '', msg: '' };
  const ans = JSON.stringify({ status: status.join(''), culprit: c });
  if (!r || r.ok !== false || !r.contradiction || typeof r.contradiction.message !== 'string' || !r.contradiction.message || BAD.test(r.contradiction.message)) {
    e.real = ans + ' → ' + JSON.stringify(r); return e;
  }
  const cd = r.contradiction;
  const givenBad = pz.given && status[pz.given.person] !== pz.given.value;
  if (givenBad) {
    if (cd.kind !== 'given') { e.real = ans + ' メモと食い違うのに given でない: ' + JSON.stringify(cd); return e; }
    const p = pz.given.person;
    const exp = 'あなたの推理では、' + names[p] + 'は' + (status[p] === 'H' ? '正直者' : '嘘つき') + '。でも村長のメモには「' + names[p] + 'は' + (pz.given.value === 'H' ? '正直者' : '嘘つき') + 'だ」とある。';
    if (cd.message !== exp) e.msg = ans + ' メモの食い違いの文: ' + cd.message;
    return e;
  }
  if (cd.kind !== 'statement') { e.real = ans + ' kind が不正: ' + JSON.stringify(cd); return e; }
  const first = pz.statements.findIndex((S) => !consistentStmt(S, h, c));
  const S = pz.statements[cd.index];
  if (cd.index !== first || !S || cd.speaker !== S.speaker || !cd.message.includes(names[S.speaker])) { e.real = ans + ` index=${cd.index} 最初の食い違い=${first} ` + cd.message; return e; }
  const { NM } = rx(names);
  const m = new RegExp('^あなたの推理では、(' + NM + ')は(正直者|嘘つき)(?:で、犯人は(' + NM + '))?。でもその場合、(?:(.*?)(?:なので|ので)、)?(' + NM + ')の『([^』]*)』は(本当|ウソ)になってしまう。$').exec(cd.message);
  const t = truthIndep(S, h, c);
  if (CULPRIT_TYPES[S.type] && !cd.message.includes('犯人は' + names[c] + '。')) e.cul = ans + ' ' + cd.message;
  if (!m) { e.msg = ans + ' 文を読めない: ' + cd.message; return e; }
  const errs = [];
  if (names.indexOf(m[1]) !== S.speaker || SWv[m[2]] !== status[S.speaker]) errs.push('書き出しの話し手・正直者/嘘つきが答えと違う');
  if (names.indexOf(m[5]) !== S.speaker || m[6] !== S.text) errs.push('引用が食い違う証言と違う');
  if ((m[7] === '本当') !== t) errs.push('本当/ウソの向きが逆');
  if (!!CULPRIT_TYPES[S.type] !== !!m[3] || (m[3] && names.indexOf(m[3]) !== c)) errs.push('犯人の書き方');
  if (m[4] == null) errs.push('理由（〜なので）が無い');
  else checkClaim(m[4], S, t, null, null, names, N, '理由', errs, [[h, c]], cache);
  if (errs.length) e.msg = ans + ' ' + errs.join('・') + ': ' + cd.message;
  return e;
}
// 試す誤答の一覧（[h, c]）。full なら全部、そうでなければ正解の近く（判定を1〜2人変える・犯人だけ変える）とでたらめな答え
function wrongAnswers(pz, full) {
  const N = pz.people, sol = pz.solution;
  let hs = 0; sol.status.forEach((v, i) => { if (v === 'H') hs |= 1 << i; });
  const isSol = (h, c) => h === hs && c === sol.culprit;
  if (full) return allWorlds(N).filter(([h, c]) => !isSol(h, c));
  const out = [], seen = new Set();
  const add = (h, c) => { const k = h * 16 + c; if (!isSol(h, c) && !seen.has(k)) { seen.add(k); out.push([h, c]); } };
  for (let c = 0; c < N; c++) add(hs, c);
  for (let i = 0; i < N; i++) {
    add(hs ^ (1 << i), sol.culprit);
    add(hs ^ (1 << i), rint(N));
    for (let j = i + 1; j < N; j++) add(hs ^ (1 << i) ^ (1 << j), sol.culprit);
  }
  for (let t = 0; t < 30; t++) add(rint(1 << N), rint(N));
  return out;
}

/* ---------- 1問ぶんの検査 ---------- */
let rngState = 12345;
const rnd = () => { rngState = (Math.imul(rngState, 1103515245) + 12345) >>> 0; return rngState / 4294967296; };
const rint = (n) => Math.floor(rnd() * n);

// opts.fullCheck: check() にありうる誤答を全部渡す（5人以下は常に全部）
function inspect(pz, tag, targetStar, people, opts) {
  opts = opts || {};
  const N = pz.people;
  record('人数と★の設定', N === people && pz.targetStar === targetStar && [1, 2, 3].includes(pz.star), tag + ` N=${N} target=${pz.targetStar} star=${pz.star}`);
  record('JSON化できる', !hasUndefined(pz) && JSON.stringify(JSON.parse(JSON.stringify(pz))) === JSON.stringify(pz), tag);
  record('村人の情報', pz.villagers.length === N && new Set(pz.villagers.map((v) => v.name)).size === N &&
    pz.villagers.every((v) => v.name && v.job && Number.isInteger(v.avatar) && v.avatar >= 0 && v.avatar <= 15 && Number.isInteger(v.color) && v.color >= 0 && v.color <= 7) &&
    new Set(pz.villagers.map((v) => v.avatar)).size === N, tag);
  record('1人1証言', pz.statements.length === N, tag);
  record('証言の種類が★に合う', pz.statements.every((S) => stmtAllowed(S, targetStar, N)), tag + ' ' + JSON.stringify(pz.statements.map((s) => [s.type, s.speaker, s.a, s.b, s.k])));
  record('「わたしとXは同じ側/違う側」は1問に1つまで',
    pz.statements.filter((S) => (S.type === 'SAME' || S.type === 'DIFF') && (S.a === S.speaker || S.b === S.speaker)).length <= 1, tag);
  const liars = pz.solution.status.filter((v) => v === 'L').length;
  record('嘘つきは1〜N-1人', liars >= 1 && liars <= N - 1, tag + ' liars=' + liars);
  let hsol = 0;
  pz.solution.status.forEach((v, i) => { if (v === 'H') hsol |= 1 << i; });
  const sols = bruteSolutions(pz);
  record('解が一意（総当たり）', sols.length === 1, tag + ' 解の数=' + sols.length);
  record('正解が全証言・手がかりと整合', sols.some(([h, c]) => h === hsol && c === pz.solution.culprit) &&
    pz.statements.every((S) => consistentStmt(S, hsol, pz.solution.culprit)), tag);
  const v = verifySteps(pz);
  record('解説の検算（直接/仮定/最終）', v.errs.length === 0, tag + ' ' + v.errs.slice(0, 3).join(' / '));
  record('★の実測が解説と一致', starFrom(v.hyps, v.chain) === pz.star && pz.stats.hyps === v.hyps && pz.stats.chain === v.chain &&
    (pz.stats.sum == null || pz.stats.sum === v.sum), tag + ` hyps=${v.hyps} chain=${v.chain} sum=${v.sum} star=${pz.star}`);
  const unused = N - v.used.size;
  record('解説に使われない証言は1つまで', unused <= 1 && pz.stats.used === v.used.size, tag + ' unused=' + unused);
  const te = textsOk(pz);
  record('文章に機械的な文字列が無い・人名が正しい', te.length === 0, tag + ' ' + te.slice(0, 3).join(' / '));
  // 解説の文・区分・★の水増し・stats
  const a = auditSteps(pz);
  record('解説の文が中身と合う（→の後・理由・支え・矛盾・仮定の見出しと結論）', a.text.length === 0, tag + ' ' + a.text.slice(0, 2).join(' / '));
  record('解説の区分（A/B/C）が条件に合う', a.cat.length === 0, tag + ' ' + a.cat.slice(0, 2).join(' / '));
  record('仮定の前に直接の手が残っていない（★の水増しが無い）', a.exhaust.length === 0, tag + ' ' + a.exhaust.slice(0, 2).join(' / '));
  const unusedList = Array.from({ length: N }, (_, i) => i).filter((i) => !a.used.has(i));
  record('stats.back・stats.unused が解説と同じ', pz.stats.back === a.back && JSON.stringify(pz.stats.unused) === JSON.stringify(unusedList),
    tag + ` back=${pz.stats.back}（数えると${a.back}） unused=${JSON.stringify(pz.stats.unused)}（数えると${JSON.stringify(unusedList)}）`);

  // check(): 正解
  const ok = E.check(pz, { status: pz.solution.status.slice(), culprit: pz.solution.culprit });
  record('check: 正解で ok', ok && ok.ok === true, tag);
  // check(): 誤答（5人以下と opts.fullCheck はありうる答えを全部。ほかは正解の近くとでたらめな答え）
  const ce = { real: [], cul: [], msg: [] };
  const claimCache = new Map();
  let tried = 0;
  for (const [h, c] of wrongAnswers(pz, N <= 5 || !!opts.fullCheck)) {
    const status = Array.from({ length: N }, (_, p) => (isH(h, p) ? 'H' : 'L'));
    let r;
    try { r = E.check(pz, { status, culprit: c }); } catch (e) { ce.real.push('例外 ' + e.message); continue; }
    tried++;
    const e = auditCheck(pz, status, h, c, r, claimCache);
    for (const k of ['real', 'cul', 'msg']) if (e[k]) ce[k].push(e[k]);
  }
  record('check: 誤答の矛盾が本物', ce.real.length === 0, tag + ` ${ce.real.length}/${tried}件 ` + ce.real.slice(0, 2).join(' / '));
  record('check: 犯人についての食い違いは選んだ犯人も書く', ce.cul.length === 0, tag + ' ' + ce.cul.slice(0, 2).join(' / '));
  record('check: 食い違いの文が中身と合う（書き出し・引用・本当/ウソの向き・理由）', ce.msg.length === 0, tag + ` ${ce.msg.length}/${tried}件 ` + ce.msg.slice(0, 2).join(' / '));
  let inc;
  try { inc = E.check(pz, { status: Array(N).fill(null), culprit: null }); } catch (e) { inc = null; }
  record('check: 未完成の答えでも例外を出さない', inc && inc.ok === false, tag);
  record('check: 未完成の答えにもメッセージを返す', !!inc && typeof inc.message === 'string' && inc.message.length > 0 && !BAD.test(inc.message), tag);

  // hint()
  const states = [];
  states.push({ status: Array(N).fill(null), culprit: null });
  states.push({ status: pz.solution.status.slice(), culprit: pz.solution.culprit });
  for (let t = 0; t < 3; t++) {
    states.push({
      status: Array.from({ length: N }, (_, i) => { const x = rnd(); return x < 0.4 ? null : x < 0.8 ? pz.solution.status[i] : (pz.solution.status[i] === 'H' ? 'L' : 'H'); }),
      culprit: rnd() < 0.5 ? null : rint(N),
    });
  }
  for (const s of states) for (const lv of [1, 2]) {
    let r, err = '';
    try { r = E.hint(pz, s, lv); } catch (e) { err = e.message; }
    record('hint: 例外なく文字列を返す', !err && r && typeof r.text === 'string' && r.text.trim().length > 0 && !BAD.test(r.text) &&
      Array.isArray(r.focus) && r.focus.every((x) => Number.isInteger(x) && x >= 0 && x < N), tag + ' ' + (err || JSON.stringify(r)));
  }
  // 範囲外・型違いの犯人や判定を渡しても、focus は必ず実在する人
  for (const c of [-1, N, 1.5, '0', NaN, Infinity]) {
    let r, err = '';
    try { r = E.hint(pz, { status: pz.solution.status.map((x, i) => (i % 2 ? x : 'X')), culprit: c }, 1); } catch (e) { err = e.message; }
    record('hint: 範囲外の入力でも focus が正しい', !err && r && Array.isArray(r.focus) && r.focus.every((x) => Number.isInteger(x) && x >= 0 && x < N), tag + ' culprit=' + c + ' ' + (err || JSON.stringify(r)));
  }
  hintJudge(pz, tag);
  hintProgress(pz, tag);
  // 最初に決まる項目を間違えて印をつけたら「見直し」を促す
  const first = pz.steps[0].facts.find((f) => f.kind === 'status');
  if (first) {
    const s = { status: Array(N).fill(null), culprit: null };
    s.status[first.person] = first.value === 'H' ? 'L' : 'H';
    const r = E.hint(pz, s, 1);
    record('hint: 間違った印の見直しを促す', r && r.text.includes('見直') && r.text.includes(pz.villagers[first.person].name), tag + ' ' + (r && r.text));
  }
  return { v, a };
}

/* hint() の「見直してみよう」「全員そろった」の判定が正しいか。
 * ・done（全員そろった）なら、判子も犯人も正解と同じ。逆に、全部正解なら必ず done
 * ・review（見直し）なら、指した人の判子が正解と違う（「犯人の選び方」なら犯人が正解と違う）
 * ・1段目は、まだ正しく付いていない人の正直/嘘つきや犯人を言わない
 * ランダムな判子・「判定は全部正しく犯人だけ違う」・「2番目以降の手順の人だけ逆」・極端な入力、level 1/2/0/3/'2' で試す */
const HINT_KINDS = ['review', 'done', 'given', 'direct', 'hypo'];
function hintJudge(pz, tag) {
  const N = pz.people, sol = pz.solution, names = pz.villagers.map((v) => v.name);
  const NA = names.slice().sort((x, y) => y.length - x.length).join('|');
  const states = [];
  for (let t = 0; t < 6; t++) {
    const pr = rnd();
    states.push({
      status: Array.from({ length: N }, (_, i) => { const x = rnd(); return x < pr ? null : x < pr + (1 - pr) * 0.8 ? sol.status[i] : (sol.status[i] === 'H' ? 'L' : 'H'); }),
      culprit: rnd() < 0.4 ? null : rnd() < 0.6 ? sol.culprit : rint(N),
      seen: rnd() < 0.3 ? [rint(pz.steps.length)] : undefined,
    });
  }
  states.push({ status: sol.status.slice(), culprit: (sol.culprit + 1) % N });   // 判定は全部正しく、犯人だけ違う
  states.push({ status: sol.status.slice(), culprit: null });
  // 2番目以降の手順で決まる人だけを逆に付ける（ほかは全部正しい）
  let flips = 0;
  for (let j = 1; j < pz.steps.length && flips < 2; j++) {
    const f = pz.steps[j].facts.find((x) => x.kind === 'status');
    if (!f) continue;
    const s = { status: sol.status.slice(), culprit: sol.culprit };
    s.status[f.person] = f.value === 'H' ? 'L' : 'H';
    states.push(s); flips++;
  }
  const junk = [null, undefined, {}, { status: 'H'.repeat(N) }, { status: Array(N + 3).fill('H') }, { status: [1, 0, true, 'h'] },
    { status: Array(N).fill('H'), culprit: '0' }, { status: Array(N).fill('L'), culprit: -0 }, { status: Array(N).fill(null), culprit: 2 ** 40 },
    { status: Array(N).fill(null), seen: [-1, 999, '0', null, NaN] }, { status: sol.status.slice(), culprit: sol.culprit, seen: 'x' }, { status: new Array(N), culprit: null }];
  const errs = { shape: [], judge: [], leak: [] };
  const run = (s, lv, judge) => {
    let r;
    try { r = E.hint(pz, s, lv); } catch (e) { errs.shape.push('例外 ' + e.message + ' ' + JSON.stringify(s)); return; }
    if (!r || typeof r.text !== 'string' || !r.text.trim() || BAD.test(r.text) || !Array.isArray(r.focus) || !r.focus.every((x) => Number.isInteger(x) && x >= 0 && x < N) ||
      !HINT_KINDS.includes(r.kind) || !Array.isArray(r.steps) || !r.steps.every((j) => Number.isInteger(j) && j >= 0 && j < pz.steps.length)) {
      errs.shape.push('level=' + JSON.stringify(lv) + ' ' + JSON.stringify(s) + ' → ' + JSON.stringify(r)); return;
    }
    if (!judge || !s || !Array.isArray(s.status)) return;
    const marks = Array.from({ length: N }, (_, i) => (s.status[i] === 'H' || s.status[i] === 'L' ? s.status[i] : null));
    const cul = Number.isInteger(s.culprit) && s.culprit >= 0 && s.culprit < N ? s.culprit : null;
    const allRight = marks.every((m, i) => m === sol.status[i]) && cul === sol.culprit;
    const st = JSON.stringify({ marks: marks.map((m) => m || '-').join(''), culprit: cul }) + ' 正解 ' + sol.status.join('') + '/' + sol.culprit;
    if (r.kind === 'done' && !allRight) errs.judge.push('「そろった」なのに答えが違う ' + st);
    if (allRight && r.kind !== 'done') errs.judge.push('全部正しいのに「そろった」にならない（' + r.kind + '） ' + st);
    if (r.kind === 'review') {
      if (/犯人の選び方/.test(r.text)) { if (cul === sol.culprit || r.focus[0] !== cul) errs.judge.push('正しい犯人を見直せと言う ' + st); }
      else if (marks[r.focus[0]] === sol.status[r.focus[0]] || !r.text.includes(names[r.focus[0]])) errs.judge.push('正しい判定を見直せと言う: ' + r.text + ' ' + st);
    }
    if (lv !== 2 && r.kind !== 'review' && r.kind !== 'done') {
      // 1段目は答えを言わない（「Xを正直者か嘘つきのどちらかに」「Xが正直者の場合と嘘つきの場合」は答えではない）
      const t = r.text.replace(new RegExp('(' + NA + ')を正直者か嘘つきのどちらかに', 'g'), '').replace(new RegExp('(' + NA + ')が正直者の場合と嘘つきの場合', 'g'), '');
      for (let p = 0; p < N; p++) {
        if (marks[p] === sol.status[p]) continue;
        if (new RegExp(names[p] + '(は|が|も)(正直者|嘘つき)').test(t)) { errs.leak.push(names[p] + 'の判定: ' + r.text); break; }
      }
      if (cul !== sol.culprit && new RegExp('犯人(は|が)(' + NA + ')|(' + NA + ')(自身)?が犯人|(' + NA + ')は犯人(では|じゃ)ない').test(t)) errs.leak.push('犯人: ' + r.text);
    }
  };
  states.forEach((s, i) => { for (const lv of (i < 3 ? [1, 2, 0, 3, '2'] : [1, 2])) run(s, lv, true); });
  for (const s of junk) for (const lv of [1, 2, 0, undefined]) run(s, lv, true);
  record('hint: 極端な入力・level 0/3/\'2\' でも形が正しい', errs.shape.length === 0, tag + ' ' + errs.shape.slice(0, 2).join(' / '));
  record('hint: 「見直し」「そろった」の判定が正しい', errs.judge.length === 0, tag + ' ' + errs.judge.slice(0, 2).join(' / '));
  record('hint: 1段目は答えを言わない（ランダムな判子）', errs.leak.length === 0, tag + ' ' + errs.leak.slice(0, 2).join(' / '));
}

/* 解説の順に印を付けていくプレイヤー（犯人は1人に決まったときだけ選ぶ）を真似て、ヒントが先へ進むか確かめる。
 * ・2段目は「まだ印の付いていない最初の手順」を必ず含む（絞り込みだけの手順で止まらない）
 * ・1段目は、まだ正しく印の付いていない人の正直/嘘つきや犯人を言わない
 * ・2段目で見せた絞り込みを seen で渡すと、その手順は飛ばす */
function hintProgress(pz, tag) {
  const N = pz.people;
  const names = pz.villagers.map((v) => v.name);
  const NA = names.slice().sort((x, y) => y.length - x.length).join('|');
  const status = Array(N).fill(null);
  let cul = null;
  for (let j = 0; j <= pz.steps.length; j++) {
    let target = -1;
    for (let k = 0; k < pz.steps.length && target < 0; k++) {
      for (const f of pz.steps[k].facts) {
        if (f.kind === 'status' ? status[f.person] == null : (cul == null && f.cand.length === 1)) { target = k; break; }
      }
    }
    const state = { status: status.slice(), culprit: cul };
    let h1, h2, err = '';
    try { h1 = E.hint(pz, state, 1); h2 = E.hint(pz, state, 2); } catch (e) { err = e.message; }
    if (err || !h1 || !h2) { record('hint: 次の手順へ進む（止まらない）', false, tag + ' 例外 ' + err); return; }
    if (target < 0) {
      record('hint: 全部そろったら提出をうながす', /提出/.test(h1.text) && /提出/.test(h2.text), tag + ' ' + h1.text);
    } else {
      const T = pz.steps[target];
      record('hint: 次の手順へ進む（止まらない）', h2.text.includes(T.text) && (!Array.isArray(h2.steps) || h2.steps.indexOf(target) >= 0) &&
        (!Array.isArray(h1.steps) || h1.steps.indexOf(target) >= 0), tag + ` 手順${j + 1}まで印あり・次は手順${target + 1}: ${T.text.slice(0, 40)} / ヒント: ${h2.text.slice(0, 60)}`);
      let leak = '';
      // 「Xを正直者か嘘つきのどちらかに」「Xが正直者の場合と嘘つきの場合」は答えではないので除いてから、「Xは/が/も正直者・嘘つき」を探す
      const t1 = h1.text.replace(new RegExp('(' + NA + ')を正直者か嘘つきのどちらかに', 'g'), '').replace(new RegExp('(' + NA + ')が正直者の場合と嘘つきの場合', 'g'), '');
      for (let p = 0; p < N && !leak; p++) {
        if (status[p] === pz.solution.status[p]) continue;
        if (new RegExp(names[p] + '(は|が|も)(正直者|嘘つき)').test(t1)) leak = names[p] + 'の判定';
      }
      if (!leak && cul == null && new RegExp('犯人(は|が)(' + NA + ')|(' + NA + ')(自身)?が犯人|(' + NA + ')は犯人(では|じゃ)ない').test(t1)) leak = '犯人';
      record('hint: 1段目は答えを言わない', !leak, tag + ' ' + leak + ': ' + h1.text);
      if (Array.isArray(h2.steps) && h2.steps.length > 1) {
        const h3 = E.hint(pz, Object.assign({}, state, { seen: h2.steps.filter((x) => x !== target) }), 2);
        record('hint: 見せた絞り込みは seen で飛ばす', Array.isArray(h3.steps) && h3.steps.length === 1 && h3.steps[0] === target, tag + ' ' + JSON.stringify(h3.steps));
      }
    }
    if (j < pz.steps.length) {
      for (const f of pz.steps[j].facts) {
        if (f.kind === 'status') status[f.person] = f.value;
        else if (f.cand.length === 1) cul = f.cand[0];
      }
    }
  }
}

/* ---------- 生成時間 ---------- */
// 遅かった生成は、負荷による誤判定を避けるため、新しいエンジン（1問作って温めたもの）で3回測り直して一番短い値を使う
const SLOW = 150;
function remeasure(run) {
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const F = fresh();
    F.generate({ seed: 'warm-up', people: 6, star: 2 });
    const a = performance.now();
    run(F);
    best = Math.min(best, performance.now() - a);
  }
  return best;
}
const timed = (d, run) => (d > SLOW ? Math.min(d, remeasure(run)) : d);

/* ---------- 本体 ---------- */
const t0 = Date.now();
console.log('検査対象: ' + target);
console.log(`3〜6人: 各★×人数 ${COUNT}問、日替わり ${DAYS}日分 / 7〜9人: 各${COUNT_HARD}問 / 事件の割り当て ${STORY_DAYS}日分\n`);

const times = [];
const table = [];
for (const star of [1, 2, 3]) {
  for (const N of [3, 4, 5, 6]) {
    const dist = { 1: 0, 2: 0, 3: 0 };
    const tt = [];
    let unused1 = 0;
    for (let i = 0; i < COUNT; i++) {
      const seed = 100000 * star + 1000 * N + i;
      const tag = `[★${star} ${N}人 seed=${seed}]`;
      let pz;
      const a = performance.now();
      try { pz = E.generate({ seed, people: N, star }); } catch (e) { record('生成できる', false, tag + ' ' + e.message); continue; }
      const d = timed(performance.now() - a, (F) => F.generate({ seed, people: N, star }));
      tt.push(d); times.push(d);
      record('生成できる', !!pz, tag);
      dist[pz.star]++;
      const { v, a: au } = inspect(pz, tag, star, N);
      if (N - au.used.size > 0) unused1++;
      if (star === 3 && pz.star === 3) {
        record('★3 の難しさの幅（仮定3回以下・仮定の合計5手以上か連鎖5以上）', v.hyps <= 3 && (v.chain >= 5 || v.sum >= 5), tag + ` hyps=${v.hyps} chain=${v.chain} sum=${v.sum}`);
      }
      if (i < 25) {
        const again = E2.generate({ seed, people: N, star });
        record('同じseedで同じ問題（別インスタンス）', JSON.stringify(again) === JSON.stringify(pz), tag);
        const sv = E.solve(pz);
        record('solve() が保存済みの解説と一致', sv.solved === true && sv.stars === pz.star && JSON.stringify(sv.steps) === JSON.stringify(pz.steps), tag);
      }
    }
    const avg = tt.reduce((x, y) => x + y, 0) / Math.max(1, tt.length);
    table.push({ star, N, dist, avg, max: Math.max(...tt), match: dist[star] / Math.max(1, tt.length), unused1 });
  }
}

// 日替わり
const WEEK = { 0: [3, 6], 1: [1, 4], 2: [1, 5], 3: [2, 4], 4: [2, 5], 5: [2, 6], 6: [3, 5] };
const dTimes = [];
let dMatch = 0;
const dDist = { 1: 0, 2: 0, 3: 0 };
const dByStar = { 1: [0, 0], 2: [0, 0], 3: [0, 0] };
const start = Date.UTC(2026, 9, 1);
const dayStr = (i) => new Date(start + i * 86400000).toISOString().slice(0, 10);
// 曜日ごとの難しさの幅（同じ★の中で、月→日の順に難しくなるように）
const WBAND = {
  0: ['日: 仮定3回以下・合計7手以上か連鎖5以上', (m) => m.hyps <= 3 && (m.sum >= 7 || m.chain >= 5)],
  2: ['火: 逆向きの推理が3回以上', (m) => m.back >= 3],
  3: ['水: 連鎖3以下・村長のメモあり', (m) => m.chain <= 3 && m.given],
  4: ['木: 連鎖3', (m) => m.chain === 3],
  5: ['金: 連鎖3〜4', (m) => m.chain >= 3 && m.chain <= 4],
  6: ['土: 仮定2回・合計5〜6手', (m) => m.hyps === 2 && m.sum >= 5 && m.sum <= 6],
};
const storyLast = {};
const tagLast = {};
const ST = (E._internal && E._internal.STORIES) || [];
const storyTags = (so) => (so ? [so.job ? 'job:' + so.job : null, so.g ? 'g:' + so.g : null].filter(Boolean) : []);
for (let i = 0; i < DAYS; i++) {
  const dt = new Date(start + i * 86400000);
  const ds = dayStr(i);
  const wd = dt.getUTCDay();
  const tag = `[日替わり ${ds}]`;
  let cfg, pz;
  try { cfg = E.dailyConfig(ds); } catch (e) { record('日替わり: 設定', false, tag + ' ' + e.message); continue; }
  const [wStar, wN] = WEEK[wd];
  record('日替わり: 設定（No.・曜日・人数・★・seed）', cfg.no === i + 1 && cfg.weekday === wd && cfg.people === wN && cfg.star === wStar && Number.isInteger(cfg.seed), tag + ' ' + JSON.stringify(cfg));
  const a = performance.now();
  try { pz = E.daily(ds); } catch (e) { record('日替わり: 生成できる', false, tag + ' ' + e.message); continue; }
  const d = timed(performance.now() - a, (F) => { F.dailyConfig(ds); F.daily(ds); });
  dTimes.push(d); times.push(d);
  record('日替わり: 生成できる', !!pz && pz.no === i + 1 && pz.date === ds && pz.seed === cfg.seed, tag);
  const { v, a: au } = inspect(pz, tag, wStar, wN);
  {
    // 逆向きの推理（区分B）の数は、エンジンの step.cat ではなく、区分の条件から数え直したもの
    const m = { hyps: v.hyps, chain: v.chain, sum: v.sum, back: au.back, given: !!pz.given };
    if (WBAND[wd]) record('日替わり: 曜日ごとの難しさの幅', pz.star === wStar && WBAND[wd][1](m), tag + ' ' + WBAND[wd][0] + ' ' + JSON.stringify(m));
    // 事件: 題名の軽い取得・近い日に重ならない・季節・店の主人は容疑者に入れない
    const title = pz.story.title;
    record('日替わり: 題名は dailyConfig だけで分かる', cfg.title === title, tag + ' ' + cfg.title + ' / ' + title);
    record('日替わり: 同じ事件が14日以内に重ならない', storyLast[title] == null || i - storyLast[title] >= 14, tag + ' ' + title + ' 前回 ' + storyLast[title]);
    storyLast[title] = i;
    const so = ST.find((s) => s.title === title);
    const month = dt.getUTCMonth() + 1;
    record('日替わり: 季節に合う事件', !!so && (!so.m || so.m.indexOf(month) >= 0), tag + ' ' + title);
    record('日替わり: 事件の店の主人は容疑者に入らない', !pz.story.job || pz.villagers.every((x) => x.job !== pz.story.job), tag + ' ' + title + ' ' + pz.story.job);
    // 店（job）か題材（g）が同じ事件は7日以内に続けない（羊・時計・帽子などが同じ週に並ばない）
    const tags = storyTags(so);
    record('日替わり: 店か題材が同じ事件が7日以内に続かない', tags.every((g) => tagLast[g] == null || i - tagLast[g] >= 7), tag + ' ' + title + ' ' + JSON.stringify(tags.map((g) => [g, tagLast[g]])));
    tags.forEach((g) => { tagLast[g] = i; });
  }
  dDist[pz.star]++;
  dByStar[wStar][1]++;
  if (pz.star === wStar) { dMatch++; dByStar[wStar][0]++; }
  const again = E2.daily(ds);
  record('日替わり: 同じ日付で同じ問題（別インスタンス）', JSON.stringify(again) === JSON.stringify(pz), tag);
}

/* ---------- 事件の割り当て（約3年。dailyConfig だけで軽く） ----------
 * 既定の日替わり120日（10〜1月）では、春夏の季節の事件（こいのぼり・風鈴など）が一度も出ない。
 * 問題そのものは作らず、事件の割り当てだけを約3年ぶん確かめる（50ms ほど）。 */
{
  const F = fresh();
  const last = {}, lastTag = {}, seen = new Set();
  const bad = { season: [], d14: [], d7: [] };
  for (let i = 0; i < STORY_DAYS; i++) {
    const ds = dayStr(i);
    let cfg;
    try { cfg = F.dailyConfig(ds); } catch (e) { bad.season.push(ds + ' ' + e.message); continue; }
    const title = cfg.title;
    seen.add(title);
    const so = ST.find((s) => s.title === title);
    const month = new Date(start + i * 86400000).getUTCMonth() + 1;
    if (!so || (so.m && so.m.indexOf(month) < 0)) bad.season.push(ds + ' ' + title);
    if (last[title] != null && i - last[title] < 14) bad.d14.push(ds + ' ' + title + ' ' + (i - last[title]) + '日');
    last[title] = i;
    const tags = storyTags(so);
    if (tags.some((g) => lastTag[g] != null && i - lastTag[g] < 7)) bad.d7.push(ds + ' ' + title + ' ' + JSON.stringify(tags.map((g) => [g, lastTag[g] == null ? null : i - lastTag[g]])));
    tags.forEach((g) => { lastTag[g] = i; });
  }
  const lbl = `（${STORY_DAYS}日）`;
  record('事件の割り当て' + lbl + ': 季節に合う事件', bad.season.length === 0, bad.season.slice(0, 3).join(' / '));
  record('事件の割り当て' + lbl + ': 同じ事件が14日以内に重ならない', bad.d14.length === 0, bad.d14.slice(0, 3).join(' / '));
  record('事件の割り当て' + lbl + ': 店か題材が同じ事件が7日以内に続かない', bad.d7.length === 0, bad.d7.slice(0, 3).join(' / '));
  if (STORY_DAYS >= 366) {
    const missing = ST.filter((s) => !seen.has(s.title)).map((s) => s.title + (s.m ? '（' + s.m.join('・') + '月）' : ''));
    record('事件の割り当て' + lbl + ': 全部の事件（季節の事件も）が1回は出る', missing.length === 0, '出ない事件: ' + missing.join(' / '));
  }
}

// 例題（遊び方）
if (typeof E.example === 'function') {
  const ex = E.example();
  inspect(ex, '[例題]', 2, 4);
  record('例題: 正解はアオイだけ嘘つき・犯人アオイ', ex.solution.status.join('') === 'LHHH' && ex.solution.culprit === 0 && bruteSolutions(ex).length === 1, '[例題]');
}

if (typeof E.example === 'function') {
  const ex = E.example();
  const s0 = ex.steps[0];
  record('例題: 解説は「もしイツキが嘘つきだとすると」から（遊び方の説明と同じ）', s0.kind === 'hypo' && s0.assume.kind === 'status' && s0.assume.person === 1 && s0.assume.value === 'L', '[例題] ' + s0.text);
}

// API の細かい約束
{
  // seed の型: 7 と '7' は同じ問題だが、渡した型のまま返す（呼ぶ順に関係なく）
  const F1 = fresh(), F2 = fresh();
  const a = F1.generate({ seed: '7', people: 4, star: 2 }), b = F1.generate({ seed: 7, people: 4, star: 2 });
  const c = F2.generate({ seed: 7, people: 4, star: 2 });
  record('API: seed の型をそのまま返す', a.seed === '7' && b.seed === 7 && JSON.stringify(b) === JSON.stringify(c), JSON.stringify([a.seed, b.seed, c.seed]));
  // 日付: 存在しない日付は例外。うるう日は通る
  for (const d of ['2026-02-30', '2026-13-01', '2027-02-29', '2026-00-10', '2026-1-1', '', null]) {
    let threw = false;
    try { E.dailyConfig(d); } catch (e) { threw = true; }
    record('API: 存在しない日付は受け付けない', threw, String(d));
  }
  let leap = null;
  try { leap = E.dailyConfig('2028-02-29'); } catch (e) { leap = null; }
  record('API: うるう日は受け付ける', !!leap && leap.weekdayLabel === '火', JSON.stringify(leap));
  // 生成のパラメータを外から変えられない（_setKill などの調整用の口がない・表を書き換えられない）
  const F3 = fresh(), F4 = fresh();
  const hooks = Object.keys(F3).filter((k) => k.startsWith('_') && k !== '_internal');
  try { F3._internal.STORIES[0].title = 'x'; F3._internal.POOL[0].name = 'x'; F3._internal.WEIGHTS[1].LIAR = 99; } catch (e) { /* 凍結されていれば例外でもよい */ }
  const p3 = F3.generate({ seed: 'api', people: 5, star: 2 }), p4 = F4.generate({ seed: 'api', people: 5, star: 2 });
  record('API: 生成のパラメータを外から変えられない', hooks.length === 0 && JSON.stringify(p3) === JSON.stringify(p4), JSON.stringify(hooks));
  // 遊び方: 誤答で矛盾が見つからない場合もメッセージを返す（理屈の上では起きないので形だけ）
  const pz = E.generate({ seed: 'api', people: 4, star: 1 });
  const r = E.check(pz, { status: pz.solution.status.slice(), culprit: (pz.solution.culprit + 1) % 4 });
  record('API: check の失敗には必ずメッセージ', r.ok === false && ((r.contradiction && r.contradiction.message) || r.message), JSON.stringify(r));
}

/* ---------- 回帰: 問題が前と同じか ---------- */
// あわせて、日替わり365日（1年ぶんの季節）について、店の主人・目標★・曜日の幅（stats から）を確かめ、生成時間を測る
const daily365 = { times: [], worst: null };
function goldenHashes(Eng) {
  const h1 = crypto.createHash('sha256');
  for (let i = 0; i < 365; i++) {
    const ds = dayStr(i), wd = new Date(start + i * 86400000).getUTCDay();
    const a = performance.now();
    const pz = Eng.daily(ds);
    const d = timed(performance.now() - a, (F) => { F.dailyConfig(ds); F.daily(ds); });
    daily365.times.push(d);
    if (!daily365.worst || d > daily365.worst[1]) daily365.worst = [ds, d, pz.people, pz.star];
    h1.update(JSON.stringify(pz) + '\n');
    const tag = `[日替わり365日 ${ds}]`;
    record('日替わり365日: 事件の店の主人は容疑者に入らない', !pz.story.job || pz.villagers.every((x) => x.job !== pz.story.job), tag + ' ' + pz.story.title);
    const [wStar] = WEEK[wd];
    const m = { hyps: pz.stats.hyps, chain: pz.stats.chain, sum: pz.stats.sum, back: pz.stats.back, given: !!pz.given };
    record('日替わり365日: 目標★と曜日の難しさの幅（stats から）', pz.star === wStar && (!WBAND[wd] || WBAND[wd][1](m)), tag + ' ' + (WBAND[wd] ? WBAND[wd][0] : '') + ' ' + JSON.stringify(m) + ' star=' + pz.star);
  }
  const h2 = crypto.createHash('sha256');
  for (const star of [1, 2, 3]) for (const N of [3, 4, 5, 6]) for (let i = 0; i < 20; i++) h2.update(JSON.stringify(Eng.generate({ seed: 'r' + i, people: N, star })) + '\n');
  const h3 = crypto.createHash('sha256');
  if (Eng.LIMITS && Eng.LIMITS.maxPeople >= 9) for (const N of [7, 8, 9]) for (let i = 0; i < 30; i++) h3.update(JSON.stringify(Eng.generate({ seed: 'h' + i, people: N, star: 3 })) + '\n');
  return { daily365: h1.digest('hex').slice(0, 32), practice240: h2.digest('hex').slice(0, 32), hard90: h3.digest('hex').slice(0, 32) };
}
let regressMsg = '';
const REG = [['daily365', '回帰: 3〜6人の日替わり365日が基準と同じ'], ['practice240', '回帰: 3〜6人の練習240問が基準と同じ'], ['hard90', '回帰: 7〜9人（難問）90問が基準と同じ']];
{
  const now = goldenHashes(fresh());
  const g = GOLDEN[E.VERSION];
  if (!g) {
    regressMsg = `VERSION ${E.VERSION} の基準ハッシュがありません。docs に変更を書いてから、tools/check-engine.mjs の GOLDEN に ${E.VERSION}: { daily365: '${now.daily365}', practice240: '${now.practice240}', hard90: '${now.hard90}' } を足してください。`;
    for (const [, name] of REG) record(name, false, regressMsg);
  } else {
    const msg = (k) => `ハッシュ ${g[k]} → ${now[k]}。` + (k === 'hard90'
      ? '7〜9人の問題が変わりました。解きかけの難問が別の問題で再開されるので、意図した変更なら VERSION を上げて docs に書き、GOLDEN に新しい VERSION の値を足してください。'
      : '3〜6人の問題が変わりました。意図した変更なら、エンジンの VERSION を上げて docs に書き、GOLDEN に新しい VERSION の値を足してください。');
    for (const [k, name] of REG) if (!record(name, now[k] === g[k], msg(k))) regressMsg = regressMsg || msg(k);
  }
}

/* ---------- 7〜9人（難問） ---------- */
// 解説の行数（画面で1行ずつ並ぶ数。仮定は見出し・中の手・矛盾・結論）と文字数
function explainSize(pz) {
  let lines = 0, chars = 0;
  for (const s of pz.steps) {
    if (s.kind === 'hypo') {
      lines += (s.sub || []).length + 3;
      chars += s.text.length + (s.sub || []).reduce((x, t) => x + t.text.length, 0) + s.contradiction.length + s.conclusion.length;
    } else { lines++; chars += s.text.length; }
  }
  return { lines, chars };
}
const hardTable = [];
let hardInfo = null;
const hardTypes = {};
let hardStmts = 0, hardUnused = 0, hardTotal = 0;
const hasLimits = !!(E.LIMITS && E.LIMITS.maxPeople >= 9);
record('7〜9人: Engine.LIMITS で9人まで対応と分かる', hasLimits && E.LIMITS.minPeople === 3 && E.LIMITS.hardFrom === 7 && E.LIMITS.hardStar === 3 && Object.isFrozen(E.LIMITS),
  'Engine.LIMITS = ' + JSON.stringify(E.LIMITS) + '（9人に対応したエンジンを index.html の ENGINE START〜END に入れる）');
if (hasLimits) {
  for (const N of [7, 8, 9]) {
    const S = HARD_SPEC[N];
    const tt = [];
    const hyp = {}, lin = [], chs = [];
    for (let i = 0; i < COUNT_HARD; i++) {
      const seed = i % 2 ? 900000 + 1000 * N + i : 'h' + N + '-' + i.toString(36);
      const tag = `[難問 ${N}人 seed=${seed}]`;
      let pz;
      const a = performance.now();
      try { pz = E.generate({ seed, people: N, star: 3 }); } catch (e) { record('7〜9人: 生成できる', false, tag + ' ' + e.message); continue; }
      const d = performance.now() - a;
      tt.push(d);
      record('7〜9人: 生成できる', !!pz && pz.people === N, tag);
      // 最初の2問は、check() にありうる誤答を全部渡す（9人で 4,608 通り）
      const { v, a: au } = inspect(pz, tag, 3, N, { fullCheck: i < 2 });
      const sz = explainSize(pz);
      hyp[v.hyps] = (hyp[v.hyps] || 0) + 1; lin.push(sz.lines); chs.push(sz.chars);
      record('7〜9人: ★3（難問）', pz.star === 3 && pz.targetStar === 3, tag + ' star=' + pz.star);
      record('7〜9人: 仮定の回数と手の合計（人が順に考えられる重さ）', v.hyps >= S.hyps[0] && v.hyps <= S.hyps[1] && v.sum >= S.sumMin,
        tag + ` hyps=${v.hyps}（${S.hyps.join('〜')}） sum=${v.sum}（${S.sumMin}以上）`);
      record('7〜9人: 連鎖が上限以下', v.chain <= S.chainMax, tag + ` chain=${v.chain}（${S.chainMax}以下）`);
      record('7〜9人: 解説が長すぎない（行数・文字数）', sz.lines <= S.lines && sz.chars <= S.chars, tag + ` ${sz.lines}行（${S.lines}以下） ${sz.chars}字（${S.chars}以下）`);
      const cnt = {};
      pz.statements.forEach((x) => { cnt[x.type] = (cnt[x.type] || 0) + 1; hardTypes[x.type] = (hardTypes[x.type] || 0) + 1; hardStmts++; });
      const kinds = Object.keys(cnt).length, top = Math.max(...Object.values(cnt));
      record('7〜9人: 証言の種類が偏らない（種類の数・同じ種類の数）', kinds >= S.minTypes && top <= S.typeCap && (cnt.HONESTCOUNT || 0) <= 1,
        tag + ` ${kinds}種類（${S.minTypes}以上） 最多${top}個（${S.typeCap}以下） ${JSON.stringify(cnt)}`);
      hardTotal++;
      if (N - au.used.size > 0) hardUnused++;   // エンジンの stats.unused ではなく、解説から数えたもの
      if (i < 15) {
        const again = E2.generate({ seed, people: N, star: 3 });
        record('同じseedで同じ問題（別インスタンス）', JSON.stringify(again) === JSON.stringify(pz), tag);
        const sv = E.solve(pz);
        record('solve() が保存済みの解説と一致', sv.solved === true && sv.stars === pz.star && JSON.stringify(sv.steps) === JSON.stringify(pz.steps), tag);
      }
    }
    // ★を何で指定しても7人以上は★3。人数の上限は9
    for (const star of [1, 2, '1', undefined]) {
      let p, err = '';
      try { p = E.generate({ seed: 'any-star', people: N, star }); } catch (e) { err = e.message; }
      record('7〜9人: ★の指定にかかわらず★3', !err && p.people === N && p.star === 3 && p.targetStar === 3, `[${N}人 star=${star}] ${err}`);
    }
    const avg = tt.reduce((x, y) => x + y, 0) / Math.max(1, tt.length);
    const max = Math.max(...tt);
    record(`7〜9人: 生成時間 平均${HARD_PERF.avg}ms以下・最大${HARD_PERF.max}ms以下`, avg <= HARD_PERF.avg && max <= HARD_PERF.max, `${N}人 平均 ${avg.toFixed(1)}ms 最大 ${max.toFixed(1)}ms`);
    lin.sort((x, y) => x - y); chs.sort((x, y) => x - y);
    hardTable.push({ N, avg, max, hyp, lines: [lin[0], lin[lin.length >> 1], lin[lin.length - 1]], chars: [chs[0], chs[chs.length >> 1], chs[chs.length - 1]] });
  }
  for (const [o, want] of [[{ people: 10 }, 9], [{ people: 99, star: 2 }, 9], [{ people: '8' }, 8], [{ people: 6.9, star: 3 }, 6]]) {
    let p, err = '';
    try { p = E.generate(Object.assign({ seed: 'lim' }, o)); } catch (e) { err = e.message; }
    record('7〜9人: 人数は3〜9に丸める', !err && p.people === want, JSON.stringify(o) + ' → ' + (err || p.people));
  }
  // 全体で見た証言の種類の偏り・使われない証言
  const shares = Object.fromEntries(Object.entries(hardTypes).map(([k, n]) => [k, n / Math.max(1, hardStmts)]));
  const topShare = Math.max(...Object.values(shares));
  record('7〜9人: 全体で証言の種類が偏らない（どの種類も25%以下・全11種類が出る）', topShare <= 0.25 && Object.keys(hardTypes).length === E.TYPES.length,
    JSON.stringify(Object.fromEntries(Object.entries(shares).map(([k, x]) => [k, +(x * 100).toFixed(1)]))));
  record('7〜9人: 使われない証言がある問題は10%以下', hardUnused <= hardTotal * 0.1, `${hardUnused}/${hardTotal}`);
  hardInfo = { shares, unused: [hardUnused, hardTotal] };
}

/* ---------- Web Worker の中でも動くか ---------- */
{
  let W = null, err = '';
  try { W = loadAsWorker(code); } catch (e) { err = e.message; }
  record('Worker: window・document なしで読める（self.Engine）', !err && !!W && typeof W.generate === 'function', err || 'self.Engine が無い');
  if (W) {
    let ok = false, detail = '';
    try {
      const n = hasLimits ? 9 : 6;
      const a = W.generate({ seed: 'worker', people: n, star: 3 });
      const b = E.generate({ seed: 'worker', people: n, star: 3 });
      const d = W.daily('2026-10-08');
      const h = W.hint(a, { status: Array(n).fill(null), culprit: null }, 2);
      const c = W.check(a, { status: a.solution.status.slice(), culprit: a.solution.culprit });
      ok = JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(d) === JSON.stringify(E.daily('2026-10-08')) && typeof h.text === 'string' && c.ok === true;
      detail = n + '人';
    } catch (e) { detail = e.message; }
    record('Worker: 同じ問題を作れる・hint/check も動く', ok, detail);
  }
}

/* ---------- Web Worker: アプリと同じ経路 ----------
 * 画面は、<script> の中身から目印（ENGINE START〜END）でエンジンを切り出し（engineSource）、WORKER_TAIL を足して
 * Blob の Worker で動かす。ready の通知 → {seed, people, star} を受けて {ok, pz: JSON 文字列} を返す。
 * ここでも同じ切り出しと WORKER_TAIL を node の worker_threads で動かし、画面側（Engine.generate）と同じ問題になるかを見る。 */
const workerInfo = [];
async function workerAppPath() {
  const NAME_MARK = 'Worker: 目印（ENGINE START / END）は index.html に1回ずつ';
  const NAME_RUN = 'Worker: アプリと同じ経路（切り出し＋WORKER_TAIL＋postMessage）で同じ問題を作れる';
  const NAME_JUNK = 'Worker: 壊れたメッセージでも止まらずに返事をする';
  if (!target.endsWith('.html')) { record(NAME_RUN, false, '.html でないので試せない'); return; }
  const A = '// ==ENGINE ' + 'START==', B = '// ==ENGINE ' + 'END==';
  const nA = SRC.split(A).length - 1, nB = SRC.split(B).length - 1;
  record(NAME_MARK, nA === 1 && nB === 1, `START ${nA}回 / END ${nB}回`);
  const scripts = [...SRC.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const sc = scripts.find((s) => s.indexOf(A) >= 0);   // engineSource() と同じ: 目印を含む最初の script
  const ia = sc ? sc.indexOf(A) : -1, ib = sc ? sc.indexOf(B) : -1;
  const src = ia >= 0 && ib > ia ? sc.slice(ia, ib) : '';
  const mt = /const WORKER_TAIL = ([\s\S]*?);\n/.exec(SRC);
  let tail = null;
  try { tail = mt ? vm.runInNewContext(mt[1]) : null; } catch (e) { tail = null; }
  if (!src || typeof tail !== 'string') { record(NAME_RUN, false, !src ? 'エンジンを切り出せない' : 'WORKER_TAIL を取り出せない'); return; }
  const boot = `const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const ctx = {}; ctx.self = ctx; ctx.postMessage = (m) => parentPort.postMessage(m);
vm.createContext(ctx);
vm.runInContext(workerData.code, ctx);
parentPort.on('message', (d) => ctx.onmessage({ data: d }));`;
  // 画面と同じく、作ってすぐにメッセージを送る（Worker は読み込み終わってから受け取る）
  const run = (msg) => new Promise((resolve) => {
    const got = [];
    const t0 = performance.now();
    let w;
    try { w = new Worker(boot, { eval: true, workerData: { code: src + tail } }); } catch (e) { resolve({ error: e.message, got }); return; }
    const to = setTimeout(() => { w.terminate(); resolve({ error: '5秒たっても返事が無い', got }); }, 5000);
    w.on('message', (d) => {
      got.push(d);
      if (d && d.ready) return;
      clearTimeout(to); w.terminate();
      resolve({ got, ms: performance.now() - t0 });
    });
    w.on('error', (e) => { clearTimeout(to); resolve({ error: e.message, got }); });
    w.postMessage(msg);
  });
  for (const msg of [{ seed: 'worker-app-9', people: 9, star: 3 }, { seed: 12345, people: 8, star: 3 }, { seed: 'p' + (1790000000000).toString(36), people: 5, star: 2 }]) {
    const r = await run(msg);
    let ok = false, detail = JSON.stringify(msg) + ' ';
    if (r.error) detail += r.error + ' ' + JSON.stringify(r.got).slice(0, 200);
    else {
      const [first, last] = [r.got[0], r.got[r.got.length - 1]];
      const readyFirst = !!(first && first.ready === true);
      let same = false;
      try { same = !!(last && last.ok === true && typeof last.pz === 'string' && JSON.stringify(JSON.parse(last.pz)) === JSON.stringify(E.generate(msg))); } catch (e) { same = false; }
      ok = readyFirst && same;
      detail += `ready が先=${readyFirst} 同じ問題=${same} ${r.ms.toFixed(0)}ms`;
      workerInfo.push(`${msg.people}人 ${r.ms.toFixed(0)}ms`);
    }
    record(NAME_RUN, ok, detail);
  }
  for (const msg of [null, { people: 'x' }, { seed: { a: 1 }, people: 9 }]) {
    const r = await run(msg);
    const last = r.got && r.got[r.got.length - 1];
    const ok = !r.error && !!last && !last.ready && (last.ok === true ? typeof last.pz === 'string' : last.ok === false && typeof last.error === 'string');
    record(NAME_JUNK, ok, JSON.stringify(msg) + ' ' + (r.error || JSON.stringify(last).slice(0, 200)));
  }
}
await workerAppPath();

/* ---------- 生成時間の最悪値・冷えた状態・遠い日付（表示だけ） ----------
 * 3〜6人の問題と日替わりは画面（メインスレッド）で作るので、時間がかかるとその間は画面が止まる。
 * 上の検査は温まったエンジン・決まった数値の seed なので、ここではアプリと同じ形の seed（'p' + 36進数）での最悪値、
 * アプリを開いた直後と同じ冷えた状態、遠い先の日付の dailyConfig の初回を測る。
 * いまのエンジンでは目安（PERF_GOAL）を超えるものがあるので、合否には入れずに表示だけする（#0012）。 */
const perfInfo = { seeds: [], cold: null, far: null };
{
  for (const N of [5, 6]) {
    const F = fresh();
    F.generate({ seed: 'warm-up', people: N, star: 2 });
    const tt = [];
    let worst = null;
    for (let i = 0; i < PERF_SEEDS; i++) {
      const seed = 'p' + (1790000000000 + i * 7919).toString(36) + ((i * 104729) % 1e6).toString(36);
      const a = performance.now();
      F.generate({ seed, people: N, star: 2 });
      const d = timed(performance.now() - a, (G) => G.generate({ seed, people: N, star: 2 }));
      tt.push(d);
      if (!worst || d > worst[1]) worst = [seed, d];
    }
    tt.sort((x, y) => x - y);
    if (tt.length) perfInfo.seeds.push({ N, n: tt.length, avg: tt.reduce((x, y) => x + y, 0) / tt.length, p99: tt[Math.floor(tt.length * 0.99)], max: tt[tt.length - 1], worst: worst[0] });
  }
  // 冷えた状態: アプリを開いた直後（エンジンを読み込んだばかり）に日替わりを作る
  const cold = [];
  for (let i = 0; i < 365; i += 13) {
    const ds = dayStr(i);
    const F = fresh();
    const a = performance.now();
    F.daily(ds);
    cold.push([ds, performance.now() - a]);
  }
  cold.sort((x, y) => y[1] - x[1]);
  perfInfo.cold = { n: cold.length, avg: cold.reduce((x, y) => x + y[1], 0) / cold.length, max: cold[0] };
  // 遠い先の日付の dailyConfig の初回（No.1 から1日ずつ事件の割り当てを積み上げるため、先ほど遅い）
  const F = fresh();
  const a = performance.now();
  F.dailyConfig('2036-10-01');
  perfInfo.far = ['2036-10-01', performance.now() - a];
}

/* ---------- 表示 ---------- */
const f1 = (x) => x.toFixed(1);
console.log('★×人数ごとの結果（実測★の分布 / 目標一致率 / 生成時間）');
for (const r of table) {
  console.log(`  ★${r.star} ${r.N}人: 実測 ★1=${r.dist[1]} ★2=${r.dist[2]} ★3=${r.dist[3]}  一致 ${(r.match * 100).toFixed(1)}%  平均 ${f1(r.avg)}ms 最大 ${f1(r.max)}ms  未使用1つ ${r.unused1}問`);
}
const avgAll = times.reduce((x, y) => x + y, 0) / Math.max(1, times.length);
const maxAll = Math.max(...times);
console.log(`\n日替わり ${DAYS}日: 目標★と実測★の一致 ${dMatch}/${DAYS} (${(dMatch / DAYS * 100).toFixed(1)}%)  実測 ★1=${dDist[1]} ★2=${dDist[2]} ★3=${dDist[3]}`);
for (const s of [1, 2, 3]) console.log(`  目標★${s}: ${dByStar[s][0]}/${dByStar[s][1]} 一致`);
console.log(`  平均 ${f1(dTimes.reduce((x, y) => x + y, 0) / Math.max(1, dTimes.length))}ms 最大 ${f1(Math.max(...dTimes))}ms`);
console.log(`\n生成時間（3〜6人 全体 ${times.length}問）: 平均 ${f1(avgAll)}ms / 最大 ${f1(maxAll)}ms（${SLOW}ms を超えたものは新しいエンジンで測り直した短いほう）`);
if (hardTable.length) {
  console.log(`\n7〜9人（難問）各${COUNT_HARD}問（生成時間 / 仮定の回数の分布 / 解説の行数・文字数 最小・中央・最大）`);
  for (const r of hardTable) {
    console.log(`  ${r.N}人: 平均 ${f1(r.avg)}ms 最大 ${f1(r.max)}ms  仮定 ${Object.entries(r.hyp).map(([k, n]) => k + '回=' + n).join(' ')}  行 ${r.lines.join('/')}  字 ${r.chars.join('/')}`);
  }
  if (hardInfo) {
    console.log('  証言の種類: ' + Object.entries(hardInfo.shares).sort((x, y) => y[1] - x[1]).map(([k, x]) => k + ' ' + (x * 100).toFixed(1) + '%').join(', '));
    console.log(`  使われない証言がある問題: ${hardInfo.unused[0]}/${hardInfo.unused[1]}`);
  }
}
if (workerInfo.length) console.log(`\nWorker（アプリと同じ経路・読み込みから返事まで）: ${workerInfo.join(' / ')}`);
{
  const over = (x, g) => (x > g ? ' ←目安超え' : '');
  console.log(`\n生成時間の参考（合否には入れていない。目安: 画面で作る分の最大 ${PERF_GOAL.main}ms・dailyConfig の初回 ${PERF_GOAL.firstConfig}ms）`);
  for (const r of perfInfo.seeds) console.log(`  ★2 ${r.N}人 アプリと同じ形の seed ${r.n}問: 平均 ${f1(r.avg)}ms p99 ${f1(r.p99)}ms 最大 ${f1(r.max)}ms（${r.worst}）${over(r.max, PERF_GOAL.main)}`);
  const dt = daily365.times.slice().sort((x, y) => x - y);
  if (dt.length && daily365.worst) console.log(`  日替わり365日（温まった状態）: 平均 ${f1(dt.reduce((x, y) => x + y, 0) / dt.length)}ms 最大 ${f1(daily365.worst[1])}ms（${daily365.worst[0]}・${daily365.worst[2]}人・★${daily365.worst[3]}）${over(daily365.worst[1], PERF_GOAL.main)}`);
  if (perfInfo.cold) console.log(`  日替わり（冷えた状態＝開いた直後）${perfInfo.cold.n}日: 平均 ${f1(perfInfo.cold.avg)}ms 最大 ${f1(perfInfo.cold.max[1])}ms（${perfInfo.cold.max[0]}）${over(perfInfo.cold.max[1], PERF_GOAL.main)}`);
  if (perfInfo.far) console.log(`  dailyConfig('${perfInfo.far[0]}') の初回: ${f1(perfInfo.far[1])}ms${over(perfInfo.far[1], PERF_GOAL.firstConfig)}`);
}

record('性能: 平均30ms以下（3〜6人）', avgAll <= 30, `平均 ${f1(avgAll)}ms`);
record('性能: 最大300ms以下（3〜6人）', maxAll <= 300, `最大 ${f1(maxAll)}ms`);
record('日替わり: 目標★の一致率90%以上', dMatch / DAYS >= 0.9, `${dMatch}/${DAYS}`);

console.log('\n検査項目:');
let anyFail = false;
for (const r of results) {
  const ok = r.fail === 0;
  if (!ok) anyFail = true;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.pass}/${r.pass + r.fail})`);
  if (!ok) for (const d of failures[r.name]) console.log('        ' + d);
}
if (regressMsg) console.log('\n*** ' + (GOLDEN[E.VERSION] ? '問題が基準と違います。VERSION を上げて docs に書いてください。' : 'VERSION ' + E.VERSION + ' の基準ハッシュを GOLDEN に足してください。') + ' ***\n    ' + regressMsg);
console.log(`\n${anyFail ? 'FAIL' : 'PASS'}  ${results.length}項目  (${((Date.now() - t0) / 1000).toFixed(1)}秒)`);
process.exit(anyFail ? 1 : 0);
