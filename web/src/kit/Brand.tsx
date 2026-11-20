/*
  Recurse marks. The PNGs are used as they are: white on the dark ticket grounds (the default), black on paper prints,
  never recoloured or stretched (height only, width follows the aspect).
    <RecurseLogo on="light" height={28} />
    <ByRecurse />          "after hours, by [recurse]" lockup line
    <MadeByRecurse />      footer credit
*/
import black from '../assets/brand/recurse-logo-black.png';
import icon from '../assets/brand/recurse-icon.png';
import white from '../assets/brand/recurse-logo-white.png';
import s from './brand.module.css';

export function RecurseLogo({ on = 'dark', height = 28, className }: { on?: 'light' | 'dark'; height?: number; className?: string }) {
  return <img src={on === 'dark' ? white : black} alt="Recurse, KMIT's technical club" style={{ height, width: Math.round((height * 464) / 135) }} className={`${s.logo} ${className ?? ''}`} />;
}

export function RecurseIcon({ size = 32, className }: { size?: number; className?: string }) {
  return <img src={icon} alt="Recurse" width={size} height={size} className={`${s.icon} ${className ?? ''}`} />;
}

export function ByRecurse({ on = 'dark', height = 30 }: { on?: 'light' | 'dark'; height?: number }) {
  return (
    <span className={s.by}>
      <span className={s.byWord}>by</span>
      <RecurseLogo on={on} height={height} />
    </span>
  );
}

export function MadeByRecurse() {
  return (
    <footer className={s.footer}>
      <RecurseLogo height={34} />
      <p className={s.footerText}>made by recurse, the technical club of kmit, hyderabad. after hours is our chill afternoon. come say hi at the club room.</p>
    </footer>
  );
}
