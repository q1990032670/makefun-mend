// mend: apply an edit an AI model wrote to a tree of text files.
//
// The patch may be a unified diff, a set of SEARCH/REPLACE blocks, a V4A
// patch, or a list of JSON edit objects; SPEC.md is the contract for all
// four. Either every edit applies and the changes are written, or the
// failures are listed and nothing is written at all.
//
// Run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` with
// the working directory as the root of the tree. When MAKEFUN_ENV_URL is
// set the process is a trial agent instead, and hands over to runner.ts.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

/** The CLI proper: returns the exit code, writes only to standard output. */
function runCli(argv: string[]): number {
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  // ---- arguments (SPEC section 1) ----
  let format = 'auto';
  let checkOnly = false;
  let strict = false;
  let sawFormat = false;
  let sawCheck = false;
  let sawStrict = false;
  let usage = false;
  let afterDashDash = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (afterDashDash) {
      positional.push(arg);
    } else if (arg === '--') {
      afterDashDash = true;
    } else if (arg === '--check') {
      if (sawCheck) usage = true;
      sawCheck = true;
      checkOnly = true;
    } else if (arg === '--strict') {
      if (sawStrict) usage = true;
      sawStrict = true;
      strict = true;
    } else if (arg.startsWith('--format=')) {
      if (sawFormat) usage = true;
      sawFormat = true;
      const value = arg.slice('--format='.length);
      if (value === 'auto' || value === 'unified' || value === 'search-replace' || value === 'v4a' || value === 'json') {
        format = value;
      } else {
        usage = true;
      }
    } else if (arg.startsWith('-') && arg !== '-') {
      usage = true;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) usage = true;
  if (usage) {
    out('error: usage');
    return 2;
  }

  // ---- the patch text ----
  let patchText: string;
  const patchArg = positional.length === 1 ? positional[0] : null;
  if (patchArg === null || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      out('error: no-patch');
      return 2;
    }
  }
  const lines = patchLines(patchText);

  // ---- its format (SPEC section 4) ----
  let formatName = format;
  if (formatName === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) {
      out('error: format');
      return 2;
    }
    formatName = detected;
  }

  // ---- read it as that format; a parse fault ends the run ----
  let edits: Edit[];
  try {
    if (formatName === 'unified') edits = parseUnified(lines);
    else if (formatName === 'search-replace') edits = parseSearchReplace(lines);
    else if (formatName === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(patchText, lines);
  } catch (err) {
    if (err instanceof ParseFault) {
      out(`error: parse ${err.line}`);
      return 2;
    }
    throw err;
  }

  // ---- apply the edits, in order, to a virtual tree (SPEC section 10) ----
  const tree = new Tree();
  const failures: Failure[] = [];
  const moves: { from: string; to: string }[] = [];
  for (const edit of edits) {
    let failure: Failure | null = null;
    for (const p of editPaths(edit)) {
      if (!isSafePath(p)) {
        failure = { code: 'unsafe', path: p };
        break;
      }
    }
    if (failure === null) failure = applyEdit(edit, tree, strict);
    if (failure !== null) {
      failures.push(failure);
    } else {
      const mv = moveOf(edit);
      if (mv !== null) moves.push(mv);
    }
  }
  if (failures.length > 0) {
    for (const f of failures) out(`error: ${f.code} ${f.path}`);
    out(`failed: ${failures.length} of ${edits.length} edits`);
    return 1;
  }

  // ---- report what changed, then write it (SPEC section 2) ----
  const report = changeReport(tree, moves);
  if (!checkOnly) tree.flush();
  for (const line of report) out(line);
  out(report.length === 1 ? 'ok: 1 file' : `ok: ${report.length} files`);
  return 0;
}

/** One report line per path whose state changed, in UTF-8 byte order. */
function changeReport(tree: Tree, moves: { from: string; to: string }[]): string[] {
  const lines: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const m of moves) {
    const wasThere = tree.original(m.from) !== null;
    const fromGone = tree.current(m.from) === null;
    const toWasFree = tree.original(m.to) === null;
    const toThere = tree.current(m.to) !== null;
    if (wasThere && fromGone && toWasFree && toThere) {
      lines.push({ key: m.to, text: `R ${m.from} -> ${m.to}` });
      covered.add(m.from);
      covered.add(m.to);
    }
  }
  for (const p of tree.touched()) {
    if (covered.has(p)) continue;
    const before = tree.original(p);
    const after = tree.current(p);
    if (before === after) continue;
    if (before === null) lines.push({ key: p, text: `A ${p}` });
    else if (after === null) lines.push({ key: p, text: `D ${p}` });
    else lines.push({ key: p, text: `M ${p}` });
  }
  lines.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  return lines.map((l) => l.text);
}

// ---------------------------------------------------------------- text rules

/** A parse fault in the patch: the 1-based number of the patch line at fault. */
class ParseFault extends Error {
  line: number;
  constructor(line: number) {
    super(`parse fault at patch line ${line}`);
    this.line = line;
  }
}

/** Trailing spaces and tabs removed (the marker comparisons of SPEC 7). */
function rstripWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

/** Leading spaces and tabs removed. */
function lstripWs(s: string): string {
  return s.replace(/^[ \t]+/, '');
}

/** Both ends' spaces and tabs removed. */
function trimWs(s: string): string {
  return lstripWs(rstripWs(s));
}

/** The leading spaces and tabs of a line (its indent). */
function indentOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** True when the line is empty or only spaces and tabs. */
function isBlankWs(s: string): boolean {
  return /^[ \t]*$/.test(s);
}

/**
 * A patch's lines (SPEC 3): its text split at line feeds, each line with one
 * trailing carriage return removed, and no empty piece after a final feed.
 */
function patchLines(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/**
 * The lines of a JSON insert's new_str (SPEC 9): split like patch lines,
 * except that an empty string has no lines at all.
 */
function insertedLines(text: string): string[] {
  if (text === '') return [];
  return patchLines(text);
}

/** A safe path (SPEC 3): relative, no backslash, no empty, dot or dot-dot part. */
function isSafePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false;
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ------------------------------------------------------------ files as lines

/** A file viewed as lines: its own break, and whether it ends with one. */
interface FileShape {
  lines: string[];
  br: string;
  endsBreak: boolean;
}

/** A file's break (SPEC 3): CRLF when its first line feed follows a CR. */
function breakOf(text: string): string {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

function splitFile(text: string): FileShape {
  const br = breakOf(text);
  if (text === '') return { lines: [], br, endsBreak: false };
  const parts = text.split(br);
  let endsBreak = false;
  if (parts[parts.length - 1] === '') {
    endsBreak = true;
    parts.pop();
  }
  return { lines: parts, br, endsBreak };
}

function joinFile(shape: FileShape): string {
  if (shape.lines.length === 0) return '';
  return shape.lines.join(shape.br) + (shape.endsBreak ? shape.br : '');
}

/**
 * The tree as the patch leaves it: file texts are read from the working
 * directory on first use and changed in memory only, so a run that fails
 * anywhere writes nothing, and a --check run writes nothing either.
 */
class Tree {
  private before = new Map<string, string | null>();
  private after = new Map<string, string | null>();

  private load(path: string): void {
    if (this.before.has(path)) return;
    let text: string | null = null;
    try {
      const full = join(process.cwd(), path);
      if (statSync(full).isFile()) text = readFileSync(full, 'utf8');
    } catch {
      text = null;
    }
    this.before.set(path, text);
    this.after.set(path, text);
  }

  /** The text a path held before the patch (null: it did not exist). */
  original(path: string): string | null {
    this.load(path);
    return this.before.get(path) ?? null;
  }

  /** The text a path holds now, edits so far applied. */
  current(path: string): string | null {
    this.load(path);
    return this.after.get(path) ?? null;
  }

  exists(path: string): boolean {
    return this.current(path) !== null;
  }

  set(path: string, text: string): void {
    this.load(path);
    this.after.set(path, text);
  }

  remove(path: string): void {
    this.load(path);
    this.after.set(path, null);
  }

  /** Every path any edit has looked at. */
  touched(): string[] {
    return [...this.after.keys()];
  }

  /** Write the differences to the working directory. */
  flush(): void {
    for (const path of this.touched()) {
      const was = this.before.get(path) ?? null;
      const is = this.after.get(path) ?? null;
      if (was === is) continue;
      const full = join(process.cwd(), path);
      if (is === null) {
        rmSync(full, { force: true });
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, is, 'utf8');
      }
    }
  }
}

// ------------------------------------------------------------- line matching

/** One line of a hunk or chunk body: context, removed, added, or a `\` note. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'note';
  text: string;
  /** True when the body line was a literally empty patch line. */
  bare?: boolean;
}

/** Equality at a matching tier (SPEC 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripWs(a) === rstripWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every position at which `old` occurs in `lines` at the given tier. */
function occurrences(lines: string[], old: string[], tier: number): number[] {
  const found: number[] = [];
  if (old.length === 0 || old.length > lines.length) return found;
  scan: for (let i = 0; i + old.length <= lines.length; i += 1) {
    for (let j = 0; j < old.length; j += 1) {
      if (!lineEq(lines[i + j], old[j], tier)) continue scan;
    }
    found.push(i);
  }
  return found;
}

interface Match {
  tier: number;
  at: number[];
}

/** The first tier at which `old` occurs at all, and its positions there. */
function findMatch(lines: string[], old: string[], strict: boolean): Match | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(lines, old, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** The tier-2 re-indent of one written line (SPEC 5); a no-op at tiers 0-1. */
function reindent(line: string, tier: number, fromIndent: string, toIndent: string): string {
  if (tier !== 2) return line;
  if (isBlankWs(line)) return line;
  if (!line.startsWith(fromIndent)) return line;
  return toIndent + line.slice(fromIndent.length);
}

/**
 * The lines a matched hunk or chunk writes (SPEC 5): context lines come
 * from the file itself, added lines are re-indented at tier 2.
 */
function renderNew(body: BodyLine[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  let fromIndent = '';
  for (const b of body) {
    if (b.kind !== 'add') {
      fromIndent = indentOf(b.text);
      break;
    }
  }
  const toIndent = pos < fileLines.length ? indentOf(fileLines[pos]) : '';
  for (const b of body) {
    if (b.kind === 'del') {
      oi += 1;
    } else if (b.kind === 'ctx') {
      out.push(fileLines[pos + oi]);
      oi += 1;
    } else if (b.kind === 'add') {
      out.push(reindent(b.text, tier, fromIndent, toIndent));
    }
  }
  return out;
}

/** The old lines a body names: its context and removed lines, in order. */
function oldOf(body: BodyLine[]): string[] {
  return body.filter((b) => b.kind === 'ctx' || b.kind === 'del').map((b) => b.text);
}

/** The added lines of a body, in order. */
function addedOf(body: BodyLine[]): string[] {
  return body.filter((b) => b.kind === 'add').map((b) => b.text);
}

/**
 * Whether a `\` note follows the body's last context or added line, which
 * is how a hunk says the file does not end with a line break (SPEC 6).
 */
function noteAfterLastWritten(body: BodyLine[]): boolean {
  let last = -1;
  body.forEach((b, i) => {
    if (b.kind === 'ctx' || b.kind === 'add') last = i;
  });
  if (last < 0) return false;
  return last + 1 < body.length && body[last + 1].kind === 'note';
}

// ------------------------------------------------------------------- edits

/** A failed edit: its code, and the path the failure concerns (SPEC 2). */
interface Failure {
  code: string;
  path: string;
}

interface UnifiedEdit {
  kind: 'unified';
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: { a: number; body: BodyLine[] }[];
}

interface SearchReplaceEdit {
  kind: 'search-replace';
  path: string;
  oldLines: string[];
  newLines: string[];
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

type Edit =
  | UnifiedEdit
  | SearchReplaceEdit
  | { kind: 'v4a-add'; path: string; lines: string[] }
  | { kind: 'v4a-delete'; path: string }
  | { kind: 'v4a-update'; path: string; moveTo: string | null; chunks: V4aChunk[] }
  | { kind: 'json-create'; path: string; text: string }
  | { kind: 'json-replace'; path: string; oldStr: string; newStr: string }
  | { kind: 'json-insert'; path: string; at: number; text: string };

/** Every path an edit names, in the order they are safety-checked. */
function editPaths(edit: Edit): string[] {
  switch (edit.kind) {
    case 'unified':
      if (edit.creation) return edit.newPath === null ? [] : [edit.newPath];
      if (edit.deletion) return edit.oldPath === null ? [] : [edit.oldPath];
      return [edit.oldPath as string, edit.newPath as string];
    case 'v4a-update':
      return edit.moveTo === null ? [edit.path] : [edit.path, edit.moveTo];
    default:
      return [edit.path];
  }
}

/** The move an edit makes when it succeeds, for the `R` report line. */
function moveOf(edit: Edit): { from: string; to: string } | null {
  if (edit.kind === 'unified' && !edit.creation && !edit.deletion && edit.oldPath !== null && edit.newPath !== null && edit.oldPath !== edit.newPath) {
    return { from: edit.oldPath, to: edit.newPath };
  }
  if (edit.kind === 'v4a-update' && edit.moveTo !== null && edit.moveTo !== edit.path) {
    return { from: edit.path, to: edit.moveTo };
  }
  return null;
}

/** Apply one edit to the tree; a Failure says why it changed nothing. */
function applyEdit(edit: Edit, tree: Tree, strict: boolean): Failure | null {
  switch (edit.kind) {
    case 'unified':
      return applyUnified(edit, tree, strict);
    case 'search-replace':
      return applySearchReplace(edit, tree, strict);
    case 'v4a-add': {
      if (tree.exists(edit.path)) return { code: 'exists', path: edit.path };
      tree.set(edit.path, joinFile({ lines: [...edit.lines], br: '\n', endsBreak: true }));
      return null;
    }
    case 'v4a-delete': {
      if (!tree.exists(edit.path)) return { code: 'missing', path: edit.path };
      tree.remove(edit.path);
      return null;
    }
    case 'v4a-update':
      return applyV4aUpdate(edit, tree, strict);
    case 'json-create': {
      if (tree.exists(edit.path)) return { code: 'exists', path: edit.path };
      tree.set(edit.path, edit.text);
      return null;
    }
    case 'json-replace':
      return applyJsonReplace(edit, tree);
    case 'json-insert':
      return applyJsonInsert(edit, tree);
  }
}

// --------------------------------------------------------- format detection

/** Detect the patch's format (SPEC 4), or null when none fits. */
function detectFormat(lines: string[]): string | null {
  const first = lines.find((l) => !isBlankWs(l));
  if (first !== undefined) {
    if (trimWs(first) === '*** Begin Patch') return 'v4a';
    const head = lstripWs(first);
    if (head.startsWith('[') || head.startsWith('{')) return 'json';
  }
  if (lines.some((l) => rstripWs(l) === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ------------------------------------------------------------ unified diffs

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  headOld: string | null | undefined;
  headNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  seenPair: boolean;
  inHeader: boolean;
  hunks: { a: number; body: BodyLine[] }[];
}

function newSection(): Section {
  return {
    gitOld: null,
    gitNew: null,
    headOld: undefined,
    headNew: undefined,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    delFile: false,
    seenPair: false,
    inHeader: true,
    hunks: [],
  };
}

/** A `---` or `+++` header path: up to the first tab, spaces removed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0].trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** Read a unified diff into its section edits (SPEC 6). */
function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let sec: Section | null = null;
  let bodyOpen = false;

  const endBody = (): void => {
    if (!bodyOpen || sec === null || sec.hunks.length === 0) {
      bodyOpen = false;
      return;
    }
    const body = sec.hunks[sec.hunks.length - 1].body;
    while (body.length > 0) {
      const last = body[body.length - 1];
      if (last.kind === 'ctx' && last.bare === true) body.pop();
      else break;
    }
    bodyOpen = false;
  };

  const finishSection = (): void => {
    endBody();
    if (sec === null) return;
    const oldPath = sec.headOld !== undefined ? sec.headOld : (sec.renameFrom ?? sec.gitOld);
    const newPath = sec.headNew !== undefined ? sec.headNew : (sec.renameTo ?? sec.gitNew);
    let creation = false;
    let deletion = false;
    if (sec.newFile || (oldPath === null && newPath !== null)) creation = true;
    else if (sec.delFile || (newPath === null && oldPath !== null)) deletion = true;
    edits.push({
      kind: 'unified',
      oldPath,
      newPath,
      creation,
      deletion,
      hunks: sec.hunks,
    });
    sec = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*?) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseFault(lineNo);
      finishSection();
      sec = newSection();
      sec.gitOld = m[1];
      sec.gitNew = m[2];
      continue;
    }

    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (sec !== null && sec.inHeader && !sec.seenPair) {
        endBody();
        sec.headOld = headerPath(line);
        sec.headNew = headerPath(lines[i + 1]);
        sec.seenPair = true;
      } else {
        finishSection();
        sec = newSection();
        sec.headOld = headerPath(line);
        sec.headNew = headerPath(lines[i + 1]);
        sec.seenPair = true;
      }
      i += 1;
      continue;
    }

    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null || sec === null) throw new ParseFault(lineNo);
      endBody();
      sec.hunks.push({ a: Number.parseInt(m[1], 10), body: [] });
      sec.inHeader = false;
      bodyOpen = true;
      continue;
    }

    if (bodyOpen && sec !== null && (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\'))) {
      const body = sec.hunks[sec.hunks.length - 1].body;
      if (line === '') body.push({ kind: 'ctx', text: '', bare: true });
      else if (line.startsWith(' ')) body.push({ kind: 'ctx', text: line.slice(1) });
      else if (line.startsWith('-')) body.push({ kind: 'del', text: line.slice(1) });
      else if (line.startsWith('+')) body.push({ kind: 'add', text: line.slice(1) });
      else body.push({ kind: 'note', text: line });
      continue;
    }

    endBody();
    if (sec !== null && sec.inHeader) {
      if (line.startsWith('--- ')) throw new ParseFault(lineNo + 1);
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.delFile = true;
      // Every other header line is ignored, as are lines anywhere else
      // outside a hunk body (prose, code fences).
    }
  }
  finishSection();
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

/** Apply one unified section (SPEC 6). */
function applyUnified(edit: UnifiedEdit, tree: Tree, strict: boolean): Failure | null {
  if (edit.creation) {
    const target = edit.newPath ?? edit.oldPath;
    if (target === null) return { code: 'unsafe', path: '' };
    if (tree.exists(target)) return { code: 'exists', path: target };
    const fileLines: string[] = [];
    let noBreak = false;
    for (const h of edit.hunks) {
      h.body.forEach((b, idx) => {
        if (b.kind === 'add') {
          fileLines.push(b.text);
          noBreak = idx + 1 < h.body.length && h.body[idx + 1].kind === 'note';
        }
      });
    }
    tree.set(target, joinFile({ lines: fileLines, br: '\n', endsBreak: !noBreak }));
    return null;
  }
  if (edit.deletion) {
    const target = edit.oldPath ?? edit.newPath;
    if (target === null) return { code: 'unsafe', path: '' };
    if (!tree.exists(target)) return { code: 'missing', path: target };
    tree.remove(target);
    return null;
  }
  const oldPath = edit.oldPath as string;
  const newPath = edit.newPath as string;
  const text = tree.current(oldPath);
  if (text === null) return { code: 'missing', path: oldPath };
  if (newPath !== oldPath && tree.exists(newPath)) return { code: 'exists', path: newPath };
  const shape = splitFile(text);
  const lines = [...shape.lines];
  let endsBreak = shape.endsBreak;
  let d = 0;
  for (const h of edit.hunks) {
    const old = oldOf(h.body);
    if (old.length === 0) {
      const adds = addedOf(h.body);
      const pos = Math.min(h.a + d, lines.length);
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...adds);
      if (atEnd && h.body.some((b) => b.kind === 'add')) {
        endsBreak = !noteAfterLastWritten(h.body);
      }
      d += adds.length;
      continue;
    }
    const match = findMatch(lines, old, strict);
    if (match === null) return { code: 'no-match', path: oldPath };
    const targetPos = h.a - 1 + d;
    let pos = match.at[0];
    for (const cand of match.at) {
      if (Math.abs(cand - targetPos) < Math.abs(pos - targetPos)) pos = cand;
    }
    const runsToEnd = pos + old.length === lines.length;
    const rendered = renderNew(h.body, lines, pos, match.tier);
    lines.splice(pos, old.length, ...rendered);
    if (runsToEnd && h.body.some((b) => b.kind === 'ctx' || b.kind === 'add')) {
      endsBreak = !noteAfterLastWritten(h.body);
    }
    d += rendered.length - old.length;
  }
  const outText = joinFile({ lines, br: shape.br, endsBreak });
  if (newPath !== oldPath) {
    tree.set(newPath, outText);
    tree.remove(oldPath);
  } else {
    tree.set(oldPath, outText);
  }
  return null;
}

// --------------------------------------------------------- SEARCH/REPLACE

/** Read SEARCH/REPLACE blocks into edits (SPEC 7). */
function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (rstripWs(lines[i]) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const start = i;
    let mid = start + 1;
    while (mid < lines.length && rstripWs(lines[mid]) !== '=======') mid += 1;
    if (mid >= lines.length) throw new ParseFault(start + 1);
    let end = mid + 1;
    while (end < lines.length && rstripWs(lines[end]) !== '>>>>>>> REPLACE') end += 1;
    if (end >= lines.length) throw new ParseFault(start + 1);
    let path: string | null = null;
    for (let t = start - 1; t >= searchFrom; t -= 1) {
      const cand = lines[t].trim();
      if (cand === '' || cand.startsWith('```')) continue;
      path = cand;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(start + 1);
      path = prevPath;
    }
    edits.push({
      kind: 'search-replace',
      path,
      oldLines: lines.slice(start + 1, mid),
      newLines: lines.slice(mid + 1, end),
    });
    prevPath = path;
    searchFrom = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

/** Apply one SEARCH/REPLACE block (SPEC 7). */
function applySearchReplace(edit: SearchReplaceEdit, tree: Tree, strict: boolean): Failure | null {
  if (edit.oldLines.length === 0) {
    if (tree.exists(edit.path)) return { code: 'exists', path: edit.path };
    tree.set(edit.path, joinFile({ lines: [...edit.newLines], br: '\n', endsBreak: true }));
    return null;
  }
  const text = tree.current(edit.path);
  if (text === null) return { code: 'missing', path: edit.path };
  const shape = splitFile(text);
  const match = findMatch(shape.lines, edit.oldLines, strict);
  if (match === null) return { code: 'no-match', path: edit.path };
  if (match.at.length > 1) return { code: 'ambiguous', path: edit.path };
  const pos = match.at[0];
  const fromIndent = indentOf(edit.oldLines[0]);
  const toIndent = indentOf(shape.lines[pos]);
  const rendered = edit.newLines.map((l) => reindent(l, match.tier, fromIndent, toIndent));
  const lines = [...shape.lines];
  lines.splice(pos, edit.oldLines.length, ...rendered);
  tree.set(edit.path, joinFile({ lines, br: shape.br, endsBreak: shape.endsBreak }));
  return null;
}

// --------------------------------------------------------------------- V4A

/** Read a V4A patch into its section edits (SPEC 8). */
function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlankWs(lines[i])) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) throw new ParseFault(1);
  if (trimWs(lines[first]) !== '*** Begin Patch') throw new ParseFault(first + 1);
  if (trimWs(lines[last]) !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlankWs(line)) {
      i += 1;
      continue;
    }
    let type: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      type = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      type = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      type = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new ParseFault(i + 1);
    }
    const headerLine = i + 1;
    // The section's content runs to the next section header or the end.
    let j = i + 1;
    const content: { line: string; no: number }[] = [];
    while (j < last) {
      const l = lines[j];
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      content.push({ line: l, no: j + 1 });
      j += 1;
    }
    while (content.length > 0 && isBlankWs(content[content.length - 1].line)) content.pop();

    if (type === 'add') {
      const fileLines: string[] = [];
      for (const c of content) {
        if (c.line.startsWith('+')) fileLines.push(c.line.slice(1));
        else if (c.line === '') fileLines.push('');
        else throw new ParseFault(c.no);
      }
      edits.push({ kind: 'v4a-add', path, lines: fileLines });
    } else if (type === 'delete') {
      if (content.length > 0) throw new ParseFault(content[0].no);
      edits.push({ kind: 'v4a-delete', path });
    } else {
      edits.push(parseV4aUpdate(path, headerLine, content));
    }
    i = j;
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

/** Read one V4A Update File section's content: an optional move, then chunks. */
function parseV4aUpdate(
  path: string,
  headerLine: number,
  content: { line: string; no: number }[],
): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (content.length > 0 && content[0].line.startsWith('*** Move to: ')) {
    moveTo = content[0].line.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let chunk: V4aChunk | null = null;
  let chunkClosed = false;
  for (; idx < content.length; idx += 1) {
    const { line, no } = content[idx];
    if (line.startsWith('@@')) {
      chunk = { anchor: trimWs(line.slice(2)) === '' ? null : trimWs(line.slice(2)), eof: false, body: [] };
      chunks.push(chunk);
      chunkClosed = false;
    } else if (line === '*** End of File') {
      if (chunk === null || chunkClosed) throw new ParseFault(no);
      chunk.eof = true;
      chunkClosed = true;
    } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
      if (chunk === null) {
        if (chunks.length > 0) throw new ParseFault(no);
        chunk = { anchor: null, eof: false, body: [] };
        chunks.push(chunk);
      }
      if (chunkClosed) throw new ParseFault(no);
      if (line === '') chunk.body.push({ kind: 'ctx', text: '' });
      else if (line.startsWith(' ')) chunk.body.push({ kind: 'ctx', text: line.slice(1) });
      else if (line.startsWith('-')) chunk.body.push({ kind: 'del', text: line.slice(1) });
      else chunk.body.push({ kind: 'add', text: line.slice(1) });
    } else {
      throw new ParseFault(no);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseFault(headerLine);
  return { kind: 'v4a-update', path, moveTo, chunks };
}

/** Apply one V4A Update File section (SPEC 8). */
function applyV4aUpdate(
  edit: { kind: 'v4a-update'; path: string; moveTo: string | null; chunks: V4aChunk[] },
  tree: Tree,
  strict: boolean,
): Failure | null {
  const text = tree.current(edit.path);
  if (text === null) return { code: 'missing', path: edit.path };
  if (edit.moveTo !== null && edit.moveTo !== edit.path && tree.exists(edit.moveTo)) {
    return { code: 'exists', path: edit.moveTo };
  }
  const shape = splitFile(text);
  const lines = [...shape.lines];
  const tiers = strict ? [0] : [0, 1, 2];
  let cursor = 0;
  for (const chunk of edit.chunks) {
    if (chunk.anchor !== null) {
      let found = -1;
      for (const tier of tiers) {
        for (let i = cursor; i < lines.length; i += 1) {
          if (lineEq(lines[i], chunk.anchor, tier)) {
            found = i;
            break;
          }
        }
        if (found >= 0) break;
      }
      if (found < 0) return { code: 'no-match', path: edit.path };
      cursor = found + 1;
    }
    const old = oldOf(chunk.body);
    if (old.length === 0) {
      const adds = addedOf(chunk.body);
      const pos = chunk.eof ? lines.length : Math.min(cursor, lines.length);
      lines.splice(pos, 0, ...adds);
      cursor = pos + adds.length;
      continue;
    }
    let chosen: { tier: number; pos: number } | null = null;
    for (const tier of tiers) {
      const all = occurrences(lines, old, tier).filter((p) => p >= cursor);
      const cands = chunk.eof ? all.filter((p) => p + old.length === lines.length) : all;
      if (cands.length > 0) {
        chosen = { tier, pos: cands[0] };
        break;
      }
    }
    if (chosen === null) return { code: 'no-match', path: edit.path };
    const rendered = renderNew(chunk.body, lines, chosen.pos, chosen.tier);
    lines.splice(chosen.pos, old.length, ...rendered);
    cursor = chosen.pos + rendered.length;
  }
  const outText = joinFile({ lines, br: shape.br, endsBreak: shape.endsBreak });
  if (edit.moveTo !== null && edit.moveTo !== edit.path) {
    tree.set(edit.moveTo, outText);
    tree.remove(edit.path);
  } else {
    tree.set(edit.path, outText);
  }
  return null;
}

// -------------------------------------------------------------------- JSON

/** Read JSON edits (SPEC 9): one array of objects, or one object a line. */
function parseJson(text: string, lines: string[]): Edit[] {
  if (text.trim().startsWith('[')) {
    let startLine = 1;
    for (let i = 0; i < lines.length; i += 1) {
      if (!isBlankWs(lines[i])) {
        startLine = i + 1;
        break;
      }
    }
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new ParseFault(startLine);
    }
    if (!Array.isArray(arr)) throw new ParseFault(startLine);
    if (arr.length === 0) throw new ParseFault(1);
    return arr.map((o) => jsonEdit(o, startLine));
  }
  const edits: Edit[] = [];
  lines.forEach((line, idx) => {
    if (line.trim() === '') return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new ParseFault(idx + 1);
    }
    edits.push(jsonEdit(obj, idx + 1));
  });
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

/** Validate one JSON edit object; any fault is a parse fault at its line. */
function jsonEdit(obj: unknown, lineNo: number): Edit {
  const bad = (): ParseFault => new ParseFault(lineNo);
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw bad();
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') throw bad();
  const path = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw bad();
    return { kind: 'json-create', path, text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw bad();
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw bad();
    return { kind: 'json-replace', path, oldStr: o.old_str, newStr: o.new_str === undefined ? '' : o.new_str };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw bad();
    if (typeof o.new_str !== 'string') throw bad();
    return { kind: 'json-insert', path, at: o.insert_line, text: o.new_str };
  }
  throw bad();
}

/** How many times `needle` occurs in `haystack`, positions allowed to overlap. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + 1;
  }
}

/** Apply a JSON str_replace (SPEC 9): exact, exactly once, CRLF-aware. */
function applyJsonReplace(
  edit: { kind: 'json-replace'; path: string; oldStr: string; newStr: string },
  tree: Tree,
): Failure | null {
  const text = tree.current(edit.path);
  if (text === null) return { code: 'missing', path: edit.path };
  const crlf = breakOf(text) === '\r\n';
  const flat = (s: string): string => (crlf ? s.replace(/\r\n/g, '\n') : s);
  const hay = flat(text);
  const needle = flat(edit.oldStr);
  const count = countOccurrences(hay, needle);
  if (count === 0) return { code: 'no-match', path: edit.path };
  if (count > 1) return { code: 'ambiguous', path: edit.path };
  const at = hay.indexOf(needle);
  const joined = hay.slice(0, at) + flat(edit.newStr) + hay.slice(at + needle.length);
  tree.set(edit.path, crlf ? joined.replace(/\n/g, '\r\n') : joined);
  return null;
}

/** Apply a JSON insert (SPEC 9): new lines after line `at` of the file. */
function applyJsonInsert(
  edit: { kind: 'json-insert'; path: string; at: number; text: string },
  tree: Tree,
): Failure | null {
  const text = tree.current(edit.path);
  if (text === null) return { code: 'missing', path: edit.path };
  const shape = splitFile(text);
  if (edit.at < 0 || edit.at > shape.lines.length) return { code: 'no-match', path: edit.path };
  const lines = [...shape.lines];
  lines.splice(edit.at, 0, ...insertedLines(edit.text));
  tree.set(edit.path, joinFile({ lines, br: shape.br, endsBreak: shape.endsBreak }));
  return null;
}

// -------------------------------------------------------------------- entry

// This dispatch runs last on purpose: the module's classes are only
// initialized once the whole file has been evaluated, and runCli uses them.
const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  await runTrial(envUrl);
} else {
  process.exitCode = runCli(process.argv.slice(2));
}
