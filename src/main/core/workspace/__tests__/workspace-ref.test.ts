import { describe, expect, it } from "vitest";

import {
  decodeRef,
  encodeRef,
  type WorkspaceRef,
  workspaceRefId,
  workspaceRefLabel,
} from "../workspace-ref";

describe("workspace-ref", () => {
  describe("workspaceRefId", () => {
    it("yields stable id for local refs", () => {
      const id = workspaceRefId({ kind: "local", path: "/Users/foo/proj" });
      expect(id).toBe("local:/Users/foo/proj");
    });

    it("yields stable id for github refs independent of credentialId", () => {
      const a = workspaceRefId({
        kind: "github",
        owner: "acme",
        repo: "app",
        ref: "main",
        credentialId: "cred-1",
      });
      const b = workspaceRefId({
        kind: "github",
        owner: "acme",
        repo: "app",
        ref: "main",
        credentialId: "cred-2",
      });
      expect(a).toBe(b);
      expect(a).toBe("github:acme/app@main");
    });

    it("namespaces local and github", () => {
      const local = workspaceRefId({
        kind: "local",
        path: "acme/app@main",
      });
      const gh = workspaceRefId({
        kind: "github",
        owner: "acme",
        repo: "app",
        ref: "main",
        credentialId: "x",
      });
      expect(local).not.toBe(gh);
    });
  });

  describe("encode / decode round-trip", () => {
    it("preserves local refs", () => {
      const ref: WorkspaceRef = { kind: "local", path: "/abs/path" };
      expect(decodeRef(encodeRef(ref))).toEqual(ref);
    });

    it("preserves github refs", () => {
      const ref: WorkspaceRef = {
        kind: "github",
        owner: "acme",
        repo: "app",
        ref: "main",
        credentialId: "abc-123",
      };
      expect(decodeRef(encodeRef(ref))).toEqual(ref);
    });

    it("decode rejects garbage and missing fields", () => {
      expect(decodeRef(null)).toBeNull();
      expect(decodeRef("")).toBeNull();
      expect(decodeRef("not json")).toBeNull();
      expect(decodeRef("{}")).toBeNull();
      expect(decodeRef('{"kind":"local"}')).toBeNull();
      expect(
        decodeRef('{"kind":"github","owner":"x","repo":"y","ref":"z"}'),
      ).toBeNull();
      expect(decodeRef('{"kind":"unknown","path":"/x"}')).toBeNull();
    });
  });

  describe("workspaceRefLabel", () => {
    it("uses last path segment for local", () => {
      expect(workspaceRefLabel({ kind: "local", path: "/Users/x/proj" })).toBe(
        "proj",
      );
    });

    it("uses owner/repo@ref for github", () => {
      expect(
        workspaceRefLabel({
          kind: "github",
          owner: "acme",
          repo: "app",
          ref: "main",
          credentialId: "x",
        }),
      ).toBe("acme/app@main");
    });
  });
});
