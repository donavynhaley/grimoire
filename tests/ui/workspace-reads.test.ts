import { describe, expect, it } from "vitest";
import { WorkspaceReads } from "../../src/lib/workspace-reads";

describe("workspace response lifetime", () => {
  it("rejects a resolved old response after switching projects even if cancellation was ignored", async () => {
    const reads = new WorkspaceReads();
    const committed: string[] = [];
    let finish!: (value: string) => void;
    let signal!: AbortSignal;
    const old = reads.run(
      "board",
      (input) => {
        signal = input;
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
      (value) => committed.push(value),
    );
    reads.reset();
    await reads.run(
      "board",
      async () => "B",
      (value) => committed.push(value),
    );
    finish("A");
    await old;
    expect(signal.aborted).toBe(true);
    expect(committed).toEqual(["B"]);
  });

  it("keeps the newest response on the same surface and discards late failures after sign-out", async () => {
    const reads = new WorkspaceReads();
    const committed: string[] = [];
    let fail!: (error: Error) => void;
    const old = reads.run(
      "ideas",
      () =>
        new Promise<string>((_, reject) => {
          fail = reject;
        }),
      (value) => committed.push(value),
    );
    await reads.run(
      "ideas",
      async () => "new",
      (value) => committed.push(value),
    );
    reads.reset();
    fail(new Error("old visit"));
    await expect(old).resolves.toBeUndefined();
    expect(committed).toEqual(["new"]);
  });
});
