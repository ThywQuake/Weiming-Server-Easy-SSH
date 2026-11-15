# dsh-weiming-hpc

[English](README.md) | 简体中文

用于登录北京大学未名高性能计算平台、并在 agent 中执行远程 Bash 命令的
DeepSeek Harness 插件。通过密码 + 动态口令（TOTP）完成 SSH 认证，内置未名一号、
未名二号、未名生科一号三个集群；其他节点可以在凭据文件里声明后使用。

本项目是个人维护的 DSH 插件，并非平台官方客户端。

插件提供三个工具和一个运行时 skill：

| 工具 | 用途 |
| --- | --- |
| `wm_server_status` | 检查凭据文件、权限、TOTP 参数、目标节点和本机 ssh/askpass 支持情况；`probe: true` 时额外判断校园网/VPN 路径。 |
| `wm_server_setup` | 解析扫码得到的 OTP 绑定文字，校验 TOTP 密钥，并以权限 `600` 写入凭据文件。`account` 必填；省略 `bindingText` 时只更新账号（0.1.x 升级路径）；`verify: true` 会执行一次 `hostname; whoami`，默认在 `wm1-login`，可用 `verifyTarget` 指定节点。 |
| `wm_server_run` | 先探测目标节点 22 端口：不在校园网且未连 VPN 时返回 `network-unavailable`，不会提交密码或 OTP；可达时执行一条远程 Bash 命令并返回 stdout、stderr 和退出码。 |

## 集群与节点

地址以官方文档 [连接集群](https://hpc.pku.edu.cn/ug/guide/access/) 为准。平台不支持密钥认证，只能密码 + OTP：

| 集群 | 登录节点 | 数据传输节点 |
| --- | --- | --- |
| 未名一号（`wm1`） | `wm1-login.pku.edu.cn` | `wm1-data.pku.edu.cn` |
| 未名二号（`wm2`） | `wm2-login.pku.edu.cn` | `wm2-data.pku.edu.cn` |
| 未名生科一号（`wmsk1`） | `wmsk1-login.pku.edu.cn` | `wmsk1-data.pku.edu.cn` |

登录节点用于提交和查询作业，不能联网；数据传输节点可以联网、访问存储，但不能提交作业。
调用 `wm_server_run` 时必须显式指定 `target`。

内置节点之外可以自行声明，例如未名教学二号：

```json
{ "nodes": { "wmjx2-login": { "host": "wmjx2-login.pku.edu.cn" } } }
```

写入凭据文件的 `nodes` 后，就能直接把它当作 `target` 使用。

## 平台支持

| 平台 | 状态 | SSH 客户端 |
| --- | --- | --- |
| macOS | 支持 | `/usr/bin/ssh` |
| Linux | 支持 | `/usr/bin/ssh`、`/usr/local/bin/ssh` 或 `PATH` 中的 `ssh` |
| Windows 10/11 + [Git for Windows](https://gitforwindows.org/) | 支持 | `C:\Program Files\Git\usr\bin\ssh.exe`（MSYS2） |
| Windows 自带 OpenSSH | 不支持 | `C:\Windows\System32\OpenSSH\ssh.exe` 无法启动脚本式 askpass |

密码和动态口令通过临时生成的 `SSH_ASKPASS` 助手提交，因此要求 ssh 客户端能执行
shell 脚本，并用 Electron/Node 运行该助手。Windows 自带的 `ssh.exe` 通过
`CreateProcess` 启动 askpass，不能执行 `.sh` 脚本，不同版本的 `SSH_ASKPASS`
行为也不一致；插件会优先使用 Git for Windows 的 MSYS2 `ssh.exe`，只找到系统自带
客户端时会直接给出可操作的错误提示，而不是卡在密码输入。在 WSL 里运行 DSH 则走
Linux 路径。

Windows 路径已经实现，CI 在 Windows 上会跑单测（ssh 发现、路径映射等），但没有
覆盖真实的密码 + TOTP 登录；遇到 Windows 特有问题时请附上 `wm_server_status` 的输出。

## 安装

克隆仓库：

```sh
git clone git@github.com:ThywQuake/Weiming-Server-Easy-SSH.git
```

然后在 **插件** > **添加插件** 中选择该目录，或在 agent 会话里调用
`plugin_manager`（`action: install_bundle`，`target` 为目录绝对路径）。安装后对该
profile 的所有会话生效。

Windows 上请先安装 Git for Windows。

## 校园网与 VPN

未名集群的可达性取决于网络路径：部分大陆网络可以直连 22 端口，校外、境外或经过
过滤的网络通常会超时。插件会在认证前先检查：

- `wm_server_run` 先探测目标节点 22 端口，不可达时返回 `network-unavailable` 和
  处理建议，不提交密码或 OTP；设置 `skipNetworkCheck: true` 可跳过探测。
- `wm_server_status` 的 `probe: true` 会把路径分类为 `reachable`、`off-campus`、
  `offline`、`dns` 或 `blocked`，并在本机有校园网地址时列出。

端口不可达时，工具会提示连接校园网或学校 VPN 后重试：

- `vpn.pku.edu.cn`：Pulse Secure / Ivanti 客户端，全业务模式，所有协议可用，本地
  ssh 可以直接连。
- `pacvpn.pku.edu.cn`：仅校园内网模式，通常足够访问 HPC 节点。
- 使用分流模式时，确认 `162.105.0.0/16` 和 `115.27.0.0/16` 走 VPN。
- WebVPN 只代理网页，不能承载 SSH；无法安装 VPN 客户端时，可用浏览器版
  https://wpn.pku.edu.cn 的网页 SSH 作为手工替代。
- 已连 VPN 仍不通时，目标节点可能正在维护。

## 首次配置

1. 调用 `wm_server_status`。没有凭据时会返回 `configured: false` 和配置步骤，不会
   尝试登录。
2. 打开 https://hpc.pku.edu.cn/authotp/otp ，登录后点击 **重新绑定手机令牌**，用
   FreeOTP / Google Authenticator 绑定二维码。若要把密钥交给本插件，再用能读取
   二维码文字的工具（例如微信）扫同一张码，复制 `otpauth://totp/...` 文字。扫码即
   完成绑定。
3. 调用 `wm_server_setup`：`bindingText` 为复制的文字，`password` 为 HPC 登录密码，
   `account` 为学号/工号。账号必填，插件不内置默认账号，也不会猜。可加
   `verify: true` 验证登录（默认 `wm1-login`，可用 `verifyTarget` 换节点）。
4. 调用 `wm_server_run` 验证，例如 `command: 'hostname; pwd; ls -lah -- "$HOME"'`，
   `target` 选 `wm1-login`、`wm2-login` 或 `wmsk1-login`。

## 升级说明

### 从 0.2.x 升级到 0.3.x

凭据路径从 `~/.config/wm2/credentials.json` 改为中性的
`~/.config/weiming-hpc/credentials.json`。首次调用任一工具时会自动复制迁移，旧文件
保留作备份，不会删除。`WM_HPC_CREDENTIALS` 仍然优先。

### 从 0.1.x 升级

0.1.x 没有保存账号字段，而是回退到内置默认学号。升级后 `wm_server_status` 会报告
`account` 问题，但密码和 TOTP 密钥通常仍然有效。不需要重新扫码：

```text
wm_server_setup(account: "2023000000")
```

省略 `bindingText` 时会保留原有的 `password`、`totp_secret`、`digits`、`period`、
`algorithm` 和 `nodes`，只补写 `user`。如果凭据文件缺失或存在其他问题，工具会拒绝
并提示完整配置。

## 凭据

默认路径为 `~/.config/weiming-hpc/credentials.json`；设置 `WM_HPC_CREDENTIALS`
可以改用其他文件。macOS 和 Linux 上文件必须属于当前用户且只有本人可读
（`chmod 600`），否则工具会报告 `permissions` 或 `owner` 并拒绝使用。Windows 上
POSIX 权限位没有意义，工具依赖用户目录的 NTFS ACL：请把文件放在自己的用户目录内，
不要共享。

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

`user` 必填，没有内置默认账号。`nodes.<target>` 可以覆盖单个节点的 `host` 和
`user`，其余目标继续使用公共字段。`wm_server_setup` 会合并写入，重新绑定 OTP 时
会保留已有密码和节点覆盖。

## 测试

单测不需要额外依赖，也不需要真实 HPC 账号：

```sh
node --test
```

覆盖 TOTP、绑定文字解析、凭据权限与合并、ssh 失败分类、校园网分类（使用本地 TCP
监听端口）以及旧路径迁移。CI 在 Linux、macOS、Windows 三个平台运行同一套测试；
Windows job 只验证 ssh 发现和路径映射等逻辑，不做真实的密码登录。

## 故障排查

| 现象 | 含义 / 处理 |
| --- | --- |
| `network-unavailable` | 目标节点 22 端口不可达。连接校园网或学校 VPN（https://vpn.pku.edu.cn）后重试；只有确认探测误报时才用 `skipNetworkCheck: true`。 |
| `host-key` | 节点不在 `known_hosts`，或主机密钥变了。先在终端连接一次，通过可信渠道核对指纹后再重试；不要关闭 `StrictHostKeyChecking`。 |
| `auth-failed` | 密码或 OTP 不匹配，或 OTP 绑定未完成。检查手机时间和绑定状态，最多再试一次。 |
| `error`，提示 ssh 不可用 | 安装可用的 ssh 客户端（macOS/Linux 用系统 OpenSSH；Windows 用 Git for Windows），然后重新运行 `wm_server_status`。 |
| 升级后提示缺少账号 | 用 `wm_server_setup(account: "…")` 补账号，不需要重新扫码。 |

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `WM_HPC_CREDENTIALS` | 使用其他凭据文件。 |
| `WM_HPC_SSH` | 指定其他 ssh 可执行文件（例如自定义 Git/Cygwin 安装）。 |
| `WM_HPC_SSH_KIND` | 强制指定 ssh 类型：`posix`、`msys` 或 `cygwin`。 |

## 安全与限制

- 密码和 TOTP 密钥只由宿主插件和短生命周期的 `SSH_ASKPASS` 助手读取，不会出现在
  ssh 命令行或工具返回值中；结果只暴露密钥指纹。
- 始终启用 `StrictHostKeyChecking=yes`。新主机或密钥变化会导致连接失败，需要先通过
  可信渠道核对指纹；主机密钥读取 ssh 客户端默认的 `known_hosts`。
- 每次连接中每种凭据最多提交一次；重复提示会中止尝试，避免账号被锁。
- SSH 连接没有 TTY，不支持交互式远程程序。
- 插件不实现文件传输；上传下载请用 SCP/SFTP/rsync，并走数据传输节点。
- 本地超时只终止本机 ssh 进程，不保证远程进程停止；重试前先确认作业是否已经提交。
- 校园网/VPN 探测只是辅助判断；确认探测有误时可用 `skipNetworkCheck: true` 强制尝试。

## 相关链接

- 仓库：https://github.com/ThywQuake/Weiming-Server-Easy-SSH
- 平台文档：https://hpc.pku.edu.cn/ug/
- 集群地址：https://hpc.pku.edu.cn/ug/guide/access/
- OTP 绑定：https://hpc.pku.edu.cn/authotp/otp
