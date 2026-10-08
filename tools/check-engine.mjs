#!/usr/bin/env node
// 嘘つき村の事件簿 — エンジン検査
// 使い方: node tools/check-engine.mjs [index.html | engine.js] [--count 200] [--days 120] [--count-hard 100]
// .html なら「// ==ENGINE START==」〜「// ==ENGINE END==」の間を取り出して評価する。
// 検算はエンジンの関数を使わず、ここで独立に総当たり・論理チェックをする。
// --count = 3〜6人の★×人数ごとの問題数、--days = 日替わりの日数、--count-hard = 7〜9人（難問）の人数ごとの問題数
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : def;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const OPT_NAMES = ['--count', '--days', '--count-hard'];
const optIdx = new Set(OPT_NAMES.map((n) => argv.indexOf(n)).filter((i) => i >= 0).map((i) => i + 1));
const target = path.resolve(argv.find((a, i) => !a.startsWith('--') && !optIdx.has(i)) || path.join(here, '..', 'index.html'));
const COUNT = parseInt(opt('--count', '200'), 10);
const DAYS = parseInt(opt('--days', '120'), 10);
const COUNT_HARD = parseInt(opt('--count-hard', '100'), 10);

/* ---------- 回帰テストの基準（3〜6人の問題が変わっていないか） ----------
 * VERSION ごとに、次の2つの SHA-256（先頭32文字）を持つ。
 *   daily365    = 2026-10-01 から365日分の JSON.stringify(Engine.daily(日付)) + '\n' をつないだもの
 *   practice240 = ★1〜3 × 3〜6人 × seed 'r0'〜'r19' の JSON.stringify(Engine.generate(...)) + '\n' をつないだもの
 * 値が変わったら、全員の日替わり・練習の問題が変わったということ。
 * 意図した変更なら、エンジンの VERSION を上げて docs に書き、ここに新しい VERSION の値を足す。 */
const GOLDEN = {
  3: { daily365: '964b8ed41145a3cc4878e1c4afa8533e', practice240: 'fe126bada59957334b67c3251b261039' },
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

/* ---------- 読み込み ---------- */
function extractCode(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (!file.endsWith('.html')) return src;
  const lines = src.split('\n');
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

/* ---------- 1問ぶんの検査 ---------- */
let rngState = 12345;
const rnd = () => { rngState = (Math.imul(rngState, 1103515245) + 12345) >>> 0; return rngState / 4294967296; };
const rint = (n) => Math.floor(rnd() * n);

function inspect(pz, tag, targetStar, people) {
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

  // check(): 正解
  const ok = E.check(pz, { status: pz.solution.status.slice(), culprit: pz.solution.culprit });
  record('check: 正解で ok', ok && ok.ok === true, tag);
  // check(): ランダムな誤答
  for (let t = 0; t < 6; t++) {
    const status = Array.from({ length: N }, () => (rnd() < 0.5 ? 'H' : 'L'));
    const culprit = rint(N);
    if (culprit === pz.solution.culprit && status.every((x, i) => x === pz.solution.status[i])) continue;
    let r;
    try { r = E.check(pz, { status, culprit }); } catch (e) { record('check: 誤答の矛盾が本物', false, tag + ' 例外 ' + e.message); continue; }
    let h = 0; status.forEach((x, i) => { if (x === 'H') h |= 1 << i; });
    let good = r && r.ok === false && r.contradiction && typeof r.contradiction.message === 'string' && r.contradiction.message.length > 0 && !BAD.test(r.contradiction.message);
    if (good) {
      const cd = r.contradiction;
      const givenBad = pz.given && status[pz.given.person] !== pz.given.value;
      if (cd.kind === 'given') good = !!givenBad;
      else if (cd.kind === 'statement') {
        const S = pz.statements[cd.index];
        good = !givenBad && !!S && cd.speaker === S.speaker && !consistentStmt(S, h, culprit) &&
          pz.statements.slice(0, cd.index).every((X) => consistentStmt(X, h, culprit)) &&
          cd.message.includes(pz.villagers[S.speaker].name);
      } else good = false;
    }
    record('check: 誤答の矛盾が本物', good, tag + ' ' + JSON.stringify(r));
    if (good && r.contradiction.kind === 'statement') {
      const S = pz.statements[r.contradiction.index];
      const cul = { CULPRIT: 1, NOTCULPRIT: 1, CULPRIT_IN: 1, CULPRIT_LIAR: 1, CULPRIT_HONEST: 1 }[S.type];
      record('check: 犯人についての食い違いは選んだ犯人も書く', !cul || r.contradiction.message.includes('犯人は' + pz.villagers[culprit].name + '。'), tag + ' ' + r.contradiction.message);
    }
  }
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
  hintProgress(pz, tag);
  // 最初に決まる項目を間違えて印をつけたら「見直し」を促す
  const first = pz.steps[0].facts.find((f) => f.kind === 'status');
  if (first) {
    const s = { status: Array(N).fill(null), culprit: null };
    s.status[first.person] = first.value === 'H' ? 'L' : 'H';
    const r = E.hint(pz, s, 1);
    record('hint: 間違った印の見直しを促す', r && r.text.includes('見直') && r.text.includes(pz.villagers[first.person].name), tag + ' ' + (r && r.text));
  }
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
      for (let p = 0; p < N && !leak; p++) {
        if (status[p] === pz.solution.status[p]) continue;
        if (new RegExp(names[p] + '(は|が|を)(正直者|嘘つき)(だ|と|$|。|、|な)').test(h1.text) && !new RegExp(names[p] + 'を正直者か嘘つきのどちらか').test(h1.text)) leak = names[p] + 'の判定';
      }
      if (!leak && cul == null && new RegExp('犯人(は|が)(' + NA + ')|(' + NA + ')(自身)?が犯人|(' + NA + ')は犯人(では|じゃ)ない').test(h1.text)) leak = '犯人';
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

/* ---------- 本体 ---------- */
const t0 = Date.now();
console.log('検査対象: ' + target);
console.log(`3〜6人: 各★×人数 ${COUNT}問、日替わり ${DAYS}日分 / 7〜9人: 各${COUNT_HARD}問\n`);

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
      const d = performance.now() - a;
      tt.push(d); times.push(d);
      record('生成できる', !!pz, tag);
      dist[pz.star]++;
      if (pz.stats.unused && pz.stats.unused.length) unused1++;
      inspect(pz, tag, star, N);
      if (star === 3 && pz.star === 3) {
        const v = verifySteps(pz);
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
for (let i = 0; i < DAYS; i++) {
  const dt = new Date(start + i * 86400000);
  const ds = dt.toISOString().slice(0, 10);
  const wd = dt.getUTCDay();
  const tag = `[日替わり ${ds}]`;
  let cfg, pz;
  try { cfg = E.dailyConfig(ds); } catch (e) { record('日替わり: 設定', false, tag + ' ' + e.message); continue; }
  const [wStar, wN] = WEEK[wd];
  record('日替わり: 設定（No.・曜日・人数・★・seed）', cfg.no === i + 1 && cfg.weekday === wd && cfg.people === wN && cfg.star === wStar && Number.isInteger(cfg.seed), tag + ' ' + JSON.stringify(cfg));
  const a = performance.now();
  try { pz = E.daily(ds); } catch (e) { record('日替わり: 生成できる', false, tag + ' ' + e.message); continue; }
  const d = performance.now() - a;
  dTimes.push(d); times.push(d);
  record('日替わり: 生成できる', !!pz && pz.no === i + 1 && pz.date === ds && pz.seed === cfg.seed, tag);
  inspect(pz, tag, wStar, wN);
  {
    const v = verifySteps(pz);
    const back = pz.steps.filter((s) => s.kind === 'direct' && s.source !== 'given' && s.cat === 'B').length;
    const m = { hyps: v.hyps, chain: v.chain, sum: v.sum, back, given: !!pz.given };
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
    const tags = so ? [so.job ? 'job:' + so.job : null, so.g ? 'g:' + so.g : null].filter(Boolean) : [];
    record('日替わり: 店か題材が同じ事件が7日以内に続かない', tags.every((g) => tagLast[g] == null || i - tagLast[g] >= 7), tag + ' ' + title + ' ' + JSON.stringify(tags.map((g) => [g, tagLast[g]])));
    tags.forEach((g) => { tagLast[g] = i; });
  }
  dDist[pz.star]++;
  dByStar[wStar][1]++;
  if (pz.star === wStar) { dMatch++; dByStar[wStar][0]++; }
  const again = E2.daily(ds);
  record('日替わり: 同じ日付で同じ問題（別インスタンス）', JSON.stringify(again) === JSON.stringify(pz), tag);
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

/* ---------- 回帰: 3〜6人の問題が前と同じか ---------- */
function goldenHashes(Eng) {
  const h1 = crypto.createHash('sha256');
  for (let i = 0; i < 365; i++) h1.update(JSON.stringify(Eng.daily(new Date(start + i * 86400000).toISOString().slice(0, 10))) + '\n');
  const h2 = crypto.createHash('sha256');
  for (const star of [1, 2, 3]) for (const N of [3, 4, 5, 6]) for (let i = 0; i < 20; i++) h2.update(JSON.stringify(Eng.generate({ seed: 'r' + i, people: N, star })) + '\n');
  return { daily365: h1.digest('hex').slice(0, 32), practice240: h2.digest('hex').slice(0, 32) };
}
let regressMsg = '';
{
  const now = goldenHashes(fresh());
  const g = GOLDEN[E.VERSION];
  if (!g) {
    regressMsg = `VERSION ${E.VERSION} の基準ハッシュがありません。docs に変更を書いてから、tools/check-engine.mjs の GOLDEN に ${E.VERSION}: { daily365: '${now.daily365}', practice240: '${now.practice240}' } を足してください。`;
    record('回帰: 3〜6人の日替わり365日が基準と同じ', false, regressMsg);
    record('回帰: 3〜6人の練習240問が基準と同じ', false, regressMsg);
  } else {
    const msg = (k) => `ハッシュ ${g[k]} → ${now[k]}。3〜6人の問題が変わりました。意図した変更なら、エンジンの VERSION を上げて docs に書き、GOLDEN に新しい VERSION の値を足してください。`;
    if (!record('回帰: 3〜6人の日替わり365日が基準と同じ', now.daily365 === g.daily365, msg('daily365'))) regressMsg = msg('daily365');
    if (!record('回帰: 3〜6人の練習240問が基準と同じ', now.practice240 === g.practice240, msg('practice240'))) regressMsg = regressMsg || msg('practice240');
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
      inspect(pz, tag, 3, N);
      const v = verifySteps(pz);
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
      if (pz.stats.unused.length) hardUnused++;
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
console.log(`\n生成時間（3〜6人 全体 ${times.length}問）: 平均 ${f1(avgAll)}ms / 最大 ${f1(maxAll)}ms`);
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
if (regressMsg) console.log('\n*** ' + (GOLDEN[E.VERSION] ? '3〜6人の問題が基準と違います。VERSION を上げて docs に書いてください。' : 'VERSION ' + E.VERSION + ' の基準ハッシュを GOLDEN に足してください。') + ' ***\n    ' + regressMsg);
console.log(`\n${anyFail ? 'FAIL' : 'PASS'}  (${((Date.now() - t0) / 1000).toFixed(1)}秒)`);
process.exit(anyFail ? 1 : 0);
