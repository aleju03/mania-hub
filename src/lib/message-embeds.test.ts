import { describe, expect, it } from "vitest";

import { isEmbeddableImage, messageImageEmbeds } from "./message-embeds";

describe("messageImageEmbeds", () => {
  it("picks image links out of a message", () => {
    const text = "here https://files.catbox.moe/ab12.png and https://mania-tracker.com/maps?map=1 too";
    expect(messageImageEmbeds(text)).toEqual(["https://files.catbox.moe/ab12.png"]);
  });

  it("keeps a query string and shows each image once", () => {
    const text = "https://i.example.com/a.jpg?x=1\nhttps://i.example.com/a.jpg?x=1\nhttps://i.example.com/b.GIF";
    expect(messageImageEmbeds(text)).toEqual([
      "https://i.example.com/a.jpg?x=1",
      "https://i.example.com/b.GIF",
    ]);
  });

  it("does not embed plain text or insecure links", () => {
    expect(messageImageEmbeds("no links here")).toEqual([]);
    expect(messageImageEmbeds("http://old.example.com/a.png")).toEqual([]);
  });

  it("drops the sentence punctuation linkify trims", () => {
    expect(messageImageEmbeds("see https://i.example.com/a.png.")).toEqual(["https://i.example.com/a.png"]);
  });
});

describe("isEmbeddableImage", () => {
  it("rejects anything that is not an https image path", () => {
    expect(isEmbeddableImage("https://osu.ppy.sh/scores/7496926230")).toBe(false);
    expect(isEmbeddableImage("not a url")).toBe(false);
    expect(isEmbeddableImage("https://a.ppy.sh/123.jpeg")).toBe(true);
  });
});
