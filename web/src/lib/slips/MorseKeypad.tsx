/*
  "Type it instead": a tappable Morse keypad (dot, dash, next letter, next word,
  undo) plus a plain word box. Both produce the same StripReading the camera does
  (confidence 1, position 'bottom'), so callers never care where a reading came from.
*/
import { useState } from 'react';
import { type StripReading, decodeMorse, encodeWord, normaliseMorse } from '../../../../shared/src/morse-slip';
import { decodePattern } from '@afterhours/shared/features/morse';
import { haptics, sfx } from '../../fun';
import { Button, IconButton, TextField } from '../../kit';
import s from './slips.module.css';

export function readingFromMorse(morse: string): StripReading | null {
  const m = normaliseMorse(morse);
  if (!m) return null;
  return { morse: m, text: decodeMorse(m), confidence: 1, position: 'bottom' };
}

export function readingFromWord(word: string): StripReading | null {
  try {
    const e = encodeWord(word);
    return { morse: e.morse, text: e.text, confidence: 1, position: 'bottom' };
  } catch {
    return null;
  }
}

export function MorseKeypad({ onSubmit, onCancel }: { onSubmit: (r: StripReading) => void; onCancel?: () => void }) {
  const [seq, setSeq] = useState('');
  const [word, setWord] = useState('');
  const m = normaliseMorse(seq);
  const letters = m ? m.split(' / ').map((w) => w.split(' ')) : [];
  const push = (c: string) => {
    setSeq((v) => {
      if (c === ' ' && (v === '' || v.endsWith(' '))) return v;
      if (c === ' / ' && (v === '' || v.endsWith(' / '))) return v;
      if (c === ' / ' && v.endsWith(' ')) return `${v.trimEnd()} / `;
      return v + c;
    });
  };
  const key = (c: '.' | '-') => {
    push(c);
    sfx.note(660, c === '.' ? 70 : 210, 'sine');
    haptics.buzz(c === '.' ? 18 : 55);
  };
  const undo = () => {
    sfx.tick();
    setSeq((v) => (v.endsWith(' / ') ? v.slice(0, -3) : v.slice(0, -1)));
  };
  const fromKeys = readingFromMorse(seq);
  const fromWord = word.trim() ? readingFromWord(word) : null;
  return (
    <div className={s.keypad} data-testid="morse-keypad">
      <div className={s.tape} aria-live="polite">
        {letters.length === 0 ? (
          <p className={s.tapeEmpty}>tap the dots and dashes on the bottom strip, left to right</p>
        ) : (
          <div className={s.tapeLetters}>
            {letters.map((w, wi) => (
              <span key={wi} className={s.tapeWord}>
                {w.map((l, li) => (
                  <span key={li} className={s.tapeLetter}>
                    <span className={s.tapeSyms}>
                      {[...l].map((c, ci) => (
                        <i key={ci} className={c === '.' ? s.symDot : s.symDash} />
                      ))}
                    </span>
                    <b className={decodePattern(l) === '?' ? s.tapeBad : undefined}>{decodePattern(l)}</b>
                  </span>
                ))}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className={s.keys}>
        <button type="button" className={`${s.key} ${s.keyDot}`} onPointerDown={() => key('.')} aria-label="dot">
          <i className={s.symDot} />
        </button>
        <button type="button" className={`${s.key} ${s.keyDash}`} onPointerDown={() => key('-')} aria-label="dash">
          <i className={s.symDash} />
        </button>
        <IconButton icon="undo" label="undo" onClick={undo} disabled={!seq} />
      </div>
      <div className={s.keysRow}>
        <Button tone="sky" size="sm" onClick={() => push(' ')} disabled={!seq}>
          next letter
        </Button>
        <Button tone="grape" size="sm" onClick={() => push(' / ')} disabled={!seq}>
          next word
        </Button>
        <Button tone="paper" size="sm" ghost onClick={() => setSeq('')} disabled={!seq}>
          clear
        </Button>
      </div>
      <Button tone="lime" block icon="check" disabled={!fromKeys} onClick={() => fromKeys && onSubmit(fromKeys)} data-testid="keypad-submit">
        {fromKeys?.text ? `that's ${fromKeys.text.toLowerCase()}` : fromKeys ? 'send these dots' : 'send it'}
      </Button>
      <form
        className={s.wordRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (fromWord) onSubmit(fromWord);
        }}
      >
        <TextField label="or type the word, if you decoded it" value={word} onChange={(e) => setWord(e.target.value.toUpperCase())} autoCapitalize="characters" autoComplete="off" placeholder="WORD" error={word.trim() && !fromWord ? 'letters and digits only' : null} />
        <Button type="submit" tone="sun" disabled={!fromWord}>
          send word
        </Button>
      </form>
      {onCancel && (
        <Button tone="paper" ghost size="sm" onClick={onCancel}>
          back to the camera
        </Button>
      )}
    </div>
  );
}
