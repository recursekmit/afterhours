// One-off migration from the zine theme to the engraved-ticket theme (kept for the record; idempotent).
//   node scripts/retheme-css.mjs
// Over every CSS module in web/src (not tokens.css / fonts.css):
//   - decorative tilts go: rotate() under 10 degrees, and `rotate:` properties, outside @keyframes
//   - hard offset ink shadows become the engraved depth tokens (text: --engrave, boxes: --shadow-*)
//   - light "paper" text on the old loud blocks becomes cream (gold grounds keep their dark text)
//   - variable-font settings for the retired faces go
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.css') && !/tokens\.css|fonts\.css|global\.css|kit\.module\.css|ornament\.module\.css/.test(f)) files.push(p);
  }
})('web/src');

let changed = 0;
for (const p of files) {
  const src = readFileSync(p, 'utf8');
  let out = '';
  // walk top-level blocks so @keyframes bodies are left alone
  let i = 0;
  let depth = 0;
  let inKeyframes = false;
  let kfDepth = 0;
  let chunk = '';
  const flush = (text) => (inKeyframes ? text : fix(text));
  while (i < src.length) {
    const ch = src[i];
    chunk += ch;
    if (ch === '{') {
      const head = chunk.slice(0, -1);
      if (/@keyframes[^{]*$/.test(head) && !inKeyframes) {
        out += flush(chunk);
        chunk = '';
        inKeyframes = true;
        kfDepth = depth;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (inKeyframes && depth === kfDepth) {
        out += chunk;
        chunk = '';
        inKeyframes = false;
      } else if (!inKeyframes) {
        out += fix(chunk);
        chunk = '';
      }
    }
    i++;
  }
  out += flush(chunk);
  if (out !== src) {
    writeFileSync(p, out);
    changed++;
  }
}
console.log(`rethemed ${changed} of ${files.length} CSS files`);

function smallAngle(a) {
  const m = /^(-?[\d.]+)deg$/.exec(a.trim());
  if (!m) return false;
  return Math.abs(Number(m[1])) < 10;
}

/** Fix one rule (selector + declarations up to and including its closing brace). */
function fix(rule) {
  let r = rule;
  // transforms: drop small rotate() tokens
  r = r.replace(/transform:\s*([^;}]*)(;?)/g, (whole, val, semi) => {
    const kept = val.replace(/rotate\(([^)]*)\)/g, (t, a) => (a.includes('var(') || smallAngle(a) ? '' : t)).replace(/\s+/g, ' ').trim();
    if (!kept || kept === 'none') return '';
    return `transform: ${kept}${semi}`;
  });
  r = r.replace(/(^|[\s;{])rotate:\s*([^;}]*);?/g, (whole, pre, a) => (smallAngle(a) || a.includes('var(') ? pre : whole));
  // hard offset shadows
  r = r.replace(/text-shadow:\s*[^;}]*\d+px\s+\d+px\s+0[^;}]*;?/g, 'text-shadow: var(--engrave);');
  r = r.replace(/box-shadow:\s*-?\d+px\s+-?\d+px\s+0\s+var\(--[a-z0-9-]+\)\s*;?/g, (m) => {
    const n = Math.abs(Number(/box-shadow:\s*-?(\d+)px/.exec(m)?.[1] ?? 4));
    return n >= 6 ? 'box-shadow: var(--shadow-lg);' : n >= 4 ? 'box-shadow: var(--shadow);' : 'box-shadow: var(--shadow-sm);';
  });
  // light text that sat on loud blocks: cream now (unless this rule paints a gold ground)
  if (!/background(-color)?:\s*var\(--(ink|gold)\)/.test(r)) r = r.replace(/(^|[\s;{])color:\s*var\(--paper(-2|-3)?\)/g, '$1color: var(--cream)');
  r = r.replace(/\s*font-variation-settings:[^;}]*;?/g, '');
  // tidy empty declarations left behind
  r = r.replace(/;\s*;/g, ';').replace(/\{\s*;/g, '{ ');
  return r;
}
