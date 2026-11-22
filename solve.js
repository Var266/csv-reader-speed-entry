// Fast drop-in for csv-reader 1.0.0: returns exactly readCsv(input)'s answer,
// parsed with indexOf/slice chunking instead of one character at a time.
// The field parsers are inlined in the record loop so no per-field result
// object is allocated (the profile showed GC as the largest cost).
//
// v3: the unquoted-field path no longer searches for the line break and the
// stray CR on every field. Two carried positions -- lineEnd, the next LF at
// or after the current position, and nextCR, the next CR -- are refreshed
// lazily, only when the parser passes them. That removes ~1.3M indexOf calls
// over the practice set (the delimiter search drops to one indexOf per field).
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

  // The next LF and the next CR at or after pos, refreshed lazily when the
  // parser passes them (-1 when there is no later one). Every position the
  // parser passes is accounted for: a CR it passes was a CRLF half, inside
  // a quoted field, in a skipped blank line, or a stray one readUnquoted
  // already recorded, so the refresh never skips a live CR.
  let lineEnd = text.indexOf('\n', pos);
  let nextCR = text.indexOf('\r', pos);

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
      // Refresh the carried positions when the parser has passed them.
      if (lineEnd !== -1 && pos > lineEnd) lineEnd = text.indexOf('\n', pos);
      if (nextCR !== -1 && pos > nextCR) nextCR = text.indexOf('\r', pos);
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
          if (value.indexOf('\r') !== -1 || value.indexOf('\n') !== -1) {
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
        // Unquoted field. The field ends at the next comma before lineEnd,
        // else at lineEnd, else at the text's end. A stray CR in it is one
        // nextCR points at inside the field's span (a CR at lineEnd - 1 is
        // the CRLF half, not stray).
        quoted = false;
        const s = pos;
        const c = text.indexOf(',', s);
        if (c !== -1 && (lineEnd === -1 || c < lineEnd)) {
          value = text.slice(s, c);
          if (nextCR !== -1 && nextCR < c) {
            const res = readUnquoted('', s);
            pos = res.pos;
            value = res.value;
            ended = res.ended;
          } else {
            pos = c + 1;
            ended = COMMA;
          }
        } else if (lineEnd !== -1) {
          const n = lineEnd;
          const crlf = text.charCodeAt(n - 1) === 13;
          value = crlf ? text.slice(s, n - 1) : text.slice(s, n);
          if (nextCR !== -1 && nextCR < (crlf ? n - 1 : n)) {
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
          if (nextCR !== -1) {
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

// ---- Escaped-byte transducer (v4) ----
//
// runCases(raw) answers every case of a cases.json file WITHOUT JSON.parse:
// it locates each case's escaped text span, transduces the escaped CSV
// straight into the answer's JSON text, and joins the answers. The output
// reuses the input's own escapes: an unquoted field's JSON content is its
// escaped slice as it stands, so no field is ever unescaped and re-escaped,
// and no nested answer object is ever built.
//
// Safety: the transducer only runs on a span with no literal backslash in
// its text (a double backslash in the escaped form). Every other escape is
// safe: \t, \b, \f, \/ and \uXXXX copy verbatim into the output (the same
// character, still valid JSON) and cannot fake a delimiter -- the parser
// only looks for the two-unit sequences \n, \r and \", and none of those
// escapes holds one. A double backslash could fake one (\\n holds \n), so
// a span holding one falls back to the plain parser. Any malformed input
// or unexpected failure falls back the same way, so the entry stays
// correct, only slower. The rare paths (stray CR, quote junk, unterminated
// quote) unescape just that one field and finish it with the plain logic,
// so they stay exact too.

// A literal backslash in the text, escaped as a double backslash.
const ESCAPED_BACKSLASH = /\\\\/;

/** How the transducer ran, for verification (fast = transducer, slow = fallback). */
export const transducerStats = { fast: 0, slow: 0, threw: 0 };

/** The real text of an escaped span [a, b) of a JSON string (boundaries never split an escape). */
function unescapeSpan(span, a, b) {
  return JSON.parse('"' + span.slice(a, b) + '"');
}

/**
 * The cases of a cases.json file: [{start, end, header}] with [start, end)
 * the escaped text span. The file is [{"id":"...","input":{"text":"...","header":bool}}, ...];
 * whitespace between tokens is tolerated. Throws on malformed input.
 */
function extractCases(raw) {
  const cases = [];
  let p = 0;
  const len = raw.length;
  const skipWs = () => {
    while (p < len) {
      const c = raw.charCodeAt(p);
      if (c === 32 || c === 10 || c === 13 || c === 9) p++;
      else break;
    }
  };
  const expect = (s) => {
    if (raw.startsWith(s, p)) {
      p += s.length;
      return true;
    }
    return false;
  };
  // Skip a JSON string starting at p (p at its opening quote); p ends past
  // its closing quote. A quote preceded by an odd run of backslashes is escaped.
  const skipString = () => {
    let q = p + 1;
    while (true) {
      q = raw.indexOf('"', q);
      if (q === -1) throw new Error('unterminated string in cases.json');
      let bs = 0;
      let i = q - 1;
      while (i > p && raw.charCodeAt(i) === 92) {
        bs++;
        i--;
      }
      if (bs % 2 === 0) {
        p = q + 1;
        return;
      }
      q += 1;
    }
  };
  skipWs();
  if (!expect('[')) throw new Error('cases.json is not an array');
  skipWs();
  if (raw[p] === ']') return cases;
  while (true) {
    skipWs();
    if (!expect('{"id":')) throw new Error('bad case header');
    skipWs();
    if (raw[p] !== '"') throw new Error('bad id');
    skipString();
    skipWs();
    if (!expect(',"input":{"text":')) throw new Error('bad case input');
    skipWs();
    if (raw[p] !== '"') throw new Error('bad text');
    const textStart = p + 1;
    // The text's closing quote is the one before ,"header":. The first
    // occurrence of the marker is it, verified by the structure after it;
    // if that fails, a parity scan finds the real closing quote.
    let textEnd = raw.indexOf('","header":', textStart);
    let header;
    if (textEnd !== -1) {
      const after = textEnd + 11;
      if (raw.startsWith('true', after)) header = true;
      else if (raw.startsWith('false', after)) header = false;
      else textEnd = -1;
    }
    if (textEnd === -1) {
      p = textStart - 1;
      skipString();
      textEnd = p - 1;
      skipWs();
      if (!expect(',"header":')) throw new Error('bad header key');
      skipWs();
      if (raw.startsWith('true', p)) {
        header = true;
        p += 4;
      } else if (raw.startsWith('false', p)) {
        header = false;
        p += 5;
      } else {
        throw new Error('bad header value');
      }
    } else {
      p = textEnd + 11 + (header ? 4 : 5);
    }
    cases.push({ start: textStart, end: textEnd, header });
    skipWs();
    if (!expect('}}')) throw new Error('bad case tail');
    skipWs();
    if (raw[p] === ',') {
      p++;
      continue;
    }
    if (raw[p] === ']') {
      p++;
      break;
    }
    throw new Error('bad array separator');
  }
  skipWs();
  if (p !== len) throw new Error('trailing data in cases.json');
  return cases;
}

/**
 * One case's answer as its JSON text, transduced from the case's ESCAPED text
 * span (the text as it stands inside cases.json, escapes intact). Returns null
 * when the span holds a literal backslash (a double backslash in the escaped
 * form) and the caller must fall back to the plain parser.
 *
 * In the escaped text a line break is the two units \n, a CR the two units \r,
 * a quote the two units \". The parser mirrors run() in these coordinates:
 * lineEnd is the next \n escape, nextCR the next \r escape, both carried and
 * refreshed lazily. A field's JSON content is its escaped slice as it stands
 * (already valid JSON string content); only quoted fields with doubled quotes
 * or CRs are rewritten, and only the rare paths unescape anything.
 */
export function runEscaped(span, header) {
  if (ESCAPED_BACKSLASH.test(span)) return null;
  const len = span.length;
  const errors = [];
  const rowsOut = [];
  let columnsOut = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (len > 0 && span.charCodeAt(0) === 0xfeff) pos = 1;

  let lineEnd = span.indexOf('\\n', pos);
  let nextCR = span.indexOf('\\r', pos);

  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push('{"code":"' + code + '","line":' + recordLine + ',"row":' + recordRow + '}');
  }

  // Count line breaks in an escaped string whose CRs are already converted
  // (every break is one \n escape).
  function countLF(s) {
    let n = 0;
    let i = -1;
    while ((i = s.indexOf('\\n', i + 1)) !== -1) n++;
    return n;
  }

  // Count '\r' characters in a real (unescaped) string.
  function countCR(s) {
    let n = 0;
    let i = -1;
    while ((i = s.indexOf('\r', i + 1)) !== -1) n++;
    return n;
  }

  // An unquoted field's span [a, b), unescaped with its stray CRs dropped
  // (the span holds no line break, so every CR in it is stray). Returns the
  // field's JSON content, quotes stripped, and records the stray_cr errors.
  function cleanUnquoted(a, b) {
    const real = unescapeSpan(span, a, b);
    const strays = countCR(real);
    for (let k = 0; k < strays; k++) error('stray_cr');
    const value = strays === 0 ? real : real.replace(/\r/g, '');
    return JSON.stringify(value).slice(1, -1);
  }

  // A record's fields as their JSON array text: ["f1","f2",...]. Built with
  // += (a rope V8 flattens once when the row is joined), which measured
  // ~30% faster than fields.join('","') over the practice set.
  function joinRow(fields) {
    let s = '["';
    for (let i = 0; i < fields.length; i++) {
      if (i !== 0) s += '","';
      s += fields[i];
    }
    return s + '"]';
  }

  while (true) {
    // Lines with no characters are no records: a lone \n escape, or a \r\n pair.
    while (pos < len) {
      if (span.charCodeAt(pos) === 92 && span.charCodeAt(pos + 1) === 110) {
        pos += 2;
        line += 1;
      } else if (
        span.charCodeAt(pos) === 92 && span.charCodeAt(pos + 1) === 114 &&
        span.charCodeAt(pos + 2) === 92 && span.charCodeAt(pos + 3) === 110
      ) {
        pos += 4;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columnsOut === null ? null : rowsOut.length;
    const fields = []; // this record's fields, each as its escaped JSON content (no quotes)
    let ended;
    let quoted = false;
    do {
      if (lineEnd !== -1 && pos > lineEnd) lineEnd = span.indexOf('\\n', pos);
      if (nextCR !== -1 && pos > nextCR) nextCR = span.indexOf('\\r', pos);
      if (span.charCodeAt(pos) === 92 && span.charCodeAt(pos + 1) === 34) {
        // Quoted field: find the closing \" (the first not doubled).
        quoted = true;
        const open = pos;
        const openLine = line;
        pos += 2;
        let q = span.indexOf('\\"', pos);
        let doubled = false;
        while (q !== -1 && span.charCodeAt(q + 2) === 92 && span.charCodeAt(q + 3) === 34) {
          doubled = true;
          q = span.indexOf('\\"', q + 4);
        }
        if (q === -1) {
          // The quote never closes: literal, re-read as unquoted.
          line = openLine;
          error('unterminated_quote');
          pos = open + 2;
          if (lineEnd !== -1 && pos > lineEnd) lineEnd = span.indexOf('\\n', pos);
          if (nextCR !== -1 && pos > nextCR) nextCR = span.indexOf('\\r', pos);
          const c = span.indexOf(',', pos);
          let uEnd;
          let uLim;
          if (c !== -1 && (lineEnd === -1 || c < lineEnd)) {
            uEnd = c;
            uLim = c;
            ended = COMMA;
          } else if (lineEnd !== -1) {
            const n = lineEnd;
            const crlf = span.charCodeAt(n - 2) === 92 && span.charCodeAt(n - 1) === 114;
            uLim = crlf ? n - 2 : n;
            uEnd = n;
            ended = LINE_BREAK;
          } else {
            uEnd = len;
            uLim = len;
            ended = END;
          }
          const real = unescapeSpan(span, pos, uLim);
          const strays = countCR(real);
          for (let k = 0; k < strays; k++) error('stray_cr');
          const clean = strays === 0 ? real : real.replace(/\r/g, '');
          fields.push(JSON.stringify('"' + clean).slice(1, -1));
          if (ended === COMMA) {
            pos = uEnd + 1;
          } else if (ended === LINE_BREAK) {
            pos = uEnd + 2;
            line += 1;
          } else {
            pos = len;
          }
        } else {
          let content = span.slice(pos, q);
          if (doubled) content = content.replace(/\\"\\"/g, '\\"');
          if (content.indexOf('\\r') !== -1) content = content.replace(/\\r(\\n)?/g, '\\n');
          if (content.indexOf('\\n') !== -1) line += countLF(content);
          pos = q + 2;
          if (pos >= len) {
            ended = END;
            fields.push(content);
          } else {
            const c0 = span.charCodeAt(pos);
            if (c0 === 44) {
              pos += 1;
              ended = COMMA;
              fields.push(content);
            } else if (c0 === 92 && span.charCodeAt(pos + 1) === 110) {
              pos += 2;
              line += 1;
              ended = LINE_BREAK;
              fields.push(content);
            } else if (
              c0 === 92 && span.charCodeAt(pos + 1) === 114 &&
              span.charCodeAt(pos + 2) === 92 && span.charCodeAt(pos + 3) === 110
            ) {
              pos += 4;
              line += 1;
              ended = LINE_BREAK;
              fields.push(content);
            } else {
              // What follows the closing quote is appended as it stands.
              if (lineEnd !== -1 && pos > lineEnd) lineEnd = span.indexOf('\\n', pos);
              if (nextCR !== -1 && pos > nextCR) nextCR = span.indexOf('\\r', pos);
              const c2 = span.indexOf(',', pos);
              let jEnd;
              let jLim;
              if (c2 !== -1 && (lineEnd === -1 || c2 < lineEnd)) {
                jEnd = c2;
                jLim = c2;
                ended = COMMA;
              } else if (lineEnd !== -1) {
                const n2 = lineEnd;
                const crlf2 = span.charCodeAt(n2 - 2) === 92 && span.charCodeAt(n2 - 1) === 114;
                jLim = crlf2 ? n2 - 2 : n2;
                jEnd = n2;
                ended = LINE_BREAK;
              } else {
                jEnd = len;
                jLim = len;
                ended = END;
              }
              const realContent = JSON.parse('"' + content + '"');
              const realJunk = unescapeSpan(span, pos, jLim);
              const strays = countCR(realJunk);
              for (let k = 0; k < strays; k++) error('stray_cr');
              const junkClean = strays === 0 ? realJunk : realJunk.replace(/\r/g, '');
              if (junkClean.length > 0) error('quote_junk');
              fields.push(JSON.stringify(realContent + junkClean).slice(1, -1));
              if (ended === COMMA) {
                pos = jEnd + 1;
              } else if (ended === LINE_BREAK) {
                pos = jEnd + 2;
                line += 1;
              } else {
                pos = len;
              }
            }
          }
        }
      } else {
        // Unquoted field. It ends at the next comma before lineEnd, else at
        // lineEnd, else at the span's end. A stray CR in it is one nextCR
        // points at inside the field's span (a CR at lineEnd - 2 is the
        // CRLF half, not stray).
        quoted = false;
        const s = pos;
        const c = span.indexOf(',', s);
        if (c !== -1 && (lineEnd === -1 || c < lineEnd)) {
          if (nextCR !== -1 && nextCR < c) {
            fields.push(cleanUnquoted(s, c));
            pos = c + 1;
            ended = COMMA;
          } else {
            fields.push(span.slice(s, c));
            pos = c + 1;
            ended = COMMA;
          }
        } else if (lineEnd !== -1) {
          const n = lineEnd;
          const crlf = span.charCodeAt(n - 2) === 92 && span.charCodeAt(n - 1) === 114;
          const lim = crlf ? n - 2 : n;
          if (nextCR !== -1 && nextCR < lim) {
            fields.push(cleanUnquoted(s, lim));
            pos = n + 2;
            line += 1;
            ended = LINE_BREAK;
          } else {
            fields.push(span.slice(s, lim));
            pos = n + 2;
            line += 1;
            ended = LINE_BREAK;
          }
        } else {
          if (nextCR !== -1) {
            fields.push(cleanUnquoted(s, len));
            pos = len;
            ended = END;
          } else {
            fields.push(span.slice(s));
            pos = len;
            ended = END;
          }
        }
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columnsOut === null) {
      columnsOut = joinRow(fields);
      continue;
    }
    if (fields.length < width) {
      errors.push('{"code":"short_row","line":' + recordLine + ',"row":' + recordRow + ',"fields":' + fields.length + '}');
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      const extra = fields.splice(width);
      errors.push('{"code":"long_row","line":' + recordLine + ',"row":' + recordRow + ',"extra":' + joinRow(extra) + '}');
    }
    rowsOut.push(joinRow(fields));
  }
  return '{"columns":' + (header ? (columnsOut ?? '[]') : 'null') +
    ',"rows":[' + rowsOut.join(',') + '],"errors":[' + errors.join(',') + ']}';
}

/**
 * Every case's answer as its JSON text, one per case in the cases' order.
 * Each case is transduced, falling back to the plain parser when its span
 * needs it. Throws on malformed input (the caller then falls back to
 * JSON.parse). The caller writes the answers out (joined with commas inside
 * brackets) rather than this function joining them: joining 12 MB into one
 * string to write it measured ~140 ms slower than writing the pieces.
 */
export function runCasesArray(raw) {
  const cases = extractCases(raw);
  const answers = [];
  for (const c of cases) {
    const span = raw.slice(c.start, c.end);
    let out = null;
    try {
      out = runEscaped(span, c.header);
    } catch {
      transducerStats.threw++;
      out = null;
    }
    if (out === null) {
      transducerStats.slow++;
      const input = { text: JSON.parse('"' + span + '"'), header: c.header };
      out = JSON.stringify(run(input));
    } else {
      transducerStats.fast++;
    }
    answers.push(out);
  }
  return answers;
}

/** The answers.json text for a whole cases.json file (the joined answers). */
export function runCases(raw) {
  return '[' + runCasesArray(raw).join(',') + ']';
}
