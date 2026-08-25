# Remove Mattermost

Every step is idempotent and safe to re-run.

## 1. Remove the registration

Delete `import './mattermost.js';` from `src/channels/index.ts`, skipping it if
it is already absent.

## 2. Remove the channel files

```bash
rm -f src/channels/mattermost.ts src/channels/mattermost-registration.test.ts
rm -rf src/channels/mattermost-adapter
```

## 3. Remove credentials

Remove `MATTERMOST_BASE_URL`, `MATTERMOST_BOT_TOKEN`,
`MATTERMOST_CALLBACK_URL`, and `MATTERMOST_CALLBACK_SECRET` from `.env`.

## 4. Remove direct dependencies

If no other locally installed channel imports `ws`, remove the dependencies:

```bash
pnpm uninstall ws @types/ws
```

## 5. Optional local server

The evaluation server is deliberately not removed automatically because its
volumes contain Mattermost data. If it was created only for NanoClaw and the
data is no longer needed, follow the teardown instructions in `LOCAL_SERVER.md`.

## 6. Rebuild and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```
