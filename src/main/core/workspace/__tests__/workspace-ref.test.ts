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

    it("drops host from gitlab.com label, keeps it for self-hosted", () => {
      expect(
        workspaceRefLabel({
          kind: "gitlab",
          host: "gitlab.com",
          namespace: "acme",
          project: "app",
          ref: "main",
          credentialId: "x",
        }),
      ).toBe("acme/app@main");
      expect(
        workspaceRefLabel({
          kind: "gitlab",
          host: "gitlab.example.com",
          namespace: "acme/sub",
          project: "app",
          ref: "main",
          credentialId: "x",
        }),
      ).toBe("gitlab.example.com/acme/sub/app@main");
    });
  });

  describe("gitlab encode/decode round-trip", () => {
    it("preserves all gitlab fields", () => {
      const ref: WorkspaceRef = {
        kind: "gitlab",
        host: "gitlab.example.com",
        namespace: "acme/sub",
        project: "app",
        ref: "main",
        credentialId: "abc",
      };
      expect(decodeRef(encodeRef(ref))).toEqual(ref);
    });

    it("workspaceRefId includes host so different instances don't collide", () => {
      const a = workspaceRefId({
        kind: "gitlab",
        host: "gitlab.com",
        namespace: "acme",
        project: "app",
        ref: "main",
        credentialId: "x",
      });
      const b = workspaceRefId({
        kind: "gitlab",
        host: "gitlab.example.com",
        namespace: "acme",
        project: "app",
        ref: "main",
        credentialId: "x",
      });
      expect(a).not.toBe(b);
      expect(a).toBe("gitlab:gitlab.com:acme/app@main");
      expect(b).toBe("gitlab:gitlab.example.com:acme/app@main");
    });

    it("decode rejects gitlab refs with missing fields", () => {
      expect(
        decodeRef('{"kind":"gitlab","host":"x","namespace":"y","project":"z"}'),
      ).toBeNull();
    });
  });
});
