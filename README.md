# multi-cmd

自用，纯vide coding项目

Windows 上的**多终端聚合器**：一个窗口里可以切成多块**区域**，每块区域有**自己的一条页签栏**（VS Code 编辑器组那种），
分割线从窗口顶部一直贯穿到底、连页签栏一起切开。每个终端都是真正的本地终端进程。

```
┌─────────────────────────────────┬─────────────────────────────────┐
│ [ PowerShell ] [ cmd ]      + ▤ │ [ PowerShell ]              + ▤ │  ← 每个区域一条页签栏
├─────────────────────────────────┼─────────────────────────────────┤
│ ● PowerShell      D:\work       │ ● PowerShell      C:\Users      │
│ PS D:\work> git status          │ PS C:\Users> _                  │
│ On branch main                  │                                 │
│ PS D:\work> _                   │                                 │
└─────────────────────────────────┴─────────────────────────────────┘
      ↑ 分割线从这里（窗口最顶）开始，贯穿页签栏和终端区
 区域 1/2 · PowerShell · 页签 1/2 · 149×34   [分屏 → 本区域新增页签]   D:\work
```

## 特性

- **页签栏属于区域，不属于窗口**：一个区域一条页签栏、独立滚动、各带一个 ➕ 按钮；
  分割线夹在两个区域之间，所以它会把页签栏也一起切开。
- **页签左对齐、按内容宽度排列**：不会因为窗口拉宽而被拉开或居中，也没有任何数字角标。
- **三档分屏粒度**（状态栏的「分屏 → …」胶囊点一下循环切换，或每个区域页签栏右侧的 ▤ 按钮）：
  - `本区域新增页签`（默认）—— `Ctrl+Shift+D` 在当前区域里再开一个页签
  - `新窗口` —— 把终端拆成独立窗口，可并排摆到两个显示器
  - `新区域（切开页签栏）` —— 切出一块新区域，分割线贯穿整个窗口
  - 无论哪种模式，`Ctrl+Shift+E` 都是**直接切出新区域**
- **默认终端可设**：页签栏右侧（或状态栏）点一下就能在 PowerShell / cmd / Git Bash / WSL 之间切换默认终端，
  之后新建的页签都用它；选择会写进设置文件，重启后仍然生效。
- **按路径开终端 + 路径历史**：`Ctrl+Shift+O` 或页签栏的文件夹图标，可以输入路径、用系统文件夹选择框浏览，
  也可以在历史记录里点一下就开——**不用再手动 cd**。常用路径自动排在前面，目录被删掉的会标出来。
- **真正的 PTY**：每个终端是一个独立的 `node-pty` 会话（ConPTY），不是伪终端模拟，`vim`、`git`、`npm`、交互式程序都能正常跑。
- **自动发现 shell**：PowerShell 7 / Windows PowerShell / cmd / Git Bash / WSL 发行版 / MSYS2，启动时探测。
- **二进制安全输出**：PTY 原始字节 → base64 → xterm 的 `write(Uint8Array)`，中文和 emoji 不会在分块边界变成乱码。
- **背压保护**：刷屏命令（`dir /s`、`npm i` 日志）按 8ms 合批推送，单会话最多积压 4MB。
- **布局持久化**：关闭程序再打开，区域划分、每个区域的页签、分屏方式、每个终端的工作目录都会恢复。
- **懒启动**：页签第一次被切到才真正 spawn 进程，恢复一个大布局不会一次性拉起一堆终端。
- **进程退出可重启**：终端里的 shell 退出后页签变红并显示提示，按 Enter 原地重启。

## 分屏方式

**默认「本区域新增页签」** —— `Ctrl+Shift+D` 只是给当前区域加一个页签，不切分窗口：

```
                    ┌──────────────────────────────────────────────────────────────┐
Ctrl+Shift+D   →    │ [ PowerShell ] [ PowerShell ] [ cmd ]                + ▤    │
                    │  PS D:\work> _                                              │
                    └──────────────────────────────────────────────────────────────┘
```

**「新区域」或 `Ctrl+Shift+E`** —— 切出一块新区域，分割线把页签栏一起切开：

```
                    ┌───────────────────────────┬──────────────────────────────────┐
Ctrl+Shift+E   →    │ [ PowerShell ] [ cmd ]  ▤ │ [ PowerShell ]              + ▤  │
                    │  PS D:\work> _            │  PS D:\work> _                   │
                    │                           │                                  │
                    └───────────────────────────┴──────────────────────────────────┘
```

**「新窗口」** —— 开一个新的应用窗口：同一个进程、同一个单实例锁，
每个窗口有自己的一套区域和页签栏；新窗口**从干净的一个页签开始**，并且不会覆盖主窗口保存的布局。

**关闭区域**：状态栏「关闭本区域」按钮 / `Ctrl+Shift+Q` / 右键菜单。
区域里的终端**不会被杀掉**，它们的页签会原样并入相邻区域。

## 设置默认终端（PowerShell / cmd）

页签栏右侧有一个显示当前默认终端的按钮（状态栏左边的「默认终端：…」也一样），点开就能切换：

```
┌──────────────────────────────────────────────┬──────────────────────────────┐
│ [ Windows PowerShell ] [ 命令提示符 ]        │  命令提示符  +  ▤            │  ← 点这个按钮切换
└──────────────────────────────────────────────┴──────────────────────────────┘
                                                       ↓
                              ● 命令提示符        cmd.exe
                                　Windows PowerShell  powershell.exe
                                ────────────────────────────────
                                立刻开一个 命令提示符 页签    Ctrl+Shift+T
```

- 切换后**之后新建的页签**都用它（`Ctrl+Shift+T`、页签栏的 ➕、`Ctrl+Shift+D` 分屏）
- 已存在的终端不受影响，不会被打断
- 选择存在状态文件的 `settings.defaultShellId` 里，**重启后仍然生效**
- 命令行想覆盖：启动前设 `MULTI_CMD_SHELL=cmd`（优先级低于界面里显式选过的值）
- 探测到什么就能选什么：PowerShell 7 / Windows PowerShell / cmd / Git Bash / WSL 发行版 / MSYS2
- 右键任意终端也有一份「把 xxx 设为默认终端」

## 在指定路径打开终端（带历史记录）

页签栏右侧的文件夹图标 / `Ctrl+Shift+O` / 右键「选择路径并打开终端…」：

```
┌ 在指定路径打开终端 ─────────────────────────────────────────────┐
│ [ D:\work\code\multi_cmd\.tmp-proj          ] [浏览…] [当前终端目录] │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ D:\work\code\multi_cmd\.tmp-proj     3 次 · 5 分钟前      ✕ │ │
│ │ ~\projects\api                        1 次 · 2 天前       ✕ │ │
│ │ D:\old\deleted-dir                    目录不存在          ✕ │ │
│ └────────────────────────────────────────────────────────────┘ │
│ Enter 打开 · Esc 取消                              [取消] [打开] │
└────────────────────────────────────────────────────────────────┘
```

- **输入框**：手输或粘贴路径，Enter 直接开；`浏览…` 走系统文件夹选择框；`当前终端目录` 一键填入
- **历史记录**：鼠标移到某一行会把路径填进输入框，点一下直接开；每行右边 ✕ 可以删掉这条
- **排序**：按「用过几次」优先，其次按最近使用；目录已经不存在的会灰掉+划掉，点了会提示
- **持久化**：历史存在状态文件的 `settings.recentPaths`（最多 40 条），重启后还在
- **校验**：路径不存在或不是目录会被拦下来并提示，不会开出一个坏终端
- 打开后**终端的工作目录就是选的这个路径**，不用再 `cd`
- 页签栏的文件夹图标点开的是精简版（前 12 条历史 + 选择路径入口），适合快速点

## 安装与运行

```powershell
npm install
npm start
```

`npm start` 会先构建再启动 Electron。开发时用：

```powershell
npm run dev     # 构建 + 启动 + 打开 DevTools
```

## 打包成可双击的 exe

```powershell
npm run dist              # 便携版 exe + 安装包（推荐）
npm run dist:portable     # 只要单文件便携版
npm run pack              # 只要免安装目录（最快，用来验证）
npm run dist:edit-exe     # 有代码签名证书时：保留 exe 改写（自定义图标）
```

产物都在 `release/`：

| 文件 | 说明 |
| --- | --- |
| `release/multi-cmd-0.1.0-portable.exe` | **单文件便携版（约 71MB）**，双击直接运行，不写注册表，换机器直接拷走 |
| `release/multi-cmd-0.1.0-setup.exe` | NSIS 安装包，装到 `%LOCALAPPDATA%\Programs\multi-cmd`，自动建桌面/开始菜单快捷方式 |
| `release/win-unpacked/electron.exe` | 免安装目录版，双击即用（想放 U 盘可以整个目录拷走） |

打包脚本 `scripts/package.mjs` 的流程（顺序不能换）：

1. esbuild 打包源码 → 2. 生成图标（没有才生成）→ 3. electron-builder 出免安装目录 →
4. **把目录里的 exe 换回未改动的官方 `electron.exe`**（校验哈希必须一致）→ 5. 基于这个目录出便携版和安装包。

第 4 步是为了通过 Windows 智能应用控制，见下面「智能应用控制（SAC）」。

缓存和镜像都指向项目内 `.npm-cache/`，不污染系统盘：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"                     # 默认已设置
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

### 打包注意

- **不能开 `npmRebuild`。** `node-pty@1.1.0` 是 Node-API 预编译二进制，跨 Electron 版本通用；
  一旦让 electron-builder 去 rebuild，它会调 node-gyp 找 Visual Studio，没装 VS 就直接失败。
  所以 `package.json` 里写了 `"npmRebuild": false`。
- **`node-pty` 必须 asarUnpack。** 原生 `.node` 和 ConPTY 的 `OpenConsole.exe` 无法从 asar 里加载，
  已经配置 `asarUnpack: ["**/node_modules/node-pty/**"]`。
- **`build.win.executableName` 必须是 `electron`。** 原因见下节；副作用是进程名显示 `electron.exe`，
  已经用安装脚本把安装目录、快捷方式、卸载器名字改回 `multi-cmd`（`build/installer.nsh`）。
- **没有代码签名**，首次运行 Windows SmartScreen 可能提示「未知发布者」，点「更多信息 → 仍要运行」即可。
  要消除提示得买代码签名证书，然后 `npm run dist:edit-exe`（保留 exe 改写并签名，不再替换成官方 exe）。
- 图标是 `scripts/make-icon.mjs` 用纯 Node（zlib）画出来的多尺寸 `.ico`；注意在开了 SAC 的机器上，
  改过 exe 的图标会导致文件被拦，所以这里用的是官方 exe 自带的 Electron 图标。

### 智能应用控制（SAC）—— exe 被拦的根因和修法

Windows 11 的**智能应用控制**（`HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy`
→ `VerifiedAndReputablePolicyState = 1`）会按**文件签名 + 云端信誉**判定可执行文件。它的行为是：

- 官方 `electron.exe`（微软签名的 Electron 发行版）→ **允许**
- 被 electron-builder 改写过的 exe（写图标、版本信息、asar 完整性哈希）→ 签名失效、哈希变了 → **拦**

被拦时长这样，事件日志 `Microsoft-Windows-CodeIntegrity/Operational` 里能看到
事件 ID 3033 / 3077，策略 ID `{0283ac0f-fff1-49ae-ada1-8a933130cad6}`：

```
Program 'multi-cmd.exe' failed to run: An Application Control policy has blocked this file
（Device Guard 策略：'multi-cmd.exe' was blocked by your organization's Device Guard policy.）
```

**关键事实：SAC 只校验 exe 本身，不校验 `app.asar`。** 所以修法是让 exe 保持官方原样：

```powershell
npm run dist          # 打包脚本已经自动做了这件事
```

它会把 `node_modules/electron/dist/electron.exe`（前后哈希必须一致，不一致直接报错）
连同官方的一整套运行时覆盖进 `release/win-unpacked/`，再基于这个目录出便携版和安装包。
实测在开着 SAC 的机器上：免安装目录版、便携版、安装后的版本**三者都能正常启动并拉起终端**。

代价只有一个：任务管理器里进程名是 `electron.exe`（已经在代码里设了
`app.setAppUserModelId('com.multicmd.app')`，任务栏分组、通知仍归到 multi-cmd）。
想换回自定义图标，只能买代码签名证书走 `npm run dist:edit-exe`。

> 不建议为了跑一个程序去关 SAC：关掉之后**只能重装系统才能再打开**。

### 安装踩坑（重要）

**1. npm 11+ 默认不执行依赖的安装脚本。** `electron`、`esbuild`、`node-pty` 都依赖 `postinstall`。
本项目的 `package.json` 里已经写好：

```json
"allowScripts": { "electron": true, "esbuild": true, "node-pty": true }
```

如果安装后 `node_modules/electron/dist/electron.exe` 不存在，说明脚本被拦了，手动补：

```powershell
npm approve-scripts --all
# 或者直接跑它的安装脚本
cd node_modules\electron
$env:electron_config_cache="$PWD\..\..\.npm-cache\electron"   # 可选，缓存到项目内
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"  # 国内加速
node install.js
```

> 该脚本用到的 `extract-zip` 在某些 Node 版本下会静默提前退出、只解压出第一个文件。
> 如果 `dist` 里只有一个 `LICENSES.chromium.html`，用系统自带的 `tar` 兜底：
>
> ```powershell
> tar.exe -xf .npm-cache\electron\<hash>\electron-v33.4.11-win32-x64.zip -C node_modules\electron\dist
> Set-Content node_modules\electron\path.txt -Value 'electron.exe' -NoNewline
> ```

**2. `node-pty` 与 Electron 的 ABI。** `node-pty@1.1.0` 用的是 Node-API 预编译二进制，正常情况下无需重编译。
若升级 Electron 后报 `NODE_MODULE_VERSION` 不匹配，执行 `npm run rebuild`。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+Shift+T` | 在**当前区域**新建页签 |
| `Ctrl+Shift+W` / `Ctrl+Shift+X` | 关闭当前页签（区域内最后一个页签会顺手关掉这个区域） |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 在当前区域里切换页签 |
| `Ctrl+Shift+D` | 按当前分屏方式新开终端（默认：本区域新增页签） |
| `Ctrl+Shift+E` | 直接切出**新区域**（分割线贯穿页签栏） |
| `Ctrl+Shift+O` | 在指定路径打开终端（含历史记录） |
| `Ctrl+Shift+Q` | 关闭当前区域（它的页签并入相邻区域，进程不死） |
| `Alt+方向键` / `Ctrl+Shift+方向键` | 在区域之间移动焦点；只有一个区域时 `Alt+←/→` 退化成切页签 |
| `Ctrl+Shift+N` | 循环切到下一个区域 |
| `Ctrl+Shift+P` | 轮巡到下一个区域的页签 |
| `Ctrl+Shift+C` | 复制选中内容（无选中时提示） |
| `Ctrl+Shift+V` | 粘贴 |
| `Ctrl+Shift+K` | 清屏 |
| `Ctrl+Shift+F` | 全屏 |
| `Ctrl+Shift+S` | 立即保存布局 |
| `Ctrl+C` | 未选中文字时照常发送 `SIGINT` 给终端 |

右键点击任意终端：复制/粘贴、本区域新增页签、新开窗口、向右/向下切出新区域、关闭本区域、清屏、关闭页签。

## 目录结构

```
src/
  main/
    index.js     窗口、菜单、IPC 注册、窗口位置持久化
    pty.js       PtyManager：spawn / write / resize / kill，输出合批与背压
    shells.js    ShellCatalog：探测本机 shell 并解析成 node-pty 描述
    store.js     JSON 状态持久化（窗口 + 会话布局）
  preload/
    index.js     contextBridge 暴露的 window.multi API（渲染层无 Node 权限）
  renderer/
    index.js     入口（含未捕获异常上报）
    app.js       区域与页签的状态机、快捷键、右键菜单、持久化
    groups.js    区域分屏树数据结构、增删改、方向导航
    layout-view.js 把区域树渲染成 DOM（叶子 = 一个区域）+ 分隔条拖拽
    pane.js      单个终端：xterm 实例 + PTY 会话
    terminal.js  xterm 配置与插件
    util.js      base64 解码、路径缩写
    app.css      全部样式
build/
  icon.ico       由 make-icon.mjs 生成的多尺寸图标（打包用）
scripts/
  build.mjs      esbuild 打包（主进程/预加载/渲染层）+ 静态资源拷贝 + 产物自检
  package.mjs    调用 electron-builder 出 exe / 安装包
  make-icon.mjs  纯 Node 画图标并编码成多尺寸 .ico
  check-icon.mjs 校验 .ico 结构
  smoke-pty.cjs  脱离 Electron 单独验证 node-pty
release/         打包产物（已被 .gitignore 忽略）
```

## 设计要点

**渲染层没有 Node 权限。** `contextIsolation: true`、`nodeIntegration: false`，所有 PTY 操作都经 `preload` 的 IPC 走主进程，窗口里加载的页面无法直接碰文件系统。

**输出走 base64 而不是字符串。** 渲染层把 base64 解码成 `Uint8Array` 交给 xterm，xterm 内部按 UTF-8 流式解码，跨 chunk 的多字节字符不会被切断。Windows 上 `node-pty` 内部硬编码了 `setEncoding('utf8')`（拿不到原始字节），所以主进程额外做了一层「尾随替换字符回带」：chunk 末尾的 `U+FFFD` 大概率是被切断的多字节字符，扣住拼到下一块前面。

**分屏是一棵树，不是二维网格。** `Split` 节点只有 `a` / `b` 和方向，因此可以任意嵌套（左二右一、上下再左右……），删除窗格时父节点自动塌缩成兄弟节点。

**布局先记数据、再落 DOM。** 拖拽分隔条只改 `ratio` 并直接写 `flex`，不重建 DOM；结构变化（切区域/关区域）才重渲染整棵树，并按 paneId 复用已有的 xterm 实例（终端在区域之间搬动只是移动 DOM 节点，进程不会重启）。

**区域树决定分割线，页签属于区域。** 窗口级的树只描述「区域怎么排布」，叶子节点渲染成一个带自己页签栏的容器。
分隔条夹在两个区域之间，所以它天然就是整窗高度 —— 页签栏被切开是结构带来的结果，不是额外画的线。

**PTY 尺寸跟着布局走。** 终端挂载时先用 `FitAddon` 量出真实 cols/rows 再 `spawn`，会话就绪后再对齐一次；`resize` 做 80ms 防抖，拖分隔条不会把 ConPTY 刷爆。

## 调试与自检

设 `MULTI_CMD_LOG=1` 后运行，主进程会把启动、shell 探测、spawn、渲染层报错写进
`%APPDATA%\multi-cmd\multi-cmd.log`。

内置两个无人值守验证开关（会自动退出）：

```powershell
# 启动后截图 + 打印区域/页签结构、PTY 会话、终端内容，然后退出
$env:MULTI_CMD_LOG='1'; $env:MULTI_CMD_SELFTEST='9000'; npm start

# 自动跑一遍：本区域加页签 / 切出新区域 / 各区域页签栏 / 分割线是否贯穿 / 焦点导航 / 关区域合并 / 持久化
$env:MULTI_CMD_LOG='1'; $env:MULTI_CMD_UITEST='4000'; npm start

# 在渲染层里执行任意脚本并打印结果
$env:MULTI_CMD_UITEST='5000'; $env:MULTI_CMD_UITEST_EVAL='const a=window.__app; a.splitIntoNewGroup(a.activePane.paneId,"row"); return a.groups.size'
```

另外 `node scripts/smoke-pty.cjs` 可以脱离 Electron 单独验证 node-pty 的
spawn / 回写 / 中文与 emoji 输出完整性。

## 已知限制

- 只做了 Windows 优先的实现（ConPTY）；POSIX 分支能跑但没细调。
- 每个终端独立会话，没有 tmux 那种「断线重连 / 会话在后台存活」的能力——关掉程序，终端进程就结束了。
- 工作目录按终端启动时的 `cwd` 记录，shell 内部 `cd` 之后不会同步（除非程序自己发 OSC 7）。
- 页签还不能拖拽在区域之间搬家，也没有「把区域拖到另一个窗口」。
- 便携版 exe 每次启动会把自己解压到临时目录再运行（首次启动约 1~2 秒），这是 electron-builder `portable` 的工作方式；
  想避免就装 `setup.exe`，或者直接用 `win-unpacked/` 目录版。
- 打包体积约 71MB / 解压后 279MB，主要是 Chromium 运行时。
- exe 用的是官方未改写的 `electron.exe`（为了通过智能应用控制），所以进程名显示 `electron.exe`、
  任务栏图标是 Electron 默认图标；安装目录/快捷方式/窗口标题仍是 multi-cmd。
  想换成自定义图标需要代码签名证书，见「智能应用控制（SAC）」。

## 下一步可以加

- 拖拽页签在区域之间搬家、把区域拖成独立窗口
- 会话真正的后台存活（主进程常驻 + 单实例窗口重连）
- 终端内搜索（`@xterm/addon-search`）
- 自定义主题与字体设置界面
- 代码签名证书（恢复正常图标、消除 SmartScreen 提示）与自动更新（electron-updater）
