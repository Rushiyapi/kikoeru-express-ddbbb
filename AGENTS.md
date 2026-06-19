# AGENTS.md

## 项目速览

Kikoeru 是一个基于 Node.js/Express 的自托管 DLsite 音声媒体服务器。本仓库主要是后端/服务端项目；浏览器前端由 `dist/` 中的构建产物提供，原始前端源码属于 `kikoeru-quasar`。

关键文件和目录：

- `app.js`：服务入口；启动 HTTP/可选 HTTPS、API 路由、静态前端和 Socket.IO。
- `config.js`：创建并读取 `config/config.json`；默认端口是 `8888`。
- `routes/`：后端 API。
- `database/`：SQLite schema、迁移、查询和持久化逻辑。
- `filesystem/scanner.js` / `filesystem/scannerModules.js`：音声库扫描与元数据抓取入口。
- `filesystem/updater.js`：老作品元数据刷新入口。
- `filesystem/utils.js`：文件树、音频时长、字幕/歌词检测、`memo` 生成。
- `scraper/`：DLsite、asmr.one、HVDB 等外部数据源抓取。
- `dist/`：当前可运行前端构建产物；新克隆仓库默认不包含。
- `docker-compose.yml`：Docker 部署模板。

## 运行与启动

- 包管理器：npm；仓库包含 `package-lock.json`。
- `package.json` 要求 Node `>=12.0.0`，但依赖较旧，本地开发优先用 Node 14/16。
- 本工作区使用 Node 24 + npm 11 执行 `npm ci` 曾失败，错误为 `npm error Exit handler never called!`。
- 主要原生依赖风险：`sqlite3@5.0.2`。
- 默认 HTTP 端口：`8888`，可由 `PORT` 或 `config.listenPort` 覆盖。
- 首次启动会创建 `config/config.json`、`sqlite/db.sqlite3`，默认管理员账号为 `admin` / `admin`。

推荐使用项目内自包含启动脚本：

```powershell
.\start-kikoeru.cmd
```

该脚本会准备 `.runtime\node-v14.21.3-win-x64\node.exe`、检查依赖、准备 `dist/`、后台启动服务并验证 `http://localhost:8888/api/health`。停止服务：

```powershell
.\stop-kikoeru.cmd
```

高级用法：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local.ps1 -Reinstall
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local.ps1 -Foreground
```

源码方式仍可用，但需要 Node 14/16：

```powershell
npm ci
npm start
```

开发模式：

```powershell
npm run dev
```

`npm run dev` 使用 `nodemon`，并启用开发用媒体静态路由：`/media/stream/VoiceWork` 和 `/media/download/VoiceWork`。

常用任务：

```powershell
npm run scan
npm test
```

Docker 可作为隔离旧依赖的方式，但当前工作区记录为本机未安装 Docker。默认挂载媒体库：

```yaml
- ./VoiceWork:/usr/src/kikoeru/VoiceWork
```

使用该默认挂载时，管理界面里的音声库路径应填：

```text
/usr/src/kikoeru/VoiceWork
```

## 前端构建产物

后端通过以下代码提供 Web 前端：

```text
app.use(express.static(path.join(__dirname, './dist')))
```

新克隆仓库默认没有 `dist/`。要让浏览器 UI 正常工作，必须确保 `dist/index.html` 存在。已知准备方式：

- 从 `umonaca/kikoeru-quasar` 的 `v0.6.2` release 下载 `spa-v0.6.2` 或 `pwa-v0.6.2`，优先 SPA。
- 压缩包内可能有一层顶层 `spa/` 目录，需要把其中内容上移到 `dist/`。
- 也可以自行构建 `kikoeru-quasar`，再把生成的 `dist/spa/` 内容复制到本仓库 `dist/`。

如果没有 `dist/index.html`，后端 API 仍可启动，但根路径不会显示预期前端。

## 当前工作区记录

- 工作区已使用项目内自包含启动方式。
- 本地 Node 14 位于 `.runtime\node-v14.21.3-win-x64\node.exe`。
- 前端 SPA 已下载并整理到 `dist/`。
- `http://localhost:8888/` 可返回 Kikoeru HTML 前端壳。
- `http://localhost:8888/api/health` 可返回 `OK`。

查看后台端口进程：

```powershell
netstat -ano | Select-String ':8888'
```

按 PID 停止服务：

```powershell
Stop-Process -Id <PID>
```

## 修改生效规则

- 只修改 `dist/` 内 HTML/CSS/JS/图片时，通常刷新浏览器即可看到效果。
- 修改 `app.js`、`routes/`、`database/`、`filesystem/`、`scraper/` 等后端代码后，当前后台服务不会自动生效，必须重启 Node 进程。
- 修改 `package.json`、`package-lock.json` 或依赖相关内容后，需要重新安装依赖并重启服务。
- 修改数据库 schema、迁移、扫描逻辑或配置默认值后，需要说明是否还要执行迁移、扫描、更新或重新生成配置。
- 每次汇报修改时，必须明确说明“刷新浏览器即可”或“需要重启/重新构建/重新安装/重新扫描/重新更新”。

## 数据抓取与扫描规则

每次用户要求展示新字段、获取新来源数据或调整详情页元信息时，不要只做前端临时请求或一次性接口拼接；必须同步检查扫描链路，确保新作品通过 `npm run scan` / `filesystem/scanner.js` 首次入库时也能抓到并保存这些数据。

新增字段时必须回答三件事：数据来自哪里、存在哪里、什么时候更新。来源可以是 DLsite HTML、DLsite JSON、DLsite dynamic API、asmr.one、本地文件扫描或 AI/人工生成；存储可以是 `t_work` 基础字段、独立关联表、`memo`、缓存文件或仅前端临时补充。不要让来源和存储语义混在一起。

字段归类原则：

- 作品基础事实或常用排序/筛选条件，例如发售日、社团、标题、价格、销量、评分、标签、声优、字幕状态，应优先进入扫描入库和数据库更新流程。
- 详情页临时补充只能作为兜底或渐进增强，不能成为唯一数据来源。
- asmr.one 标签、时长、字幕标记、其他语言版本、外部赏析等应明确是“补充数据”还是“可回填基础字段”。
- 补充源可以填补 DLsite 缺失字段，但默认不要覆盖 DLsite 当前动态数据，尤其是销量、价格、评分、评论数等随时间变化且 DLsite 更权威的字段。

老数据回填要求：

- 新增字段不能只对未来扫描的新作品有效，除非明确告诉用户老数据需要重新扫描、重新更新或等待详情页懒加载。
- 为老作品设计回填路径：默认动态更新、`--refreshAll`、手动刷新详情页、懒加载缓存、迁移或专门脚本。
- 对已有正确值要保守更新：抓到空值、异常值或补充源较旧数据时，不要静默覆盖已有有效字段。
- 优先采用“缺失才补写”“抓到有效值才覆盖”“按来源优先级合并”的策略。

相关命令：

```powershell
npm run scan
.\.runtime\node-v14.21.3-win-x64\node.exe --trace-warnings .\filesystem\updater.js
.\.runtime\node-v14.21.3-win-x64\node.exe --trace-warnings .\filesystem\updater.js --refreshAll
```

## 前端/UI 修改约定

- 当前前端来自 `dist/` 构建产物；`dist/*.map` 中可看到原始组件来源。
- 自用快速优化可以先改当前 `dist/` 产物，但尽量通过独立自定义 CSS/JS 注入实现，避免直接大段改主 bundle。
- 详情页增强主要集中在 `dist/js/custom-work-ui.js` 和对应 CSS。
- 作品详情页源码组件主要对应 `Work.vue`、`WorkDetails.vue`、`WorkTree.vue`、`CoverSFW.vue`。
- 详情页桌面端默认采用“封面优先的左右布局”，右侧承载标题、元信息、标签和操作；移动端保持单列纵向流。
- 参考 asmr.one 时只吸收信息密度、首屏组织、标签/操作分层和文件列表衔接，不要照搬公开站的反馈、导流、商业化和社交逻辑。
- `custom-work-ui.js` 监听 DOM 变化，修改不谨慎容易造成详情页卡死或文件列表不渲染。
- 临时禁用详情页增强：在浏览器控制台执行 `localStorage.setItem('kikoeru-disable-custom-work-ui', '1')` 后刷新；恢复时执行 `localStorage.removeItem('kikoeru-disable-custom-work-ui')` 后刷新。

## 播放器与字幕

- 播放器相关源码来自 `kikoeru-quasar` 构建产物；自用快速增强优先通过 `dist/js/custom-work-ui.js` 注入实现。
- 字幕兼容逻辑保持渐进增强：有 `.vtt/.srt` 时可以转换为旧播放器可识别的 LRC 数据并缓存 cue。
- 没有字幕、字幕未加载或解析失败时，必须保留原有播放、快退和快进行为。
- 基于字幕的上一句/下一句跳转只接管原本快退/快进按钮，不要误改上一首/下一首曲目按钮。
- 图标可以在有字幕时替换为句子跳转语义，缺少字幕时恢复原图标。

AI 翻译字幕约定：

- 制作 AI 翻译字幕前，先盘点作品目录内可辅助判断原文的资料，包括同名字幕、台本、PDF、TXT、README、特典说明、分轨标题、歌词或已有翻译文件。
- 能从台本或官方文本获得原文时，优先以文本资料为主；ASR 只用于时间轴、口癖差异、临场改词和缺漏补全。
- 不要把某个作品的专属翻译风格、人设口吻、称呼、术语表直接推广到所有作品。
- 翻译字幕默认面向“边听边看”：简体中文、句子短、时间轴稳定、不过度意译、不加戏、不删减关键信息。
- 成人向内容按原意翻译，避免擅自降低或夸张语气强度。
- 字幕来源必须可追踪；AI 生成、人工翻译组、DLsite 官方多语版、asmr.one 标记、本地未知字幕等来源不要混在一个笼统的“带字幕”概念里。
- 对 AI 生成字幕，优先在作品目录或项目可读取位置记录语言、来源、生成方式、是否人工校对、参考资料、创建时间、对应音频文件和备注。
- 生成给播放器使用的字幕时，验证 `.vtt/.srt/.lrc` 能被 `/api/media/check-lrc` 和播放器兼容逻辑识别。

## 赏析与 AI 翻译

- 赏析、评论、推荐语、外部介绍等长文本内容应分为“原文抓取”和“译文缓存”两层处理。
- 程序可以负责从 asmr.one、DLsite 或其他来源抓取原文，并保存来源、语言、抓取时间、来源链接和更新时间。
- 不要在程序内接入普通机器翻译或自动调用第三方翻译服务。
- 所有翻译默认由 AI 完成，并由用户明确交给 Codex/AI 处理后再写回本地缓存或数据库。
- 程序内置流程只应暴露“需要翻译”“已有译文”“译文过期/可重新翻译”等状态，不应自行生成最终译文。
- 译文应作为可追踪数据保存，至少记录原文来源、目标语言、AI 翻译时间、翻译者/模型标识、是否人工确认、对应原文版本或抓取时间。
- 原文变化后，不要静默覆盖译文，应标记译文可能过期，等待用户决定是否重新翻译。
- 赏析内容适合作为补充元数据，但不要混入 `t_work` 基础字段；建议使用独立表或缓存结构按 `work_id` 关联。
- 抓取策略应采用懒加载和适时刷新：打开作品详情、用户手动刷新、缓存过期时抓取原文；不要启动时全量抓取和翻译。

## 配置与环境变量

如果 `config/config.json` 不存在，`config.js` 会自动生成。重要默认值：

- `listenPort`：`8888`
- `auth`：非生产模式下为 `false`
- `production`：当 `NODE_ENV=production` 时为 `true`
- `voiceWorkDefaultPath`：源码模式下为 `VoiceWork`，Docker 模式下为 `/usr/src/kikoeru/VoiceWork`
- `databaseFolderDir`：`sqlite`
- `coverFolderDir`：`covers`

生产模式会强制启用身份验证：

```powershell
$env:NODE_ENV = "production"
npm start
```

常用环境变量：

- `PORT`：覆盖配置文件监听端口。
- `NODE_ENV=development`：启用开发用媒体浏览路由。
- `NODE_ENV=production`：启用生产模式并强制身份验证。
- `FREEZE_CONFIG_FILE=1`：在部分初始化路径中避免写入配置文件。
- `CRASH_ON_UNHANDLED=1`：遇到未处理 Promise rejection 时让进程崩溃。
- `IS_DOCKER=true`：Docker 镜像用于决定默认路径。

## 常见坑

- 不要期待 UI 在 `dist/index.html` 缺失时可用。
- 避免在很新的 Node/npm 上运行旧依赖；Windows 依赖安装失败时，先尝试 Node 14/16。
- 生成的 `config/`、`sqlite/`、`covers/`、`VoiceWork/` 是本地运行数据，不应视为源码改动。
- `README.md` 在部分终端里可能显示乱码，但文件内容本身是中文文档。
- `config/config.json` 必须保持无 BOM 的 UTF-8；Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写入 BOM，老代码里的 `JSON.parse(fs.readFileSync(configPath))` 会因此启动失败。
- 首屏会调用 `/api/version`。本工作区已修改为 `checkUpdate=false` 时直接返回本地版本，避免网络慢导致页面启动阶段卡顿。
- 如果修改扫描、迁移、数据库视图或缓存字段，注意同时更新新库 schema、迁移文件和老数据回填策略。

## Git 远程

当前克隆配置：

```text
origin   https://github.com/Rushiyapi/kikoeru-express-ddbbb.git
upstream https://github.com/Number178/kikoeru-express.git
```

本地修改推到 `origin`；同步原项目更新时从 `upstream` 拉取。
