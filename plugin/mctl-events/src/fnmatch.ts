// `fnmatch.fnmatchcase` from the Python standard library: shell-style
// wildcards (`*`, `?`, `[seq]`, `[!seq]`), case-sensitive, matched against the
// whole string. A port of CPython 3.12's `fnmatch.translate`, so a policy
// pattern means the same thing to both adapters.

const cache = new Map<string, RegExp>();

export function fnmatchcase(name: string, pattern: string): boolean {
  let re = cache.get(pattern);
  if (re === undefined) {
    re = new RegExp("^(?:" + translate(pattern) + ")$", "su");
    if (cache.size > 256) cache.clear();
    cache.set(pattern, re);
  }
  return re.test(name);
}

function escape(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? "\\" + ch : ch;
}

/** Escape a character for use inside a `[...]` class under the `u` flag. */
function classEscape(text: string): string {
  let out = "";
  for (const ch of text) out += /[\\\]\[^-]/.test(ch) ? "\\" + ch : ch;
  return out;
}

export function translate(pat: string): string {
  const chars = Array.from(pat);
  const n = chars.length;
  let i = 0;
  let res = "";
  while (i < n) {
    const c = chars[i++]!;
    if (c === "*") {
      // Compress consecutive `*` into one.
      while (i < n && chars[i] === "*") i++;
      res += ".*";
    } else if (c === "?") {
      res += ".";
    } else if (c === "[") {
      let j = i;
      if (j < n && chars[j] === "!") j++;
      if (j < n && chars[j] === "]") j++;
      while (j < n && chars[j] !== "]") j++;
      if (j >= n) {
        res += "\\[";
        continue;
      }
      let negate = false;
      let start = i;
      if (chars[start] === "!") {
        negate = true;
        start++;
      }
      const body = chars.slice(start, j);
      i = j + 1;
      // Ranges are kept as (lo, hi) pairs, singles as one-element pairs;
      // a range whose ends are out of order is empty and dropped, as CPython
      // removes it before compiling.
      const parts: string[] = [];
      let k = 0;
      while (k < body.length) {
        const lo = body[k]!;
        if (k + 2 < body.length && body[k + 1] === "-") {
          const hi = body[k + 2]!;
          if (lo.codePointAt(0)! <= hi.codePointAt(0)!) parts.push(classEscape(lo) + "-" + classEscape(hi));
          k += 3;
        } else {
          parts.push(classEscape(lo));
          k += 1;
        }
      }
      if (!parts.length) {
        // An empty set: matches nothing, or (negated) any one character.
        res += negate ? "." : "(?!)";
      } else {
        res += "[" + (negate ? "^" : "") + parts.join("") + "]";
      }
    } else {
      res += escape(c);
    }
  }
  return res;
}
