# Backup, restore, and upgrade

A recoverable Grimoire instance needs its SQLite database and its Markdown directory from the same point in time.
The database includes accounts, memberships, discussions, activity, credentials, and settings.
The Markdown directory includes pages, ideas, chapters, and attachments.
Saving only one loses part of the instance.

These commands assume `compose.yaml`, run from the checkout, with its default `./data` mount.
For `compose.production.yaml`, add `-f compose.production.yaml` to every Compose command below.
For a systemd deployment, stop and start its service instead, and archive the configured `GRIMOIRE_DATABASE` and `GRIMOIRE_PAGES_DIRECTORY` paths together.

## Make a restore point

Choose an existing backup directory on a different volume, writable only by the operator.
Keep an encrypted copy off the host too.
The archive contains private project content and authentication material.
Back up `.env` separately in your secrets store, along with the proxy configuration and any external attachment or pages paths.

```sh
umask 077
backup_dir=/mnt/backups/grimoire
backup_file="$backup_dir/grimoire-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
mkdir -p "$backup_dir"
git rev-parse HEAD > "$backup_file.commit"
docker compose stop grimoire
if tar -czpf "$backup_file" data; then
  docker compose start grimoire
  sha256sum "$backup_file" > "$backup_file.sha256"
else
  docker compose start grimoire
  echo 'Backup failed; do not use the incomplete archive.' >&2
  exit 1
fi
```

Stop every process that writes the database or Markdown, including external editors and import jobs, for the duration of the copy.
Copying a live SQLite main file alone misses writes in its WAL and cannot coordinate those writes with the Markdown files.
An offline copy of the entire data directory preserves both, including any SQLite sidecar files.
Schedule this during a quiet window; retain daily and weekly restore points according to how much work you can afford to lose.
Alert on a failed backup, and monitor disk space rather than silently pruning the last good copy.

## Rehearse a restore

Restore into a separate checkout at the commit recorded beside the archive.
Use a different port and no production tunnel, email provider, or GitHub credential.
A restored database still holds the original accounts and integration settings, so isolate its network before starting it.

```sh
sha256sum -c /mnt/backups/grimoire/grimoire-TIMESTAMP.tar.gz.sha256
mkdir recovery-data
tar -xzpf /mnt/backups/grimoire/grimoire-TIMESTAMP.tar.gz -C recovery-data
```

The extracted directory is `recovery-data/data`.
Configure the rehearsal to use that directory, never the original data mount.
Start the matching application version, sign in, open a project, read a page and its discussion, and open an attachment.
Create and edit a temporary page, restart the rehearsal, and confirm that the edit persists.
Check `GET /api/health` too, but do not treat a healthy process as proof that the restored work is complete.
Record the archive, commit, date, and outcome of the rehearsal.

## Restore an instance

Stop the service and any external writers first.
Preserve the current data directory for investigation; extract into a clean directory rather than merging old and restored files.
Merging leaves newer pages behind and can produce a board that never existed.

```sh
docker compose stop grimoire
mv data "data-before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
tar -xzpf /mnt/backups/grimoire/grimoire-TIMESTAMP.tar.gz
```

Restore the matching configuration and application commit, then build and start it:

```sh
git switch --detach RECORDED_COMMIT
docker compose build grimoire
docker compose up -d grimoire
docker compose ps
docker compose logs --tail=100 grimoire
```

Check health, sign-in, representative pages, discussions, attachments, and a persisted edit before opening access again.
A restore returns the whole instance to the backup time; later work is not retained automatically.
If the restore follows a credential compromise, rotate the affected credentials and invalidate restored sessions before exposing the instance.

## Upgrade deliberately

Read the target release notes for migration requirements and supported upgrade paths.
Use a release tag or an exact commit, and keep the prior commit and a tested backup together.
Do not rely on an older binary being able to read a database that a newer one has migrated.

1. Confirm a clean checkout with `git status --short`, and record `git rev-parse HEAD`.
2. Fetch tags with `git fetch origin --tags`.
3. Take the restore point above and verify its checksum.
4. Check out the reviewed release with `git switch --detach vX.Y.Z`.
5. Run `docker compose build grimoire` while the current container is still serving.
6. Run `docker compose up -d grimoire` to replace the container.
7. Check health and logs, then sign in and verify existing work and a new edit.

A build failure leaves the old container running.
A startup failure may happen after migrations have changed data, so rollback restores the pre-upgrade archive and its matching commit together, using the restore procedure above.
Keep access closed during rollback to avoid losing new writes.
Once the upgrade is verified, take another backup and retain the pre-upgrade one through your rollback window.
