import { describe, expect, it } from "vitest";

import { extractReadable } from "../tools/web-extract";

const articleHtml = `
<!doctype html>
<html>
  <head>
    <title>Sample Article</title>
    <meta property="og:title" content="Sample Article — OG">
    <meta name="description" content="A test article for extraction.">
  </head>
  <body>
    <header>Top nav junk</header>
    <article>
      <h1>Sample Article</h1>
      <p>This is the first paragraph of the test article. It has enough content for readability to pick it as the main body.</p>
      <p>Second paragraph adds more length so readability's heuristics actually fire.</p>
      <p>Third paragraph for good measure — readability requires non-trivial content density.</p>
    </article>
    <footer>Footer junk</footer>
  </body>
</html>
`;

const noBodyHtml = `
<!doctype html>
<html>
  <head>
    <title>Empty Page</title>
    <meta name="description" content="Just a tagline.">
  </head>
  <body></body>
</html>
`;

describe("extractReadable", () => {
  it("returns title + excerpt + markdown for an article", () => {
    const out = extractReadable(articleHtml, "https://example.com/post");
    // Readability prefers og:title when present; both are valid.
    expect(out.title).toMatch(/^Sample Article/);
    expect(out.excerpt).toBeTruthy();
    expect(out.markdown).toContain("This is the first paragraph");
    expect(out.markdown).toContain("Third paragraph");
  });

  it("falls back to meta description when body is empty", () => {
    const out = extractReadable(noBodyHtml, "https://example.com/empty");
    expect(out.title).toBe("Empty Page");
    expect(out.excerpt).toBe("Just a tagline.");
    expect(out.markdown).toBe("");
  });

  it("handles malformed HTML without throwing", () => {
    const out = extractReadable("<html><head></head><body>", "https://x.com/");
    expect(out.title).toBeNull();
    expect(out.markdown).toBe("");
  });
});
