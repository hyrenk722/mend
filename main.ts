// main.ts is mend, the CLI SPEC.md specifies. It does sections 1 to 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, matching lines at three tiers, unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing
// write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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

/** Moves recorded by edits that succeeded, for the R output rows (section 2). */
const recordedMoves: Array<[string, string]> = [];

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

// ---- Section 3: a file as lines, its own line break, and whether it ends with one. ----

interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---- Section 5: matching lines at three tiers. ----

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions i where O matches lines[i..], at tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number, endAtLast: boolean): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    if (endAtLast && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions, or null. */
function findTier(lines: string[], o: string[], strict: boolean, from: number, endAtLast: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from, endAtLast);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/**
 * The replacement lines for an occurrence at pos: a context line is written as the file's own matched line,
 * every other line of N is written as it is, except at tier 2 where a line that starts with P (the leading
 * spaces/tabs of O's first line) has that P replaced by F (the leading spaces/tabs of the file's first
 * matched line). Empty and whitespace-only lines are never re-indented.
 */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const f = pos < fileLines.length ? leadingWs(fileLines[pos]!) : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  return n.map((nl) => {
    if (nl.ctx) return fileLines[pos + nl.oIdx]!;
    if (tier !== 2) return nl.text;
    if (nl.text === '' || /^[ \t]+$/.test(nl.text)) return nl.text;
    if (nl.text.startsWith(p)) return f + nl.text.slice(p.length);
    return nl.text;
  });
}

interface BodyParts {
  o: string[];
  n: NLine[];
  backslashAfterLast: boolean;
}

/** Split a hunk/chunk body into old lines O, new lines N, and whether a `\` line follows the last context or `+` line. */
function splitBody(body: string[]): BodyParts {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastCtxPlus = -1;
  body.forEach((l, i) => {
    if (l.startsWith(' ') || l === '') {
      const text = l === '' ? '' : l.slice(1);
      o.push(text);
      n.push({ text, ctx: true, oIdx: o.length - 1 });
      lastCtxPlus = i;
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
      lastCtxPlus = i;
    }
  });
  const backslashAfterLast = lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1]!.startsWith('\\');
  return { o, n, backslashAfterLast };
}

// ---- Section 6: unified diffs. ----

interface Hunk {
  a: number;
  body: string[];
}

interface UnifiedSection {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null | undefined;
  headNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseHeaderPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  return stripAB(p);
}

function resolveSection(s: UnifiedSection): { oldP: string | null; newP: string | null } {
  const oldP = s.headOld !== undefined ? s.headOld : s.renOld !== undefined ? s.renOld : s.diffOld;
  const newP = s.headNew !== undefined ? s.headNew : s.renNew !== undefined ? s.renNew : s.diffNew;
  return { oldP, newP };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  const startSection = (diffOld: string | null, diffNew: string | null): UnifiedSection => {
    const s: UnifiedSection = {
      diffOld,
      diffNew,
      headOld: undefined,
      headNew: undefined,
      renOld: undefined,
      renNew: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = diffRe.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      const next = lines[i + 1];
      const followed = next !== undefined && next.startsWith('+++ ');
      if (cur !== null && inHeader) {
        if (!followed) throw new Exit2(`error: parse ${i + 2}`);
        cur.headOld = parseHeaderPath(l);
        cur.headNew = parseHeaderPath(next!);
        i += 2;
        continue;
      }
      if (followed) {
        const s = startSection(null, null);
        s.headOld = parseHeaderPath(l);
        s.headNew = parseHeaderPath(next!);
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\') || b === '') {
          body.push(b);
          i++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a, body });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('+++ ')) {
        cur.headNew = parseHeaderPath(l);
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renOld = stripAB(l.slice('rename from '.length).trim());
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renNew = stripAB(l.slice('rename to '.length).trim());
        i++;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Apply one hunk to a file state; d is the net line delta of this section's hunks applied so far. */
function applyUnifiedHunk(f: FileState, h: Hunk, d: number, strict: boolean, errPath: string): { file: FileState; delta: number } {
  const parts = splitBody(h.body);
  const o = parts.o;
  const n = parts.n;
  if (o.length === 0) {
    const at = Math.min(Math.max(h.a + d, 0), f.lines.length);
    const ins = n.map((x) => x.text);
    const lines = [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)];
    const final = at === f.lines.length ? !parts.backslashAfterLast : f.final;
    return { file: { br: f.br, lines, final }, delta: n.length };
  }
  const found = findTier(f.lines, o, strict, 0, false);
  if (!found) throw new Fail('no-match', errPath);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  for (const p of found.occ) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const rep = buildReplacement(f.lines, best, o, n, found.tier);
  const lines = [...f.lines.slice(0, best), ...rep, ...f.lines.slice(best + o.length)];
  const runsToEnd = best + o.length === f.lines.length;
  const final = runsToEnd ? !parts.backslashAfterLast : f.final;
  return { file: { br: f.br, lines, final }, delta: n.length - o.length };
}

function unifiedSectionEdit(s: UnifiedSection, strict: boolean): Edit {
  const { oldP, newP } = resolveSection(s);
  const isCreate = oldP === null || s.newFile;
  const isDelete = newP === null || s.deletedFile;
  if (isCreate) {
    return (tree) => {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noBreak = false;
      for (const h of s.hunks) {
        let lastPlus = -1;
        h.body.forEach((l, idx) => {
          if (l.startsWith('+')) lastPlus = idx;
        });
        if (lastPlus >= 0) noBreak = lastPlus + 1 < h.body.length && h.body[lastPlus + 1]!.startsWith('\\');
        for (const l of h.body) if (l.startsWith('+')) plus.push(l.slice(1));
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
    };
  }
  if (isDelete) {
    return (tree) => {
      if (!safe(oldP!)) throw new Fail('unsafe', oldP!);
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      tree.now.set(oldP!, null);
    };
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      let f = parseFile(before);
      let d = 0;
      for (const h of s.hunks) {
        const r = applyUnifiedHunk(f, h, d, strict, oldP);
        f = r.file;
        d += r.delta;
      }
      tree.now.set(newP, renderFile(f));
      tree.now.set(oldP, null);
      recordedMoves.push([oldP, newP]);
    };
  }
  const p = (oldP ?? newP)!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    let f = parseFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const r = applyUnifiedHunk(f, h, d, strict, p);
      f = r.file;
      d += r.delta;
    }
    tree.now.set(p, renderFile(f));
  };
}

// ---- Section 7: SEARCH/REPLACE blocks. ----

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const s = i;
      let path: string | null = null;
      for (let j = s - 1; j > prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${s + 1}`);
      let eq = -1;
      for (let j = s + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      }
      if (eq === -1) throw new Exit2(`error: parse ${s + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
      blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
      continue;
    }
    i++;
  }
  return blocks.map((b) => srBlockEdit(b, strict));
}

function srBlockEdit(b: SRBlock, strict: boolean): Edit {
  const p = b.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = parseFile(before);
    const found = findTier(f.lines, b.oldLines, strict, 0, false);
    if (!found) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const pos = found.occ[0]!;
    const n: NLine[] = b.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const rep = buildReplacement(f.lines, pos, b.oldLines, n, found.tier);
    const lines = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + b.oldLines.length)];
    tree.now.set(p, renderFile({ br: f.br, lines, final: f.final }));
  };
}

// ---- Section 8: V4A patches. ----

interface V4AChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  fileLines: string[];
  chunks: V4AChunk[];
  updateLine: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const sectionPrefix = (kind: 'add' | 'delete' | 'update'): string =>
    kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const kind = sectionStart(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = l.slice(sectionPrefix(kind).length).trim();
    let rawEnd = i + 1;
    while (rawEnd < last && sectionStart(lines[rawEnd]!) === null) rawEnd++;
    let end = rawEnd;
    while (end > i + 1 && blank(lines[end - 1]!)) end--;
    if (kind === 'add') {
      for (let j = i + 1; j < end; j++) {
        const c = lines[j]!;
        if (!(c.startsWith('+') || c === '')) throw new Exit2(`error: parse ${j + 1}`);
      }
      const fileLines = lines.slice(i + 1, end).map((c) => (c === '' ? '' : c.slice(1)));
      sections.push({ kind, path, moveTo: null, fileLines, chunks: [], updateLine: i + 1 });
    } else if (kind === 'delete') {
      if (end > i + 1) throw new Exit2(`error: parse ${i + 2}`);
      sections.push({ kind, path, moveTo: null, fileLines: [], chunks: [], updateLine: i + 1 });
    } else {
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < end && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (j < end) {
        const c = lines[j]!;
        if (c.startsWith('@@')) {
          closeChunk();
          const anchorText = c.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          j++;
          continue;
        }
        if (c === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          closeChunk();
          j++;
          continue;
        }
        if (c.startsWith(' ') || c.startsWith('-') || c.startsWith('+') || c === '') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push(c);
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      sections.push({ kind, path, moveTo, fileLines: [], chunks, updateLine: i + 1 });
    }
    i = rawEnd;
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function v4aSectionEdit(s: V4ASection, strict: boolean): Edit {
  const p = s.path;
  if (s.kind === 'add') {
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, s.fileLines.length === 0 ? '' : s.fileLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let f = parseFile(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const found = findTier(f.lines, [ch.anchor], strict, cursor, false);
        if (!found) throw new Fail('no-match', p);
        cursor = found.occ[0]! + 1;
      }
      const parts = splitBody(ch.body);
      if (parts.o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const ins = parts.n.map((x) => x.text);
        f = { br: f.br, lines: [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)], final: f.final };
        cursor = at + ins.length;
      } else {
        const found = findTier(f.lines, parts.o, strict, cursor, ch.eof);
        if (!found) throw new Fail('no-match', p);
        const pos = found.occ[0]!;
        const rep = buildReplacement(f.lines, pos, parts.o, parts.n, found.tier);
        f = { br: f.br, lines: [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + parts.o.length)], final: f.final };
        cursor = pos + rep.length;
      }
    }
    const out = renderFile(f);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, out);
      tree.now.set(p, null);
      recordedMoves.push([p, s.moveTo]);
    } else {
      tree.now.set(p, out);
    }
  };
}

// ---- Section 9: JSON edits. ----

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

// ---- Section 10: order and atomicity; section 1: the command line; section 2: output. ----

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  recordedMoves.length = 0;
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
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const nowVal = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const movesOk = recordedMoves.filter(([o, n]) => tree.original(o) !== null && nowVal(o) === null && tree.original(n) === null && nowVal(n) !== null);
  const covered = new Set<string>();
  for (const [o, n] of movesOk) {
    covered.add(o);
    covered.add(n);
  }
  const rows: Array<{ key: string; line: string }> = movesOk.map(([o, n]) => ({ key: n, line: `R ${o} -> ${n}` }));
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
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
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
