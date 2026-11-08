import { JSDOM } from "jsdom";

export const window = new JSDOM("<!doctype html>").window;
export const document = window.document;
export const navigator = window.navigator;
export const Element = window.Element;
export const devicePixelRatio = 1;

window.HTMLCanvasElement.prototype.getContext = () => ({
  font: "20px sans-serif",
  measureText(text) {
    const fontSize = Number.parseFloat(this.font) || 20;
    return { width: Array.from(text).length * fontSize * 0.6 };
  },
});

export class FontFace {
  constructor(family, source, descriptors = {}) {
    this.family = family;
    this.source = source;
    this.display = descriptors.display ?? "auto";
    this.style = descriptors.style ?? "normal";
    this.weight = descriptors.weight ?? "normal";
    this.unicodeRange = descriptors.unicodeRange ?? "U+0-10FFFF";
  }

  async load() {
    return this;
  }
}
