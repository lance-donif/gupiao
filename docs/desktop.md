# 项目图形工作区

在项目文件列表中选中一个当前版本的文本、Markdown 或 CSV 文件，打开图形工作区。服务为该项目启动临时 Linux 容器，将选定版本载入原生 Tk 编辑器。Web 界面显示真实的 1000 × 650 桌面截屏，可以用鼠标或触屏定位光标、用键盘编辑，也可输入中文和多行文本。

## 部署

需要在运行工作台的 Linux 主机上安装 Docker，且工作台进程能够访问本机 Docker 服务。在仓库根目录构建独立编辑器镜像并读取 ID。

```sh
docker build -f desktop/Dockerfile -t echo-private-editor:local desktop
docker image inspect --format '{{.Id}}' echo-private-editor:local
```

若构建网络使用组织的 TLS 根证书，可追加 `--secret id=ca_bundle,src=/path/to/ca-bundle.pem`。镜像使用 Alpine 3.22、Xvfb、Tk、文泉驿正黑字体和 scrot，构建阶段需要访问发行版软件源。

在工作台的根目录 `.env` 中设置 `ECHO_DESKTOP_IMAGE_ID` 为完整的 `sha256:` 镜像 ID，随后重启工作台服务。镜像与工作台分别构建。本功能默认关闭，在没有 Docker 的环境中仍可使用普通项目文件编辑器。运行工作台的账号应由管理员维护，因为访问本机 Docker 服务需要宿主机权限。

## 保存与生命周期

- 容器中使用文件的工作副本，编辑内容在桌面进程中保存。通过工作台显式保存，将文本作为项目文件的新版本提交。发生并发编辑时，界面会显示版本冲突。
- 直接停止桌面或等到会话过期会清除尚未保存的桌面内容。镜像进程启动 30 分钟后自行退出。
- 单个文件上限为 24 KiB。编辑器支持中英文输入、换行、选择、撤销、重做与光标移动。它用于编辑项目已支持的纯文本格式。

## 运行边界

运行时仅接受经工作台鉴权的项目访问。启动时使用指定的本地不可变镜像 ID、独立无网容器、只读根文件系统、非 root UID、空的额外 Linux capabilities 和临时内存目录。Xvfb 不监听 TCP，镜像不发布端口。编辑器进程与控制命令通过容器内部的 Unix 套接字通讯。宿主机经固定命令传递文档、读取 PNG、发送编辑事件及读取当前文本。编辑事件来自已登录用户，不会触发模型调用。自行部署时，计算资源按部署环境计费。

使用开发依赖可在临时项目里运行真实验收。先构建编辑器，然后把本机镜像 ID 交给诊断命令。

```sh
uv run --frozen python -m scripts.check_desktop_local "$(docker image inspect --format '{{.Id}}' echo-private-editor:local)"
```

诊断使用工作台实际 API 打开桌面，获取 PNG，输入两行中文并保存。随后模拟另一设备更新同一文件，核对旧会话保存得到 409、另存副本成功、原版本保留，以及会话关闭。诊断显式使用本机临时数据库及零美元模型预算。
