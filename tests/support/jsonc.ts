import { readFileSync } from 'node:fs';

/** Strips `//` and block comments outside string literals, then drops trailing commas. */
export function parseJsonc<T = unknown>(text: string): T {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) throw new Error('Unterminated block comment');
      i++;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as T;
}

export function readJsonc<T = unknown>(path: string): T {
  return parseJsonc<T>(readFileSync(path, 'utf8'));
}
