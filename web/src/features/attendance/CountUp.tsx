/* CountUp: like the kit's NumberTicker, but it counts up from `from` (default 0) when it first appears. */
import { useEffect, useState } from 'react';
import { NumberTicker } from '../../kit';

export function CountUp({ value, from = 0, delayMs = 80, format, className }: { value: number; from?: number; delayMs?: number; format?: (n: number) => string; className?: string }) {
  const [v, setV] = useState(from);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return <NumberTicker value={v} format={format} className={className} />;
}
