# dsh-weiming-hpc

A DeepSeek Harness bundle for logging in to the Peking University Weiming HPC
cluster (`wm1-data`, `wm1-login`, `wm2-data`, `wm2-login`) with a password and a
TOTP code, and running remote Bash commands from the agent.

The bundle contributes three tools and one runtime skill:

| Tool | Purpose |
| --- | --- |
| `wm_server_status` | Checks the credentials file, permissions, TOTP parameters and target nodes; returns the acquisition steps when anything is missing. Optional `probe` tests TCP 22 reachability. |
| `wm_server_setup` | Parses the text copied from the HPC one-time-password QR code (WeChat scan), validates the TOTP secret, and writes the credentials file with mode `600`. Requires an explicit `account`. |
| `wm_server_run` | Runs a remote Bash login command on one target with password + TOTP authentication and returns stdout, stderr and the exit code. |

## Install

Clone the repository:

```sh
git clone git@github.com:ThywQuake/Weiming-Server-Easy-SSH.git
```

Then either use **Plugins** > **Add plugin** and pick the checkout directory, or
from an agent session call `plugin_manager` with `action: install_bundle` and the
checkout's absolute path. Installed bundles affect every session of the profile.

Requires DeepSeek Harness with bundle support and a POSIX host that provides
`ssh` (the plugin drives `/usr/bin/ssh`).

## First use

1. Call `wm_server_status`. On a machine without credentials it returns
   `configured: false` together with the setup steps instead of attempting a
   login.
2. Open the HPC one-time-password binding page, generate the QR code, scan it
   with WeChat, and copy the recognized text (usually an `otpauth://totp/...`
   URI). Scanning completes the binding.
3. Call `wm_server_setup` with `bindingText` = that text, `password` = the HPC
   login password, and `account` = your student/staff ID. The account is
   required: the bundle has no built-in default and never guesses one. Add
   `verify: true` to run `hostname; whoami` on `wm2-data` afterwards.
4. Call `wm_server_run` to verify, for example
   `command: 'hostname; pwd; ls -lah -- "$HOME"'` with `target: 'wm2-login'`.

## Credentials

The default path is `~/.config/wm2/credentials.json`; set `WM_HPC_CREDENTIALS`
to use another file. The file must be owned by the current user and readable
only by them (`chmod 600`); otherwise the tools refuse to use it and report
`permissions` or `owner`.

```json
{
  "password": "…",
  "totp_secret": "BASE32SECRET",
  "digits": 6,
  "period": 30,
  "algorithm": "sha1",
  "user": "2023000000",
  "nodes": {
    "wm2-login": { "host": "wm2-login.pku.edu.cn", "user": "2023000000" }
  }
}
```

`user` is required; there is no built-in default account. `nodes.<target>`
overrides `host` and `user`; the common fields stay in effect for the other
targets. `wm_server_setup` merges into the existing file, so rebinding a new OTP
secret keeps the stored password and node overrides.

## Security and limits

- The password and TOTP secret are read by the host plugin and by a short-lived
  `SSH_ASKPASS` helper; they never appear in SSH's command line or in a tool
  result. Results expose only a key fingerprint.
- `StrictHostKeyChecking=yes` is always on. A new or changed host key fails the
  connection; verify fingerprints through a trusted channel before accepting.
- Each prompt kind (password, TOTP) is answered at most once per connection; a
  repeated prompt stops the attempt instead of risking a locked account.
- The SSH connection has no TTY; interactive remote programs are unsupported.
- File transfer is not implemented. Use SCP/SFTP/rsync separately, through a
  data node.
- A local timeout stops the local `ssh` process, not the remote one. Check
  whether a job was already submitted before retrying.
