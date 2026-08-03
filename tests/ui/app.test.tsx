// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { workspaceFixture } from "../fixtures/workspace";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("Grimoire application", () => {
  it("guides the first owner through secure workspace setup", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => response({ status: "setup_required" }))
      .mockImplementationOnce(() =>
        response(
          {
            user: {
              id: "00000000-0000-4000-8000-000000000010",
              name: "Donavyn",
              email: "donavyn@example.com",
              role: "owner",
            },
          },
          201,
        ),
      )
      .mockImplementationOnce(() => response(workspaceFixture()));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(await screen.findByRole("heading", { name: /create your grimoire/i })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/your name/i), "Donavyn");
    await userEvent.type(screen.getByLabelText(/email/i), "donavyn@example.com");
    await userEvent.type(screen.getByLabelText(/^password/i), "correct horse wizard tower");
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));

    expect(await screen.findByText(/make wizard sight essential/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/bootstrap",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("captures an idea and refreshes the shared workspace", async () => {
    const initial = workspaceFixture();
    const updated = workspaceFixture();
    updated.ideas = [
      {
        ...updated.ideas[0],
        id: "00000000-0000-4000-8000-000000000041",
        title: "Give the tower door a memory of Maren",
      },
      ...updated.ideas,
    ];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => response({ status: "authenticated", user: initial.currentUser }))
      .mockImplementationOnce(() => response(initial))
      .mockImplementationOnce(() => response({ idea: updated.ideas[0] }, 201))
      .mockImplementationOnce(() => response(updated));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const input = await screen.findByLabelText(/capture an idea/i);
    await userEvent.type(input, "Give the tower door a memory of Maren");
    fireEvent.submit(input.closest("form")!);

    expect(await screen.findByText("Give the tower door a memory of Maren")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ideas",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("creates a playable outcome from the outcomes workspace", async () => {
    const initial = workspaceFixture();
    const createdOutcome = {
      id: "00000000-0000-4000-8000-000000000050",
      title: "The tower door reveals one memory",
      description: "A complete observation beat.",
      status: "shaping",
      ownerId: initial.currentUser.id,
      ownerName: "Donavyn",
      milestoneId: initial.milestones[0].id,
      pillarId: initial.pillars[0].id,
      definitionOfPlayable: "The memory can be found without explanation.",
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
    } as const;
    const updated = workspaceFixture();
    updated.outcomes = [createdOutcome];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => response({ status: "authenticated", user: initial.currentUser }))
      .mockImplementationOnce(() => response(initial))
      .mockImplementationOnce(() => response({ outcome: createdOutcome }, 201))
      .mockImplementationOnce(() => response(updated));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /^outcomes$/i }));
    await userEvent.click(screen.getByRole("button", { name: /new outcome/i }));
    await userEvent.type(screen.getByLabelText(/outcome title/i), createdOutcome.title);
    await userEvent.type(screen.getByLabelText(/definition of playable/i), createdOutcome.definitionOfPlayable);
    await userEvent.click(screen.getByRole("button", { name: /create outcome/i }));

    await waitFor(() => expect(screen.getByText(createdOutcome.title)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/outcomes",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

