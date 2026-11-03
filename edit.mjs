// @意图#R636(2026-10-27): 运行器零依赖，edit 的匹配规则照搬 pi 1.1.0 的 edit-diff（先精确、再按引号/破折号/行尾空白放宽），
// 这样 bot 在你电脑上改文件和 pi 原版的 edit 行为一样；路径判断在 ops.mjs 里做，这里只管文字替换。
export function detectLineEnding(content) {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1 || crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}
export const normalizeToLF = (text) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
export const restoreLineEndings = (text, ending) => (ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text);

export function normalizeForFuzzyMatch(text) {
  return text.normalize("NFKC")
    .split("\n").map((line) => line.trimEnd()).join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}
const splitLinesWithEndings = (content) => content.match(/[^\n]*\n|[^\n]+/g) ?? [];
function getLineSpans(content) {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}
function getReplacementLineRange(lines, r) {
  const s = r.matchIndex;
  const e = r.matchIndex + r.matchLength;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (s >= lines[i].start && s < lines[i].end) { startLine = i; break; }
  }
  if (startLine === -1) throw new Error("Replacement range is outside the base content.");
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < e) endLine++;
  if (endLine >= lines.length) throw new Error("Replacement range is outside the base content.");
  return { startLine, endLine: endLine + 1 };
}
function applyReplacements(content, replacements, offset = 0) {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    const at = r.matchIndex - offset;
    result = result.substring(0, at) + r.newText + result.substring(at + r.matchLength);
  }
  return result;
}
function applyReplacementsPreservingUnchangedLines(originalContent, baseContent, replacements) {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
  }
  const groups = [];
  for (const r of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
    const range = getReplacementLineRange(baseLines, r);
    const cur = groups[groups.length - 1];
    if (cur && range.startLine < cur.endLine) {
      cur.endLine = Math.max(cur.endLine, range.endLine);
      cur.replacements.push(r);
      continue;
    }
    groups.push({ ...range, replacements: [r] });
  }
  let idx = 0;
  let result = "";
  for (const g of groups) {
    result += originalLines.slice(idx, g.startLine).join("");
    const gs = baseLines[g.startLine].start;
    const ge = baseLines[g.endLine - 1].end;
    result += applyReplacements(baseContent.slice(gs, ge), g.replacements, gs);
    idx = g.endLine;
  }
  return result + originalLines.slice(idx).join("");
}
function fuzzyFindText(content, oldText) {
  const exact = content.indexOf(oldText);
  if (exact !== -1) return { found: true, index: exact, matchLength: oldText.length, usedFuzzyMatch: false };
  const fc = normalizeForFuzzyMatch(content);
  const fo = normalizeForFuzzyMatch(oldText);
  const fi = fc.indexOf(fo);
  if (fi === -1) return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  return { found: true, index: fi, matchLength: fo.length, usedFuzzyMatch: true };
}
const countOccurrences = (content, oldText) => normalizeForFuzzyMatch(content).split(normalizeForFuzzyMatch(oldText)).length - 1;

export function applyEditsToNormalizedContent(normalizedContent, edits, path) {
  const ne = edits.map((e) => ({ oldText: normalizeToLF(String(e.oldText)), newText: normalizeToLF(String(e.newText)) }));
  const n = ne.length;
  for (let i = 0; i < n; i++) {
    if (ne[i].oldText.length === 0) {
      throw new Error(n === 1 ? `oldText must not be empty in ${path}.` : `edits[${i}].oldText must not be empty in ${path}.`);
    }
  }
  const usedFuzzy = ne.map((e) => fuzzyFindText(normalizedContent, e.oldText)).some((m) => m.usedFuzzyMatch);
  const base = usedFuzzy ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;
  const matched = [];
  for (let i = 0; i < n; i++) {
    const m = fuzzyFindText(base, ne[i].oldText);
    if (!m.found) {
      throw new Error(n === 1
        ? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
        : `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`);
    }
    const occ = countOccurrences(base, ne[i].oldText);
    if (occ > 1) {
      throw new Error(n === 1
        ? `Found ${occ} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
        : `Found ${occ} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`);
    }
    matched.push({ editIndex: i, matchIndex: m.index, matchLength: m.matchLength, newText: ne[i].newText });
  }
  matched.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matched.length; i++) {
    const p = matched[i - 1];
    const c = matched[i];
    if (p.matchIndex + p.matchLength > c.matchIndex) {
      throw new Error(`edits[${p.editIndex}] and edits[${c.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`);
    }
  }
  const newContent = usedFuzzy
    ? applyReplacementsPreservingUnchangedLines(normalizedContent, base, matched)
    : applyReplacements(base, matched);
  if (newContent === normalizedContent) {
    throw new Error(n === 1
      ? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
      : `No changes made to ${path}. The replacements produced identical content.`);
  }
  return { baseContent: normalizedContent, newContent };
}

/** 整个文件的改法：去 BOM、统一换行再匹配，写回时恢复原来的换行和 BOM（和 pi 原版一样）。 */
// @意图#R636(2026-10-27): 和 pi edit 同样的 BOM、换行处理
export function editText(raw, edits, path) {
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const content = bom ? raw.slice(1) : raw;
  const ending = detectLineEnding(content);
  const { newContent } = applyEditsToNormalizedContent(normalizeToLF(content), edits, path);
  return bom + restoreLineEndings(newContent, ending);
}
