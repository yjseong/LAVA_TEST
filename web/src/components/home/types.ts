/** The volcano the user picked (selected-volcano-store in the Dash app). */
export interface Selected {
  name: string;
  number: number | null;
  /** marker-popup: picked on the map (opens a big bubble, the side panel stays shut). card: picked from a side-panel card (opens the panel). */
  via: "marker-popup" | "card";
  /** counts up on every pick, so picking the same volcano again re-opens its bubble and flies there again */
  pick: number;
}

export const INITIAL_BOUNDS: [[number, number], [number, number]] = [[-22.0, 80.0], [63.0, 180.0]];
// extra room in the south-west: the legend covers that corner

/** height of the big bubble (~370 px) plus its arrow, from the top of the map down to the triangle */
export const POPUP_ROOM_PX = 410;
