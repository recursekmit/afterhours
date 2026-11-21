-- How a slip set prints by default: a SLIP_SIZES key (e.g. 'quad': the morse slip's four tickets per A4
-- page), or NULL for the kit default (the 176 x 80 ticket). The console's "print slips as" can override it.
ALTER TABLE hunt_slip_sets ADD COLUMN print_size TEXT;
