// Layout constants (canvas is 144x144). The Stream Deck button has rounded
// corners (radius ~20px on hardware), so we keep all content inside a safe
// inset and use a matching corner radius for our own border.
export const BORDER_INSET = 5;     // outer rect x/y offset
export const BORDER_SIZE = 144 - 2 * BORDER_INSET;
export const BORDER_RADIUS = 20;
export const BORDER_STROKE = 5;    // user requested +2 over previous 3px
export const VIEWPORT_X = 10;
export const VIEWPORT_W = 144 - 2 * VIEWPORT_X;
// Corner badges (slot number right, bg/suffix left) get their own band at the
// very top: the truncated label below is centered and can still span nearly the
// full viewport width, so anything sharing its baseline would collide.
export const BADGE_BASELINE = 19;
export const BADGE_FONT = 10;
export const TOP_BASELINE = 35;
export const TOP_FONT = 19;
// Shift the motif group down so it clears the top text descender (~y=39
// for TOP_BASELINE=35). Without this, idle/error/awaiting motifs whose top
// extent is y=32 visibly graze the project name above.
export const MOTIF_DY = 12;
/** Baseline of the single bottom line (the branch name). Sits low so it reads
 *  as anchored to the key's lower edge rather than floating under the motif. */
export const BOTTOM_BASELINE = 132;
export const BOTTOM_FONT = 17;
