// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthScreen } from "../../src/components/AuthScreen";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

const nothingToDo = async () => {};

describe("the sign-in screen", () => {
  it("offers the provider beside the password form, not instead of it", () => {
    render(<AuthScreen mode="login" oidc={{ label: "Authentik" }} onAuthenticated={nothingToDo} />);

    // Password sign-in stays the default; single sign-on is the second door.
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "sign in" })).toBeInTheDocument();

    const provider = screen.getByRole("link", { name: /continue with Authentik/i });
    expect(provider).toHaveAttribute("href", expect.stringContaining("/api/auth/oidc"));
  });

  it("offers nothing when the installation has no provider", () => {
    render(<AuthScreen mode="login" onAuthenticated={nothingToDo} />);
    expect(screen.queryByRole("link", { name: /continue with/i })).not.toBeInTheDocument();
  });

  it("never offers the provider on first run", () => {
    // The first account is the one that can never be locked out, so it is made here.
    render(<AuthScreen mode="setup" oidc={{ label: "Authentik" }} onAuthenticated={nothingToDo} />);
    expect(screen.queryByRole("link", { name: /continue with/i })).not.toBeInTheDocument();
  });

  it("carries where you were, so signing in from a link lands on that page", () => {
    window.history.replaceState({}, "", "/?project=abc&page=def");
    render(<AuthScreen mode="login" oidc={{ label: "Authentik" }} onAuthenticated={nothingToDo} />);

    const href = screen.getByRole("link", { name: /continue with Authentik/i }).getAttribute("href")!;
    const returnTo = new URLSearchParams(href.split("?")[1]).get("return");
    expect(returnTo).toBe("/?project=abc&page=def");
  });

  it("carries the invitation, which is what lets a provider sign-in make an account", () => {
    render(
      <AuthScreen inviteCode="an-invitation-code" mode="register" oidc={{ label: "Authentik" }} onAuthenticated={nothingToDo} />,
    );

    const href = screen.getByRole("link", { name: /continue with Authentik/i }).getAttribute("href")!;
    expect(new URLSearchParams(href.split("?")[1]).get("invite")).toBe("an-invitation-code");
  });

  it("shows why a provider sign-in came back without a session", () => {
    render(
      <AuthScreen
        mode="login"
        oidc={{ label: "Authentik" }}
        onAuthenticated={nothingToDo}
        providerError="No Grimoire account uses that email address."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("No Grimoire account uses that email address.");
  });

  it("does not carry a failed attempt's message into the next one", () => {
    window.history.replaceState({}, "", "/?signin_error=No+Grimoire+account+uses+that+email+address.");
    render(<AuthScreen mode="login" oidc={{ label: "Authentik" }} onAuthenticated={nothingToDo} providerError="No Grimoire account uses that email address." />);

    const href = screen.getByRole("link", { name: /continue with Authentik/i }).getAttribute("href")!;
    expect(new URLSearchParams(href.split("?")[1]).get("return")).toBe("/");
  });
});
