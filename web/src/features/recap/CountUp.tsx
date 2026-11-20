/*
  CountUp: a NumberTicker that starts at 0 when it mounts and rolls up to its value after a beat,
  with a little pop when it lands. Story cards mount fresh each time, so every number counts.
*/
import { useEffect, useState } from 'react';
import { sfx } from '../../fun';
import { NumberTicker } from '../../kit';

export function CountUp({ value, delay = 260, className, format, ding = false }: { value: number; delay?: number; className?: string; format?: (n: number) => string; ding?: boolean }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const t = window.setTimeout(() => setShown(value), delay);
    const d = ding && value > 0 ? window.setTimeout(() => sfx.pop(), delay + 820) : undefined;
    return () => {
      window.clearTimeout(t);
      if (d) window.clearTimeout(d);
    };
  }, [value, delay, ding]);
  return <NumberTicker value={shown} className={className} format={format} />;
}
