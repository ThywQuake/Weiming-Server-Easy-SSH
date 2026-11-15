# dsh-weiming-hpc

English | [简体中文](README.zh-CN.md)

A DeepSeek Harness bundle for logging in to the Peking University Weiming HPC
platform with a password and a TOTP code, and running remote Bash commands from
the agent. Built-in clusters: Weiming No.1 (`wm1-*`), Weiming No.2 (`wm2-*`) and
Weiming Life Sciences No.1 (`wmsk1-*`); additional nodes can be declared in the
credentials file.

This is an unofficial, community-maintained bundle, not an official PKU HPC
client.

The bundle contributes three tools and one runtime skill:

| Tool | Purpose |
| --- | --- |
| `wm_server_status` | Checks the credentials file, permissions, TOTP parameters, target nodes and the local ssh/askpass support. `probe: true` also classifies the campus network / VPN path. |
| `wm_server_setup` | Parses the text copied from the HPC one-time-password QR code, validates the TOTP secret, and writes the credentials file with mode `600`. Requires an explicit `account`. With `bindingText` omitted it only updates the account, keeping the stored password and TOTP secret. `verify: true` runs `hostname; whoami`, on `wm1-login` by default or on `verifyTarget`. |
| `wm_server_run` | Probes the target's port 22 first: outside the campus network and without the school VPN it returns `network-unavailable` instead of submitting a password or OTP. Otherwise it runs one remote Bash login command with password + TOTP and returns stdout, stderr and the exit code. |

## Clusters and nodes

Addresses follow the official guide at
https://hpc.pku.edu.cn/ug/guide/access/ (no key authentication; password + OTP
only):

| Cluster | Login node | Data node |
| --- | --- | --- |
| Weiming No.1 (`wm1`) | `wm1-login.pku.edu.cn` | `wm1-data.pku.edu.cn` |
| Weiming No.2 (`wm2`) | `wm2-login.pku.edu.cn` | `wm2-data.pku.edu.cn` |
| Weiming Life Sciences No.1 (`wmsk1`) | `wmsk1-login.pku.edu.cn` | `wmsk1-data.pku.edu.cn` |

Login nodes submit and query jobs but have no internet access; data nodes have
internet access and storage but cannot submit jobs. `target` must be chosen
explicitly. Other nodes, such as the teaching cluster's `wmjx2-login`, can be
declared in `nodes` and then used as a target:

```json
{ "nodes": { "wmjx2-login": { "host": "wmjx2-login.pku.edu.cn" } } }
```

## Platform support

| Platform | Status | SSH client |
| --- | --- | --- |
| macOS | supported | `/usr/bin/ssh` |
| Linux | supported | `/usr/bin/ssh`, `/usr/local/bin/ssh`, or `ssh` on `PATH` |
| Windows 10/11 with [Git for Windows](https://gitforwindows.org/) | supported | `C:\Program Files\Git\usr\bin\ssh.exe` (MSYS2) |
| Windows inbox OpenSSH | not supported | `C:\Windows\System32\OpenSSH\ssh.exe` cannot start the askpass helper |

The password and TOTP prompts are answered by a generated `SSH_ASKPASS` helper,
so the client must be able to start a shell-script helper and run it with the
Electron/Node binary. Microsoft's inbox `ssh.exe` creates the helper through
`CreateProcess`, which cannot execute a `.sh` script, and its `SSH_ASKPASS`
behavior differs between versions. On Windows the bundle therefore prefers the
MSYS2 `ssh.exe` from Git for Windows and fails fast with an actionable message
when only the inbox client is available. Running DSH inside WSL uses the Linux
path instead.

The Windows path is implemented, and CI runs the unit tests on Windows as well;
that job covers ssh discovery and path mapping, not a real password login.
Report Windows-specific issues with the output of `wm_server_status`.

## Install

Clone the repository:

```sh
git clone git@github.com:ThywQuake/Weiming-Server-Easy-SSH.git
```

Then either use **Plugins** > **Add plugin** and pick the checkout directory, or
from an agent session call `plugin_manager` with `action: install_bundle` and the
checkout's absolute path. Installed bundles affect every session of the profile.

On Windows, install Git for Windows first.

## Campus network and VPN

Reachability of the Weiming nodes depends on the path: some networks (including
parts of the mainland internet) open port 22 directly, while off-campus,
overseas or filtered networks time out. The bundle checks the path before it
spends time on authentication:

- `wm_server_run` probes the chosen node's port 22 first. If the port is not
  reachable it returns `network-unavailable` with guidance and does not attempt
  a login, so no password or OTP is submitted. Set `skipNetworkCheck: true` to
  bypass the probe.
- `wm_server_status` with `probe: true` classifies the path as one of
  `reachable`, `off-campus`, `offline`, `dns` or `blocked`, and lists the local
  campus interface when one is present.

When the port is unreachable the tools ask the user to connect to the campus
network (PKU Secure/PKU or the wired network) or to the school VPN and retry:

- `vpn.pku.edu.cn` with the Pulse Secure / Ivanti client — full tunnel, all
  protocols, so local ssh works.
- `pacvpn.pku.edu.cn` — campus-intranet-only mode, usually enough for the HPC
  nodes.
- If a split tunnel is in use, make sure `162.105.0.0/16` and `115.27.0.0/16`
  go through the VPN.
- WebVPN (`webvpn`) only proxies web pages and cannot carry SSH. The
  browser-based WPN at https://wpn.pku.edu.cn offers web SSH to campus hosts
  (the HPC platform is listed there) as a manual fallback when no VPN client
  can be installed.
- If the VPN is connected and the port is still closed, the node may be under
  maintenance.

## First use

1. Call `wm_server_status`. On a machine without credentials it returns
   `configured: false` together with the setup steps instead of attempting a
   login.
2. Open https://hpc.pku.edu.cn/authotp/otp , sign in, click **重新绑定手机令牌**
   and bind the QR code with FreeOTP / Google Authenticator. To give the secret
   to this bundle, scan the same QR code with a text-reading scanner (for
   example WeChat) and copy the `otpauth://totp/...` text. Scanning completes
   the binding.
3. Call `wm_server_setup` with `bindingText` = that text, `password` = the HPC
   login password, and `account` = your student/staff ID. The account is
   required: the bundle has no built-in default and never guesses one. Add
   `verify: true` to run `hostname; whoami` afterwards (on `wm1-login` by
   default; pass `verifyTarget` for another node).
4. Call `wm_server_run` to verify, for example
   `command: 'hostname; pwd; ls -lah -- "$HOME"'` with `target: 'wm1-login'`,
   `'wm2-login'` or `'wmsk1-login'`.

## Credentials

The default path is `~/.config/weiming-hpc/credentials.json`; set
`WM_HPC_CREDENTIALS` to use another file. On macOS and Linux the file must be
owned by the current user and readable only by them (`chmod 600`); otherwise the
tools refuse to use it and report `permissions` or `owner`. On Windows the
POSIX mode bits are not meaningful, so the tools rely on the ACLs of the user
profile: keep the file inside your user directory and do not share it.

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

## Tests

The unit tests need no dependencies and no real HPC account:

```sh
node --test
```

They cover TOTP, binding-text parsing, credential permissions and merging, ssh
failure classification, and the campus-network classifier (with local TCP
listeners). CI runs the same suite on Linux, macOS and Windows; the Windows run
exercises ssh discovery and path mapping, not a real password login.

## Troubleshooting

| Symptom | Meaning / action |
| --- | --- |
| `network-unavailable` | The node's port 22 is not reachable. Connect the campus network or the school VPN (https://vpn.pku.edu.cn), then retry; use `skipNetworkCheck: true` only if the probe is wrong. |
| `host-key` | The node is not in `known_hosts`, or its key changed. Connect once from a terminal, verify the fingerprint through a trusted channel, then retry. Never disable `StrictHostKeyChecking`. |
| `auth-failed` | Password or TOTP mismatch, or the OTP binding is incomplete. Check the clock and the binding, then retry at most once. |
| `error` with a message about ssh | Install a usable client (`/usr/bin/ssh`, or Git for Windows on Windows) and rerun `wm_server_status`. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `WM_HPC_CREDENTIALS` | Use a different credentials file. |
| `WM_HPC_SSH` | Use a different ssh executable (for example a custom Git or Cygwin install). |
| `WM_HPC_SSH_KIND` | Force the detected ssh flavor: `posix`, `msys` or `cygwin`. |

## Security and limits

- The password and TOTP secret are read by the host plugin and by a short-lived
  `SSH_ASKPASS` helper; they never appear in SSH's command line or in a tool
  result. Results expose only a key fingerprint.
- `StrictHostKeyChecking=yes` is always on. A new or changed host key fails the
  connection; verify fingerprints through a trusted channel before accepting.
  Host keys are read from the ssh client's normal `known_hosts` file.
- Each prompt kind (password, TOTP) is answered at most once per connection; a
  repeated prompt stops the attempt instead of risking a locked account.
- The SSH connection has no TTY; interactive remote programs are unsupported.
- File transfer is not implemented. Use SCP/SFTP/rsync separately, through a
  data node.
- A local timeout stops the local `ssh` process, not the remote one. Check
  whether a job was already submitted before retrying.
- The campus/VPN probe is advisory: `skipNetworkCheck: true` forces a login
  attempt when the probe is wrong (for example on an unusual tunnel).
