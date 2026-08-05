import { type ChangeEvent, type FormEvent, useState } from "react";
import type { User } from "../../shared/types";
import { ApiError } from "../api/client";
import { Avatar } from "./Avatar";

const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"];
const AVATAR_SIZE_LIMIT = 2_000_000;

type Props = {
  user: User;
  onChangeAvatar: (file: File) => Promise<void>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onClose: () => void;
  onLogout: () => Promise<void>;
  onRemoveAvatar: () => Promise<void>;
};

export function AccountDialog({ user, onChangeAvatar, onChangePassword, onClose, onLogout, onRemoveAvatar }: Props) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState("");

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
    } catch (value) {
      setAvatarError(value instanceof ApiError ? value.message : "The picture could not be uploaded");
    } finally {
      setAvatarBusy(false);
    }
  };

  const removeAvatar = async () => {
    setAvatarError("");
    setAvatarBusy(true);
    try {
      await onRemoveAvatar();
    } catch (value) {
      setAvatarError(value instanceof ApiError ? value.message : "The picture could not be removed");
    } finally {
      setAvatarBusy(false);
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
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-labelledby="account-dialog-title" aria-modal="true" className="account-dialog" role="dialog">
        <header className="dialog-header">
          <div><p className="eyebrow">signed in as</p><h2 id="account-dialog-title">Account settings</h2></div>
          <button aria-label="Close account settings" className="icon-button" onClick={onClose} type="button">×</button>
        </header>

        <div className="account-identity">
          <Avatar avatarUrl={user.avatarUrl} className="avatar large" name={user.name} />
          <div className="account-identity-copy">
            <strong>{user.name}</strong>
            <span>{user.email}</span>
          </div>
        </div>

        <div className="avatar-editor">
          <label className="quiet-button avatar-upload">
            {avatarBusy ? "uploading..." : user.avatarUrl ? "change picture" : "upload picture"}
            <input
              accept={AVATAR_TYPES.join(",")}
              aria-label="Upload profile picture"
              disabled={avatarBusy}
              onChange={(event) => void pickAvatar(event)}
              type="file"
            />
          </label>
          {user.avatarUrl && (
            <button className="text-button" disabled={avatarBusy} onClick={() => void removeAvatar()} type="button">
              remove picture
            </button>
          )}
          {avatarError && <span className="avatar-error" role="alert">{avatarError}</span>}
        </div>

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
          <label><span>Current password</span><input autoComplete="current-password" name="currentPassword" onChange={(event) => setCurrentPassword(event.target.value)} required type="password" value={currentPassword} /></label>
          <label><span>New password</span><input autoComplete="new-password" minLength={12} name="newPassword" onChange={(event) => setNewPassword(event.target.value)} required type="password" value={newPassword} /><small>Use at least 12 characters.</small></label>
          <label><span>Confirm new password</span><input autoComplete="new-password" minLength={12} name="newPasswordConfirmation" onChange={(event) => setConfirmation(event.target.value)} required type="password" value={confirmation} /></label>
          {error && <div className="error-banner" role="alert">{error}</div>}
          {changed && <div className="success-banner" role="status">password changed</div>}
          <button className="primary-button" disabled={busy} type="submit">{busy ? "changing..." : "change password"}</button>
        </form>

        <footer className="account-footer">
          <span>Other signed-in devices are logged out after a password change.</span>
          <button className="text-button danger-text" onClick={onLogout} type="button">sign out</button>
        </footer>
      </section>
    </div>
  );
}
