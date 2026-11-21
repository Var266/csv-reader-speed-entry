// Fast drop-in for csv-reader 1.0.0: returns exactly readCsv(input)'s answer,
// parsed with indexOf/slice chunking instead of one character at a time.
// The field parsers are inlined in the record loop so no per-field result
// object is allocated (the profile showed GC as the largest cost).
//
// Semantics (mirroring vendor/csv-reader/index.js):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (stray_cr).
// - A field opening with a quote runs to the next quote that is not doubled;
//   "" inside it is one quote, each CRLF or lone CR inside it is LF; what
//   follows its closing quote up to the next comma or line break is appended
//   as it stands (quote_junk, when the field ends); a quote that never closes
//   is a literal character and the text after it is read again as unquoted
//   (unterminated_quote). A quote inside an unquoted field is literal.
// - columns is the first record when header is true, else null; rows are the
//   records after it, each padded (short_row, fields: its count) or cut
//   (long_row, extra: the cut fields) to the first record's width.
// - Each error is {code, line, row}: line the 1-based line its record starts
//   on, row its record's index in rows (null for the header), in the order met.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes.
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Count '\n' in s (each is one line break after CR->LF conversion).
  function countLF(s) {
    let n = 0;
    let i = -1;
    while ((i = s.indexOf('\n', i + 1)) !== -1) n++;
    return n;
  }

  // Reference readUnquoted: reads unquoted characters onto `value` up to the
  // next comma or line break; a CR not followed by LF is dropped (stray_cr).
  // Only used for the rare paths (stray CR, quote junk, unterminated quote).
  // Returns {value, ended, added, pos} with `added` the characters appended here.
  function readUnquoted(value, startPos) {
    let added = 0;
    let p = startPos;
    while (p < len) {
      const c = text[p];
      if (c === ',') {
        return { value, ended: COMMA, added, pos: p + 1 };
      }
      if (c === '\n') {
        line += 1;
        return { value, ended: LINE_BREAK, added, pos: p + 1 };
      }
      if (c === '\r') {
        if (text[p + 1] === '\n') {
          line += 1;
          return { value, ended: LINE_BREAK, added, pos: p + 2 };
        }
        error('stray_cr');
        p += 1;
        continue;
      }
      value += c;
      added += 1;
      p += 1;
    }
    return { value, ended: END, added, pos: p };
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let value;
    let ended;
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        // Quoted field: find the closing quote (first quote not doubled).
        quoted = true;
        const open = pos;
        const openLine = line;
        pos += 1;
        let q = text.indexOf('"', pos);
        let doubled = false;
        while (q !== -1 && text.charCodeAt(q + 1) === 34) {
          doubled = true;
          q = text.indexOf('"', q + 2);
        }
        if (q === -1) {
          // The quote never closes: literal, re-read as unquoted.
          pos = open + 1;
          line = openLine;
          error('unterminated_quote');
          const r = readUnquoted('"', pos);
          pos = r.pos;
          value = r.value;
          ended = r.ended;
        } else {
          value = text.slice(pos, q);
          if (doubled) value = value.replace(/""/g, '"');
          // After CR->LF conversion every line break inside is one '\n'.
          if (/[\r\n]/.test(value)) {
            if (value.indexOf('\r') !== -1) value = value.replace(/\r\n?/g, '\n');
            line += countLF(value);
          }
          pos = q + 1;
          if (pos >= len) {
            ended = END;
          } else {
            const c0 = text.charCodeAt(pos);
            if (c0 === 44) {
              pos += 1;
              ended = COMMA;
            } else if (c0 === 10) {
              pos += 1;
              line += 1;
              ended = LINE_BREAK;
            } else if (c0 === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              ended = LINE_BREAK;
            } else {
              // What follows the closing quote is appended as it stands.
              const junk = readUnquoted(value, pos);
              pos = junk.pos;
              if (junk.added > 0) error('quote_junk');
              value = junk.value;
              ended = junk.ended;
            }
          }
        }
      } else {
        // Unquoted field. The '\r' check runs on the sliced field value,
        // so it never scans past the field's delimiter.
        quoted = false;
        const s = pos;
        const c = text.indexOf(',', s);
        const n = text.indexOf('\n', s);
        if (c !== -1 && (n === -1 || c < n)) {
          value = text.slice(s, c);
          if (value.indexOf('\r') !== -1) {
            const res = readUnquoted('', s);
            pos = res.pos;
            value = res.value;
            ended = res.ended;
          } else {
            pos = c + 1;
            ended = COMMA;
          }
        } else if (n !== -1) {
          // A CR immediately before the LF is the CRLF half; any other CR
          // in the field is stray.
          value = text.charCodeAt(n - 1) === 13 ? text.slice(s, n - 1) : text.slice(s, n);
          if (value.indexOf('\r') !== -1) {
            const res = readUnquoted('', s);
            pos = res.pos;
            value = res.value;
            ended = res.ended;
          } else {
            pos = n + 1;
            line += 1;
            ended = LINE_BREAK;
          }
        } else {
          value = text.slice(s);
          if (value.indexOf('\r') !== -1) {
            const res = readUnquoted('', s);
            pos = res.pos;
            value = res.value;
            ended = res.ended;
          } else {
            pos = len;
            ended = END;
          }
        }
      }
      fields.push(value);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record.
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
