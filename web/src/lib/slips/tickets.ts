/*
  The four engraved ticket designs (owner's art in design/tickets, cropped by scripts/tickets.mjs).
  Each entry: the art field (inside the ticket's own double rule) for print and for screens, the sampled
  ground colour, and where the field's own plaque, square frame and star divider sit, as fractions of
  the field, so the slip renderer can write into them exactly.
*/
import type { SlipTicket } from '@afterhours/shared/morse-slip';
import armillaryField from '../../assets/tickets/armillary-field.jpg';
import armillaryFieldSm from '../../assets/tickets/armillary-field-sm.webp';
import ginkgoField from '../../assets/tickets/ginkgo-field.jpg';
import ginkgoFieldSm from '../../assets/tickets/ginkgo-field-sm.webp';
import ruinsField from '../../assets/tickets/ruins-field.jpg';
import ruinsFieldSm from '../../assets/tickets/ruins-field-sm.webp';
import waveField from '../../assets/tickets/wave-field.jpg';
import waveFieldSm from '../../assets/tickets/wave-field-sm.webp';

export interface FracRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TicketArt {
  id: SlipTicket;
  label: string;
  /** sampled from the art: the deep ground */
  ground: string;
  /** the engraving's ink (antique gold, or cream for ginkgo) */
  ink: string;
  /** art field, print quality (JPEG) and small (WebP) */
  field: string;
  fieldSm: string;
  /** field pixel size (aspect) */
  fieldW: number;
  fieldH: number;
  plaque: FracRect;
  square: FracRect;
  /** x of the vertical star divider */
  dividerX: number;
}

const r = (x0: number, y0: number, x1: number, y1: number): FracRect => ({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });

export const TICKET_ART: Record<SlipTicket, TicketArt> = {
  armillary: { id: 'armillary', label: 'armillary sphere (maroon)', ground: '#28051b', ink: '#e3c48a', field: armillaryField, fieldSm: armillaryFieldSm, fieldW: 1402, fieldH: 608, plaque: r(0.335, 0.398, 0.704, 0.668), square: r(0.762, 0.234, 0.986, 0.755), dividerX: 0.732 },
  wave: { id: 'wave', label: 'great wave (navy)', ground: '#131d37', ink: '#e3c48a', field: waveField, fieldSm: waveFieldSm, fieldW: 1415, fieldH: 612, plaque: r(0.319, 0.389, 0.703, 0.659), square: r(0.763, 0.233, 0.988, 0.741), dividerX: 0.733 },
  ginkgo: { id: 'ginkgo', label: 'ginkgo and lantern (forest)', ground: '#101513', ink: '#e8e2c8', field: ginkgoField, fieldSm: ginkgoFieldSm, fieldW: 1406, fieldH: 609, plaque: r(0.304, 0.323, 0.716, 0.605), square: r(0.77, 0.207, 0.992, 0.707), dividerX: 0.742 },
  ruins: { id: 'ruins', label: 'ruins and wisteria (plum)', ground: '#27132d', ink: '#e3c48a', field: ruinsField, fieldSm: ruinsFieldSm, fieldW: 1412, fieldH: 611, plaque: r(0.324, 0.346, 0.71, 0.607), square: r(0.77, 0.211, 0.989, 0.708), dividerX: 0.742 },
};

/** The cream the ribbon and margin print in: light enough to be quiet zone for the scanner. */
export const TICKET_CREAM = '#f3e8cc';
