import { type ChangeEvent, type FormEvent, useState } from "react";
import { Drawer } from "./Drawer";
import { Growing } from "./Growing";
import type { User } from "../../shared/types";
import { ApiError } from "../api/client";
import { Avatar } from "./Avatar";

const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"];
const AVATAR_SIZE_LIMIT = 2_000_000;
const PROFILE_ICONS = [
  { name: "BMO", path: "/profile-icons/profile_pic_bmo.png" },
  { name: "Finn", path: "/profile-icons/profile_pic_fin.png" },
  { name: "Gunter", path: "/profile-icons/profile_pic_gunter.png" },
  { name: "Ice King", path: "/profile-icons/profile_pic_ice_king.png" },
  { name: "Jake", path: "/profile-icons/profile_pic_jake.png" },
  { name: "Marceline", path: "/profile-icons/profile_pic_marceline.png" },
  { name: "Peppermint Butler", path: "/profile-icons/profile_pic_peppermint_butler.png" },
  { name: "Princess Bubblegum", path: "/profile-icons/profile_pic_princess_bubblegum.png" },
  { name: "The Lich", path: "/profile-icons/profile_pic_the_litch.png" },
] as const;

type Props = {
  user: User;
  onChangeAvatar: (file: File) => Promise<void>;
  onChangeName: (name: string) => Promise<void>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onClose: () => void;
  onLogout: () => Promise<void>;
  onRemoveAvatar: () => Promise<void>;
};

export function AccountDialog({
  user,
  onChangeAvatar,
  onChangeName,
  onChangePassword,
  onClose,
  onLogout,
  onRemoveAvatar,
}: Props) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const [displayName, setDisplayName] = useState(user.name);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState("");
  const [nameSaved, setNameSaved] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [selectedIcon, setSelectedIcon] = useState<string | null>(null);

  const pickAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setAvatarError("");
    if (!AVATAR_TYPES.includes(file.type)) {
      setAvatarError("Use a PNG, JPEG, or WebP image");
      return;
    }
    if (file.size > AVATAR_SIZE_LIMIT) {
      setAvatarError("Keep the picture under 2 MB");
      return;
    }
    setAvatarBusy(true);
    try {
      await onChangeAvatar(file);
      setSelectedIcon(null);
    } catch (value) {
      setAvatarError(value instanceof ApiError ? value.message : "The picture could not be uploaded");
    } finally {
      setAvatarBusy(false);
    }
  };

  const chooseIcon = async (name: string, path: string) => {
    setAvatarError("");
    setAvatarBusy(true);
    try {
      const response = await fetch(path);
      if (!response.ok) throw new Error("Profile icon could not be loaded");
      const image = await response.blob();
      const fileName = path.split("/").at(-1) ?? "profile-icon.png";
      await onChangeAvatar(new File([image], fileName, { type: "image/png" }));
      setSelectedIcon(path);
    } catch (value) {
      setAvatarError(value instanceof ApiError ? value.message : `${name} could not be selected`);
    } finally {
      setAvatarBusy(false);
    }
  };

  const removeAvatar = async () => {
    setAvatarError("");
    setAvatarBusy(true);
    try {
      await onRemoveAvatar();
      setSelectedIcon(null);
    } catch (value) {
      setAvatarError(value instanceof ApiError ? value.message : "The picture could not be removed");
    } finally {
      setAvatarBusy(false);
    }
  };

  const submitName = async (event: FormEvent) => {
    event.preventDefault();
    setNameError("");
    setNameSaved(false);
    const trimmed = displayName.trim();
    if (trimmed === user.name) return;
    setNameBusy(true);
    try {
      await onChangeName(trimmed);
      setNameSaved(true);
    } catch (value) {
      setNameError(value instanceof ApiError ? value.message : "Your name could not be changed");
    } finally {
      setNameBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setChanged(false);
    if (newPassword !== confirmation) {
      setError("New passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await onChangePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setChanged(true);
    } catch (value) {
      setError(value instanceof ApiError ? value.message : "Password could not be changed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer className="account-dialog" labelledBy="account-dialog-title" onClose={onClose}>
      <header className="dialog-header">
        <div>
          <p className="eyebrow">signed in as</p>
          <h2 id="account-dialog-title">Account settings</h2>
        </div>
        <button aria-label="Close account settings" className="icon-button" onClick={onClose} type="button">
          ×
        </button>
      </header>

      <div className="account-identity">
        <Avatar avatarUrl={user.avatarUrl} className="avatar large" name={user.name} />
        <div className="account-identity-copy">
          <strong>{user.name}</strong>
          <span>{user.email}</span>
        </div>
      </div>

      <form className="display-name-form" onSubmit={submitName}>
        <label>
          <span className="field-label">Display name</span>
          <input
            aria-label="Display name"
            autoComplete="name"
            maxLength={80}
            minLength={2}
            name="displayName"
            onChange={(event) => {
              setDisplayName(event.target.value);
              setNameSaved(false);
            }}
            required
            value={displayName}
          />
        </label>
        <button
          className="quiet-button"
          disabled={nameBusy || !displayName.trim() || displayName.trim() === user.name}
          type="submit"
        >
          {nameBusy ? "saving..." : "save name"}
        </button>
        <small>This is the name on your pages, ideas, and mentions everywhere in Grimoire.</small>
        {nameError && (
          <div className="error-banner" role="alert">
            {nameError}
          </div>
        )}
        {nameSaved && (
          <div className="success-banner" role="status">
            name updated
          </div>
        )}
      </form>

      <Growing className="avatar-editor">
        <fieldset className="profile-icon-picker" disabled={avatarBusy}>
          <legend className="field-label">Choose a profile icon</legend>
          <div className="profile-icon-grid">
            {PROFILE_ICONS.map((icon) => (
              <button
                aria-label={`Use ${icon.name} as profile picture`}
                aria-pressed={selectedIcon === icon.path}
                className="profile-icon-option"
                key={icon.path}
                onClick={() => void chooseIcon(icon.name, icon.path)}
                title={icon.name}
                type="button"
              >
                <img alt="" src={icon.path} />
              </button>
            ))}
          </div>
        </fieldset>
        <div className="avatar-actions">
          <label className="quiet-button avatar-upload">
            {avatarBusy ? "saving..." : user.avatarUrl ? "upload a different picture" : "upload a picture"}
            <input
              accept={AVATAR_TYPES.join(",")}
              aria-label="Upload profile picture"
              disabled={avatarBusy}
              onChange={(event) => void pickAvatar(event)}
              type="file"
            />
          </label>
          {user.avatarUrl && (
            <button
              className="text-button"
              disabled={avatarBusy}
              onClick={() => void removeAvatar()}
              type="button"
            >
              remove picture
            </button>
          )}
        </div>
        {avatarError && (
          <span className="avatar-error" role="alert">
            {avatarError}
          </span>
        )}
      </Growing>

      <form className="password-form" onSubmit={submit}>
        <p className="field-label">Change password</p>
        <input
          aria-label="Account email"
          autoComplete="username"
          className="sr-only"
          name="email"
          readOnly
          type="email"
          value={user.email}
        />
        <label>
          <span>Current password</span>
          <input
            autoComplete="current-password"
            name="currentPassword"
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
            type="password"
            value={currentPassword}
          />
        </label>
        <label>
          <span>New password</span>
          <input
            autoComplete="new-password"
            minLength={12}
            name="newPassword"
            onChange={(event) => setNewPassword(event.target.value)}
            required
            type="password"
            value={newPassword}
          />
          <small>Use at least 12 characters.</small>
        </label>
        <label>
          <span>Confirm new password</span>
          <input
            autoComplete="new-password"
            minLength={12}
            name="newPasswordConfirmation"
            onChange={(event) => setConfirmation(event.target.value)}
            required
            type="password"
            value={confirmation}
          />
        </label>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {changed && (
          <div className="success-banner" role="status">
            password changed
          </div>
        )}
        <button className="primary-button" disabled={busy} type="submit">
          {busy ? "changing..." : "change password"}
        </button>
      </form>

      <footer className="account-footer">
        <span>Other signed-in devices are logged out after a password change.</span>
        <button className="text-button danger-text" onClick={onLogout} type="button">
          sign out
        </button>
      </footer>
    </Drawer>
  );
}
