// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { buildIssueBody, newIssueUrl, REPO_URL } from "./repo";

describe("newIssueUrl", () => {
  it("is the repository's new-issue form", () => {
    expect(newIssueUrl()).toBe(`${REPO_URL}/issues/new`);
  });

  it("carries the body, encoded, and nothing else", () => {
    const url = new URL(newIssueUrl("**What happened?**\n\nPage: https://a.b/c?d=1"));
    expect(url.origin + url.pathname).toBe(`${REPO_URL}/issues/new`);
    expect([...url.searchParams.keys()]).toEqual(["body"]);
    expect(url.searchParams.get("body")).toBe("**What happened?**\n\nPage: https://a.b/c?d=1");
  });
});

describe("buildIssueBody", () => {
  it("writes a bold prompt with room under it, then the known facts", () => {
    expect(
      buildIssueBody({
        prompts: ["What happened?", "What did you expect?"],
        facts: [
          { label: "Page", value: "https://acme.lacaisse.eu/members" },
          { label: "Version", value: "688624f" },
        ],
      }),
    ).toBe(
      [
        "**What happened?**",
        "",
        "",
        "",
        "**What did you expect?**",
        "",
        "",
        "",
        "---",
        "Page: https://acme.lacaisse.eu/members",
        "Version: 688624f",
      ].join("\n"),
    );
  });

  it("skips unknown facts, and the rule when none is known", () => {
    expect(
      buildIssueBody({
        prompts: ["What happened?"],
        facts: [
          { label: "Page", value: "https://acme.lacaisse.eu/" },
          { label: "Version", value: null },
        ],
      }),
    ).toBe("**What happened?**\n\n\n\n---\nPage: https://acme.lacaisse.eu/");
    expect(
      buildIssueBody({ prompts: ["What happened?"], facts: [{ label: "Version", value: undefined }] }),
    ).toBe("**What happened?**\n\n\n");
  });
});
