// v3.1 — intake-retry marker (comment only; no behavior change).
// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader): run(input) returns, for every
// input {text, header}, exactly the {columns, rows, errors} the reference returns, but faster.
// No dependencies, no clock, no randomness.
//
// How it stays fast: the reference reads one character at a time and builds every field a character
// at a time. This reader never scans a character twice in the common case. An unquoted field is
// located with two indexOf calls (the nearest of ',' and '\n') and taken as one slice; a CR inside
// it is found by scanning only that slice, and a trailing CR before the '\n' is the CRLF that ends
// the field. A quoted field is located by indexOf('"') (doubled quotes collapse to one), and its
// content is one slice unless it holds a CR (rare), which is the only place a field's text is
// rebuilt. Line numbers are kept exactly as the reference keeps them, so every error lands on the
// same line and row. Field results travel in three slots (fVal/fEnd/fAdded) instead of an object
// per field, so the hot path allocates nothing but the field strings and the rows themselves.

const COMMA = 0;
const LB = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, faster. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // The next '\n' at or after the current unquoted position, cached per record: an unquoted
  // field ends at the next ',' or '\n', and re-scanning for '\n' per field re-walks the whole
  // rest of the line every time. The cache is refreshed lazily whenever pos passes it (a new
  // record, or a quoted field that spanned lines).
  let lineEnd = -1;

  // The field just read: its value, how it ended, and how many characters were kept in it.
  let fVal = '';
  let fEnd = END;
  let fAdded = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // The value of a quoted field's content text[start..end): each CRLF or lone CR inside it is one
  // LF, and `line` advances past every line break in it. Fast path: no CR and no LF.
  function quotedContent(start, end) {
    const seg = text.slice(start, end);
    const cr = seg.indexOf('\r');
    if (cr === -1) {
      const nl = seg.indexOf('\n');
      if (nl === -1) return seg;
      let n = 0;
      let i = nl;
      while (i !== -1) {
        n++;
        i = seg.indexOf('\n', i + 1);
      }
      line += n;
      return seg;
    }
    // CRs present: rebuild, counting lines.
    let out = '';
    let i = 0;
    const n = seg.length;
    while (i < n) {
      const c = seg.charCodeAt(i);
      if (c === 13) {
        out += '\n';
        line++;
        i += i + 1 < n && seg.charCodeAt(i + 1) === 10 ? 2 : 1;
      } else {
        if (c === 10) line++;
        out += seg[i];
        i++;
      }
    }
    return out;
  }

  // Reads an unquoted field from `start` with initial value `init` ('' normally, '"' when a quote
  // that never closes is re-read as unquoted). A CR not followed by LF is dropped (stray_cr) and
  // the field goes on; a CRLF ends it. Sets fVal/fEnd/fAdded.
  function readUnquoted(start, init) {
    let value = init;
    let added = 0;
    let p = start;
    if (p >= len) {
      fVal = value;
      fEnd = END;
      fAdded = added;
      pos = len;
      return;
    }
    if (lineEnd < p) lineEnd = text.indexOf('\n', p);
    const comma = text.indexOf(',', p);
    let end;
    let kind;
    if (comma === -1 && lineEnd === -1) {
      // No delimiter to the end of the text: the rest is the field, stray CRs dropped.
      const seg = text.slice(p);
      const cr = seg.indexOf('\r');
      if (cr === -1) {
        fVal = init === '' ? seg : init + seg;
        fEnd = END;
        fAdded = added + seg.length;
        pos = len;
        return;
      }
      let out = '';
      for (let i = 0; i < seg.length; i++) {
        if (seg.charCodeAt(i) === 13) {
          error('stray_cr');
          continue;
        }
        out += seg[i];
      }
      fVal = value + out;
      fEnd = END;
      fAdded = added + out.length;
      pos = len;
      return;
    }
    if (comma !== -1 && (lineEnd === -1 || comma < lineEnd)) {
      end = comma;
      kind = COMMA;
    } else {
      end = lineEnd;
      kind = LB;
    }
    const seg = text.slice(p, end);
    const cr = seg.indexOf('\r');
    if (cr === -1) {
      fVal = init === '' ? seg : init + seg;
      fEnd = kind;
      fAdded = added + seg.length;
      pos = end + 1;
      if (kind === LB) line++;
      return;
    }
    if (kind === LB && cr === seg.length - 1) {
      // A CRLF ends the field: the CR is its first half.
      fVal = init === '' ? text.slice(p, end - 1) : init + seg.slice(0, -1);
      fEnd = LB;
      fAdded = added + seg.length - 1;
      pos = end + 1;
      line++;
      return;
    }
    // Stray CRs inside the field (and a trailing CRLF, if the field ends at a line break).
    let out = '';
    for (let i = 0; i < seg.length; i++) {
      const ch = seg.charCodeAt(i);
      if (ch === 13) {
        if (i === seg.length - 1 && kind === LB) continue; // the CRLF's CR
        error('stray_cr');
        continue;
      }
      out += seg[i];
    }
    fVal = value + out;
    fEnd = kind;
    fAdded = added + out.length;
    pos = end + 1;
    if (kind === LB) line++;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fVal/fEnd/fAdded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let pieces = null;
    let cur = pos + 1;
    for (;;) {
      const q = text.indexOf('"', cur);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is read again
        // as an unquoted field.
        line = openLine;
        error('unterminated_quote');
        readUnquoted(open + 1, '"');
        return;
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one literal quote in the value.
        if (pieces === null) pieces = [];
        pieces.push(quotedContent(cur, q));
        pieces.push('"');
        cur = q + 2;
        continue;
      }
      // The closing quote is at q.
      const seg = quotedContent(cur, q);
      const value = pieces === null ? seg : pieces.join('') + seg;
      pos = q + 1;
      if (pos >= len) {
        fVal = value;
        fEnd = END;
        fAdded = 0;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos++;
        fVal = value;
        fEnd = COMMA;
        fAdded = 0;
        return;
      }
      if (c === 10) {
        pos++;
        line++;
        fVal = value;
        fEnd = LB;
        fAdded = 0;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
        fVal = value;
        fEnd = LB;
        fAdded = 0;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the next comma or line
      // break; a quote_junk error when the field ends, if anything was kept.
      readUnquoted(pos, value);
      if (fAdded > 0) error('quote_junk');
      return;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        readQuoted();
        quoted = true;
      } else {
        readUnquoted(pos, '');
      }
      fields.push(fVal);
    } while (fEnd === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr
    // errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
