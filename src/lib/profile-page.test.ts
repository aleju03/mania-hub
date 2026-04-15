import { describe, expect, it } from "vitest";
import { sanitizeProfilePageHtml } from "./profile-page";

describe("sanitizeProfilePageHtml", () => {
  it("preserves osu imagemap overlay geometry and titles", () => {
    const html = `
      <div class="imagemap">
        <img
          class="imagemap__image"
          loading="lazy"
          src="https://assets.ppy.sh/osu-web-test-resources/placeholder-1280x720.jpg"
          width="1280"
          height="720"
          alt="placeholder-1280x720.jpg"
        />
        <a
          class="imagemap__link"
          href="https://osu.ppy.sh/home"
          style="left:40%;top:50%;width:60%;height:70%;"
          title="go home"
        ></a>
        <span
          class="imagemap__link"
          style="left:9%;top:9%;width:9%;height:9%;"
          title="hover only"
        ></span>
      </div>
    `;

    const sanitized = sanitizeProfilePageHtml(html);

    expect(sanitized).toContain('class="imagemap"');
    expect(sanitized).toContain('class="imagemap__image"');
    expect(sanitized).toContain('href="https://osu.ppy.sh/home"');
    expect(sanitized).toContain('style="left:40%;top:50%;width:60%;height:70%"');
    expect(sanitized).toContain('title="go home"');
    expect(sanitized).toContain('title="hover only"');
  });

  it("still strips unsafe inline styles while keeping allowed imagemap geometry", () => {
    const html = `
      <a
        class="imagemap__link"
        href="https://osu.ppy.sh/home"
        style="left:40%;top:50%;width:60%;height:70%;position:fixed;background:url(javascript:alert(1))"
      ></a>
    `;

    const sanitized = sanitizeProfilePageHtml(html);

    expect(sanitized).toContain('style="left:40%;top:50%;width:60%;height:70%"');
    expect(sanitized).not.toContain("position:fixed");
    expect(sanitized).not.toContain("javascript:alert");
  });
});
