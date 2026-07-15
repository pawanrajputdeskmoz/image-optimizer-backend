# Image Optimizer Backend

## Storage cleanup (cron)

Old image backups under `storage/YYYY/MM/DD/` are removed after `RESTORE_BACKUP_DAYS` (default: 30 days). This matches the restore retention policy in the app.

Example: on **15-07-2026 at 00:00**, the script deletes `storage/2026/06/15/`.

### Manual run

```bash
npm run cleanup:storage
```

Dry run (shows path only, no delete):

```bash
DRY_RUN=true npm run cleanup:storage
```

### Linux / VPS — schedule at midnight

1. SSH into the server
2. Create logs folder (once):

```bash
mkdir -p /path/to/backend/logs
```

3. Edit crontab:

```bash
crontab -e
```

4. Add this line (update the path):

```cron
0 0 * * * cd /path/to/backend && /usr/bin/node scripts/cleanupOldStorage.js >> logs/storage-cleanup.log 2>&1
```

Runs every night at **00:00** (server local time).

### Verify / stop

List scheduled jobs:

```bash
crontab -l
```

Remove the line from `crontab -e` to stop the job.

### Windows (local)

Use **Task Scheduler** instead of cron:

- **Program:** full path to `node.exe`
- **Arguments:** `scripts/cleanupOldStorage.js`
- **Start in:** project backend folder
- **Trigger:** Daily at 12:00 AM
