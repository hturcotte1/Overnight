// All text in this file is made up for the tests. None of it is Bee data.
import { describe, expect, it } from "vitest";
import { isNearDuplicate, titleTokens } from "../src/index.ts";

describe("titleTokens", () => {
  it("drops case, punctuation and filler words, and folds plurals", () => {
    expect([...titleTokens("The Plant-Watering Tracker (for my plants!)")].sort()).toEqual(["plant", "tracker", "watering"]);
    expect([...titleTokens("Who's turn?")].sort()).toEqual(["turn", "who"]); // crude: "whos" loses its s
    expect([...titleTokens("Movies & dishes & boxes & glasses")].sort()).toEqual(["box", "dish", "glass", "movy"]);
    expect([...titleTokens("movie status bus")].sort()).toEqual(["bus", "movy", "status"]);
    expect(titleTokens("My app").size).toBe(0);
  });
});

describe("isNearDuplicate", () => {
  const recent = ["Plant watering tracker", "Lunch turn tracker", "Bin day page"];

  it("spots the same idea worded a little differently", () => {
    expect(isNearDuplicate("Plant watering tracker", recent)).toBe(true);
    expect(isNearDuplicate("plant watering tracker app", recent)).toBe(true);
    expect(isNearDuplicate("Watering tracker for plants", recent)).toBe(true);
    expect(isNearDuplicate("A tiny PLANT-watering tracker!", recent)).toBe(true);
    expect(isNearDuplicate("My plants tracker", recent)).toBe(true); // "plant tracker" sits inside "plant watering tracker"
    expect(isNearDuplicate("Lunch turns tracker", recent)).toBe(true);
    expect(isNearDuplicate("Bin days", recent)).toBe(true);
  });

  it("lets a different idea through", () => {
    expect(isNearDuplicate("Habit tracker", recent)).toBe(false);
    expect(isNearDuplicate("Chore turn wheel", recent)).toBe(false);
    expect(isNearDuplicate("Meeting cost timer", recent)).toBe(false);
    expect(isNearDuplicate("Tracker", recent)).toBe(false); // one word is too thin to be "inside" another title
    expect(isNearDuplicate("Plant watering tracker", [])).toBe(false);
    expect(isNearDuplicate("", recent)).toBe(false);
  });

  it("still compares titles made only of filler words", () => {
    expect(isNearDuplicate("My app", ["my app!"])).toBe(true);
    expect(isNearDuplicate("My app", ["Your tool"])).toBe(false);
    expect(isNearDuplicate("My app", ["Plant tracker"])).toBe(false);
  });
});
