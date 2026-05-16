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

  it("collects meta (favicon, canonical, og, published) from <head>", () => {
    const html = `<!doctype html>
<html lang="en">
  <head>
    <title>T</title>
    <link rel="icon" href="/favicon.png">
    <link rel="canonical" href="https://canonical.example.com/post">
    <meta property="og:title" content="OG Title">
    <meta property="og:site_name" content="Example Times">
    <meta property="og:image" content="/og.jpg">
    <meta property="article:published_time" content="2024-01-02T03:04:05Z">
  </head>
  <body><article><p>A paragraph for readability content density.</p><p>More text for the article body so the parser keeps it.</p></article></body>
</html>`;
    const out = extractReadable(html, "https://example.com/post");
    expect(out.meta.favicon).toBe("https://example.com/favicon.png");
    expect(out.meta.canonical).toBe("https://canonical.example.com/post");
    expect(out.meta.siteName).toBe("Example Times");
    expect(out.meta.publishedTime).toBe("2024-01-02T03:04:05Z");
    expect(out.meta.lang).toBe("en");
    expect(out.meta.og?.image).toBe("https://example.com/og.jpg");
  });

  it("falls back to /favicon.ico when no rel=icon link present", () => {
    const html = `<!doctype html><html><head><title>x</title></head><body></body></html>`;
    const out = extractReadable(html, "https://example.com/page");
    expect(out.meta.favicon).toBe("https://example.com/favicon.ico");
  });

  it("collects YouTube iframe and normalizes youtu.be short link", () => {
    const html = `<!doctype html>
<html>
  <body>
    <iframe src="https://www.youtube.com/embed/abc123" title="A talk"></iframe>
    <iframe src="https://youtu.be/xyz789"></iframe>
    <iframe src="https://example-ads.com/banner"></iframe>
  </body>
</html>`;
    const out = extractReadable(html, "https://example.com/");
    expect(out.videos).toHaveLength(2);
    expect(out.videos[0].provider).toBe("youtube");
    expect(out.videos[0].url).toContain("/embed/abc123");
    expect(out.videos[0].title).toBe("A talk");
    expect(out.videos[1].url).toContain("/embed/xyz789");
    // Unrelated iframe must be filtered (host not in video whitelist).
    expect(out.videos.some((v) => v.url.includes("example-ads.com"))).toBe(
      false,
    );
  });

  it("collects <video> with poster and falls back to og:video", () => {
    const html = `<!doctype html>
<html>
  <head><meta property="og:video" content="https://cdn.example.com/clip.mp4"></head>
  <body>
    <video src="https://cdn.example.com/main.mp4" poster="https://cdn.example.com/thumb.jpg"></video>
  </body>
</html>`;
    const out = extractReadable(html, "https://example.com/");
    const direct = out.videos.find((v) => v.kind === "video");
    expect(direct?.url).toBe("https://cdn.example.com/main.mp4");
    expect(direct?.poster).toBe("https://cdn.example.com/thumb.jpg");
    const og = out.videos.find((v) => v.kind === "og");
    expect(og?.url).toBe("https://cdn.example.com/clip.mp4");
  });

  it("collects JSON-LD with type whitelist and field trim", () => {
    const html = `<!doctype html>
<html>
  <head>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Recipe",
      "name": "Chocolate Cake",
      "author": "Jane",
      "recipeIngredient": ["flour", "sugar"],
      "secretInternalField": "should be stripped"
    }
    </script>
    <script type="application/ld+json">
    {"@type": "Unsupported", "name": "ignored"}
    </script>
    <script type="application/ld+json">not-json</script>
  </head>
  <body></body>
</html>`;
    const out = extractReadable(html, "https://example.com/");
    expect(out.structuredData).toHaveLength(1);
    expect(out.structuredData[0].type).toBe("Recipe");
    expect(out.structuredData[0].data.name).toBe("Chocolate Cake");
    expect(out.structuredData[0].data.recipeIngredient).toEqual([
      "flour",
      "sugar",
    ]);
    // Non-whitelisted fields are dropped.
    expect(out.structuredData[0].data.secretInternalField).toBeUndefined();
  });

  it("handles @graph wrapper in JSON-LD", () => {
    const html = `<!doctype html>
<html>
  <head>
    <script type="application/ld+json">
    {
      "@graph": [
        {"@type": "Article", "headline": "Hello", "author": "A"},
        {"@type": "Person", "name": "A"}
      ]
    }
    </script>
  </head>
  <body></body>
</html>`;
    const out = extractReadable(html, "https://example.com/");
    expect(out.structuredData.length).toBeGreaterThanOrEqual(2);
    const types = out.structuredData.map((i) => i.type).sort();
    expect(types).toEqual(["Article", "Person"]);
  });
});
