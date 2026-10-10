// The only place that says which idea state may follow which.
// heard → asked → (approved | rejected | expired) → building → (built | build_failed)
//       → (published | publish_failed) → delivered
import type { IdeaState } from "./types.ts";

const ALLOWED: Record<IdeaState, readonly IdeaState[]> = {
  heard: ["asked"],
  asked: ["approved", "rejected", "expired"],
  approved: ["building"],
  rejected: [],
  expired: [],
  building: ["built", "build_failed"],
  built: ["published", "publish_failed"],
  // A failed build or publish can be tried again on a later night.
  build_failed: ["building"],
  published: ["delivered"],
  publish_failed: ["published"],
  delivered: [],
};

export function canTransition(from: IdeaState, to: IdeaState): boolean {
  return ALLOWED[from].includes(to);
}

export class InvalidTransitionError extends Error {
  readonly from: IdeaState;
  readonly to: IdeaState;
  constructor(from: IdeaState, to: IdeaState) {
    super(`An idea cannot go from "${from}" to "${to}".`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: IdeaState, to: IdeaState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function nextStates(from: IdeaState): readonly IdeaState[] {
  return ALLOWED[from];
}

/** States in which an idea is finished and nothing more will happen to it. */
export function isTerminal(state: IdeaState): boolean {
  return ALLOWED[state].length === 0;
}
