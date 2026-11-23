// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}


type Edit = (tree: Tree) => void;

// ---- Section 3: file lines -------------------------------------------------

function fileParts(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, final: fin };
}

function joinParts(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

// ---- Section 5: matching lines at three tiers -------------------------------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrences(fileLines: string[], O: string[], tier: number, from: number, endAtEnd: boolean): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + O.length <= fileLines.length; i++) {
    if (endAtEnd && i + O.length !== fileLines.length) continue;
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!tierEq(fileLines[i + k]!, O[k]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(fileLines: string[], O: string[], strict: boolean, from: number, endAtEnd = false): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const ps = occurrences(fileLines, O, t, from, endAtEnd);
    if (ps.length > 0) return { tier: t, positions: ps };
  }
  return null;
}

type NItem = { kind: 'ctx'; oIdx: number } | { kind: 'new'; text: string };

/** The lines N writes for a match of O at `pos`: context lines are the file's own; at tier 2 new lines are re-indented. */
function writeItems(items: NItem[], fileLines: string[], pos: number, tier: number, O: string[]): string[] {
  const F = pos < fileLines.length ? leadWs(fileLines[pos]!) : '';
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  return items.map((it) => {
    if (it.kind === 'ctx') return fileLines[pos + it.oIdx]!;
    if (tier === 2 && it.text.trim() !== '' && it.text.startsWith(P)) return F + it.text.slice(P.length);
    return it.text;
  });
}

function writeNewLines(newLines: string[], fileLines: string[], pos: number, tier: number, O: string[]): string[] {
  return writeItems(newLines.map((text) => ({ kind: 'new', text }) as NItem), fileLines, pos, tier, O);
}

// ---- Section 6: unified diffs ------------------------------------------------

type UEntry = { type: 'ctx' | 'del' | 'add'; text: string; bs: boolean };
type UHunk = { a: number; entries: UEntry[] };
type USection = {
  diffOld?: string; diffNew?: string; oldRaw?: string; newRaw?: string; hasPair: boolean;
  renameFrom?: string; renameTo?: string; newFile: boolean; delFile: boolean; hunks: UHunk[];
};

function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function unifiedSections(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  const newSection = (): USection => {
    const s: USection = { hasPair: false, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1];
      cur.diffNew = m[2];
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: parseInt(m[1]!, 10), entries: [] };
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith('@@')) break;
        if (l === '') { hunk.entries.push({ type: 'ctx', text: '', bs: false }); i++; continue; }
        const c = l[0]!;
        if (c === ' ') { hunk.entries.push({ type: 'ctx', text: l.slice(1), bs: false }); i++; continue; }
        if (c === '-') { hunk.entries.push({ type: 'del', text: l.slice(1), bs: false }); i++; continue; }
        if (c === '+') { hunk.entries.push({ type: 'add', text: l.slice(1), bs: false }); i++; continue; }
        if (c === '\\') {
          const prev = hunk.entries[hunk.entries.length - 1];
          if (prev) prev.bs = true;
          i++;
          continue;
        }
        break;
      }
      while (hunk.entries.length > 0) {
        const lastE = hunk.entries[hunk.entries.length - 1]!;
        if (lastE.type === 'ctx' && lastE.text === '') hunk.entries.pop();
        else break;
      }
      cur.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('--- ')) {
      const nextPlus = (lines[i + 1] ?? '').startsWith('+++ ');
      if (cur && cur.hunks.length === 0 && !cur.hasPair) {
        if (!nextPlus) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldRaw = headerPath(line);
        cur.newRaw = headerPath(lines[i + 1]!);
        cur.hasPair = true;
        i += 2;
        continue;
      }
      if (nextPlus) {
        cur = newSection();
        cur.oldRaw = headerPath(line);
        cur.newRaw = headerPath(lines[i + 1]!);
        cur.hasPair = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (cur && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i++;
  }
  return sections;
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.hasPair ? sec.oldRaw : (sec.renameFrom ?? sec.diffOld);
    const newP = sec.hasPair ? sec.newRaw : (sec.renameTo ?? sec.diffNew);
    const isCreate = sec.newFile || oldP === '/dev/null';
    const isDelete = sec.delFile || newP === '/dev/null';
    if (!isCreate && oldP !== undefined && oldP !== '/dev/null' && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (!isDelete && newP !== undefined && newP !== '/dev/null' && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === undefined || newP === '/dev/null') throw new Exit2('error: parse 1');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const outLines: string[] = [];
      let lastAddBs = false;
      for (const h of sec.hunks) {
        for (const e of h.entries) {
          if (e.type === 'add') { outLines.push(e.text); lastAddBs = e.bs; }
        }
      }
      tree.now.set(newP, outLines.length === 0 ? '' : outLines.join('\n') + (lastAddBs ? '' : '\n'));
      return;
    }
    if (oldP === undefined || oldP === '/dev/null') throw new Exit2('error: parse 1');
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isDelete) {
      tree.now.set(oldP, null);
      return;
    }
    if (newP === undefined || newP === '/dev/null') throw new Exit2('error: parse 1');
    const isMove = newP !== oldP;
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const parts = fileParts(before);
    const work = [...parts.lines];
    let fin = parts.final;
    let d = 0;
    for (const h of sec.hunks) {
      const O: string[] = [];
      const items: NItem[] = [];
      let lastCtxOrAddBs = false;
      for (const e of h.entries) {
        if (e.type === 'ctx') { items.push({ kind: 'ctx', oIdx: O.length }); O.push(e.text); if (e.bs) lastCtxOrAddBs = true; else lastCtxOrAddBs = lastCtxOrAddBs; }
        else if (e.type === 'del') { O.push(e.text); }
        else { items.push({ kind: 'new', text: e.text }); if (e.bs) lastCtxOrAddBs = true; }
      }
      // A backslash after the hunk's last context or + line: recompute exactly.
      lastCtxOrAddBs = false;
      for (const e of h.entries) {
        if (e.type === 'ctx' || e.type === 'add') lastCtxOrAddBs = e.bs;
      }
      if (O.length === 0) {
        const at = Math.min(Math.max(h.a + d, 0), work.length);
        const written = items.map((it) => (it.kind === 'new' ? it.text : ''));
        const atEnd = at >= work.length;
        work.splice(at, 0, ...written);
        if (atEnd && written.length > 0) fin = !lastCtxOrAddBs;
        d += written.length;
        continue;
      }
      const f = findTier(work, O, strict, 0);
      if (!f) throw new Fail('no-match', oldP);
      const target = h.a - 1 + d;
      let pos = f.positions[0]!;
      for (const p of f.positions) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const written = writeItems(items, work, pos, f.tier, O);
      const runsToEnd = pos + O.length === work.length;
      work.splice(pos, O.length, ...written);
      if (runsToEnd) fin = !lastCtxOrAddBs;
      d += written.length - O.length;
    }
    const text = joinParts(work, parts.br, fin);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = unifiedSections(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks -----------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  type Block = { path: string; oldL: string[]; newL: string[] };
  const blocks: Block[] = [];
  let prevEnd = 0;
  let prevPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | undefined;
      for (let k = i - 1; k >= prevEnd; k--) {
        const t = lines[k]!;
        if (!blank(t) && !t.trim().startsWith('```')) { path = t.trim(); break; }
      }
      if (path === undefined) {
        if (prevPath !== undefined) path = prevPath;
        else throw new Exit2(`error: parse ${searchLine}`);
      }
      let j = i + 1;
      while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
      if (j >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
      let k = j + 1;
      while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
      if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
      blocks.push({ path, oldL: lines.slice(i + 1, j), newL: lines.slice(j + 1, k) });
      prevPath = path;
      prevEnd = k + 1;
      i = k + 1;
      continue;
    }
    i++;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldL.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newL.length === 0 ? '' : b.newL.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const parts = fileParts(before);
    const f = findTier(parts.lines, b.oldL, strict, 0);
    if (!f) throw new Fail('no-match', b.path);
    if (f.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = f.positions[0]!;
    const written = writeNewLines(b.newL, parts.lines, pos, f.tier, b.oldL);
    const out = [...parts.lines.slice(0, pos), ...written, ...parts.lines.slice(pos + b.oldL.length)];
    tree.now.set(b.path, joinParts(out, parts.br, parts.final));
  });
}

// ---- Section 8: V4A patches -----------------------------------------------------

type VChunk = { anchor: string | null; entries: { type: 'ctx' | 'del' | 'add'; text: string }[]; eof: boolean };
type VSection = { kind: 'add' | 'del' | 'upd'; path: string; line: number; moveTo?: string; addLines: string[]; chunks: VChunk[] };

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let curBody: { line: number; text: string }[] = [];
  const closeSection = () => {
    if (!cur) return;
    while (curBody.length > 0 && blank(curBody[curBody.length - 1]!.text)) curBody.pop();
    if (cur.kind === 'add') {
      for (const b of curBody) {
        if (b.text === '') cur.addLines.push('');
        else if (b.text.startsWith('+')) cur.addLines.push(b.text.slice(1));
        else throw new Exit2(`error: parse ${b.line}`);
      }
    } else if (cur.kind === 'del') {
      for (const b of curBody) throw new Exit2(`error: parse ${b.line}`);
    } else {
      let chunk: VChunk | null = null;
      for (const b of curBody) {
        const l = b.text;
        if (l.startsWith('@@')) {
          chunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), entries: [], eof: false };
          cur.chunks.push(chunk);
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (!chunk) { chunk = { anchor: null, entries: [], eof: true }; cur.chunks.push(chunk); }
          else chunk.eof = true;
          continue;
        }
        if (l === '') {
          if (!chunk) { chunk = { anchor: null, entries: [], eof: false }; cur.chunks.push(chunk); }
          chunk.entries.push({ type: 'ctx', text: '' });
          continue;
        }
        const c = l[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          if (!chunk) { chunk = { anchor: null, entries: [], eof: false }; cur.chunks.push(chunk); }
          chunk.entries.push({ type: c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add', text: l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${b.line}`);
      }
      if (cur.chunks.length === 0 && cur.moveTo === undefined) throw new Exit2(`error: parse ${cur.line}`);
    }
    sections.push(cur);
    cur = null;
    curBody = [];
  };
  for (let i = first + 1; i < last; i++) {
    const l = lines[i]!;
    const isAdd = l.startsWith('*** Add File: ');
    const isDel = l.startsWith('*** Delete File: ');
    const isUpd = l.startsWith('*** Update File: ');
    if (isAdd || isDel || isUpd) {
      closeSection();
      cur = {
        kind: isAdd ? 'add' : isDel ? 'del' : 'upd',
        path: l.slice(l.indexOf(': ') + 2).trim(),
        line: i + 1,
        addLines: [],
        chunks: [],
      };
      curBody = [];
      continue;
    }
    if (!cur) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'upd' && curBody.length === 0 && cur.moveTo === undefined && l.startsWith('*** Move to: ')) {
      cur.moveTo = l.slice('*** Move to: '.length).trim();
      continue;
    }
    curBody.push({ line: i + 1, text: l });
  }
  closeSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => (tree: Tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.kind === 'del') {
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== undefined) {
      if (!safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    }
    const parts = fileParts(before);
    const work = [...parts.lines];
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let found = -1;
        for (const t of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < work.length; k++) {
            if (tierEq(work[k]!, chunk.anchor, t)) { found = k; break; }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', sec.path);
        cursor = found + 1;
      }
      const O: string[] = [];
      const items: NItem[] = [];
      for (const e of chunk.entries) {
        if (e.type === 'ctx') { items.push({ kind: 'ctx', oIdx: O.length }); O.push(e.text); }
        else if (e.type === 'del') O.push(e.text);
        else items.push({ kind: 'new', text: e.text });
      }
      if (O.length === 0) {
        const written = items.map((it) => (it.kind === 'new' ? it.text : ''));
        const at = chunk.eof ? work.length : Math.min(cursor, work.length);
        work.splice(at, 0, ...written);
        cursor = at + written.length;
        continue;
      }
      const f = findTier(work, O, strict, cursor, chunk.eof);
      if (!f) throw new Fail('no-match', sec.path);
      const pos = f.positions[0]!;
      const written = writeItems(items, work, pos, f.tier, O);
      work.splice(pos, O.length, ...written);
      cursor = pos + written.length;
    }
    const text = joinParts(work, parts.br, parts.final);
    if (sec.moveTo !== undefined && sec.moveTo !== sec.path) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, text);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, text);
    }
  });
}


function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moveFrom = new Map<string, string>();
  const moveTo = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null && tree.now.get(n) !== undefined) {
      moveFrom.set(o, n);
      moveTo.set(n, o);
    }
  }
  const rowObjs: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveFrom.has(p)) continue;
    if (moveTo.has(p)) rowObjs.push({ key: p, text: `R ${moveTo.get(p)!} -> ${p}` });
    else rowObjs.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  const rows: string[] = rowObjs.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
