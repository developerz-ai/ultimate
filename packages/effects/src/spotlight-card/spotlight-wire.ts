// SpotlightCard's two inputs over a card element: the pointer and keyboard focus.

import {
  type SpotlightBox,
  spotlightFocusPoint,
  spotlightPoint,
  spotlightVars,
} from './spotlight-card-view';

export interface SpotlightCardEl {
  getBoundingClientRect(): SpotlightBox;
  readonly style: { setProperty(name: string, value: string): void };
}

export interface SpotlightFocusEl {
  getBoundingClientRect(): SpotlightBox;
  matches(selector: string): boolean;
}

const aim = (card: SpotlightCardEl, point: { x: number; y: number }): void => {
  for (const [name, value] of Object.entries(spotlightVars(point))) {
    card.style.setProperty(name, value);
  }
};

export function spotlightPointer(card: SpotlightCardEl, clientX: number, clientY: number): void {
  aim(card, spotlightPoint(card.getBoundingClientRect(), clientX, clientY));
}

/** Only a keyboard focus (`:focus-visible`) aims; a mouse click inside is the pointer's. */
export function spotlightFocus(card: SpotlightCardEl, target: SpotlightFocusEl): void {
  if (!target.matches(':focus-visible')) return;
  aim(card, spotlightFocusPoint(card.getBoundingClientRect(), target.getBoundingClientRect()));
}
