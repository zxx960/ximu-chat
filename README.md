# 西牧chat

本地聊天工作台，可手动填写 OpenAI 兼容 API 的 API Key 和模型 ID。

## 启动

用 Node.js 22 或更新版本，在 `ximu-chat` 目录运行：

```powershell
npm ci
npm start
```

打开 [http://127.0.0.1:4173](http://127.0.0.1:4173)。如需更换端口，在运行 `npm start` 前设置 `$env:PORT = '4180'`。服务仅监听本机的 `127.0.0.1`。

## Docker 部署

在服务器上的项目目录运行 `docker compose up -d --build --wait`。默认将容器发布到宿主机的 `127.0.0.1:8768`。`deploy/nginx-chat.ximuai.com.conf` 用于独立域名 [chat.ximuai.com](https://chat.ximuai.com/)，使用该域名的证书。

用 Compose 环境变量 `XIMU_CHAT_PUBLIC_ORIGIN` 设置页面的 HTTPS 源地址，多个地址用逗号分隔。`XIMU_CHAT_UPSTREAM_API_URL` 设置允许转发的 API 基础地址，默认为 `https://codex.ximuai.com`。修改 `XIMU_CHAT_PORT` 时，请同步调整 Nginx 的 `proxy_pass`。

## 使用

1. 在「连接设置」中填入服务商提供的 API Key 和模型 ID，然后点击「保存连接设置」。
2. 输入消息并发送。回复生成期间可点「停止生成」。聊天历史可在左侧重新打开或删除。

页面沿用当前浏览器中已保存的有效 API 地址，默认使用 `https://codex.ximuai.com`。鉴权使用 `Authorization: Bearer <API Key>`。普通聊天默认走 OpenAI 兼容的 Chat Completions，保存的地址以 `/responses` 结尾时，普通聊天也走 Responses。只要对话中包含原始文档，就会请求同一基础地址下的 `/responses`。两种接口均支持流式和普通 JSON 回复。

API Key、模型名和聊天历史保存在当前浏览器。刷新后会恢复连接设置，可以直接继续聊天。

## 对话附件

- 点击输入框左侧的回形针，或将文件拖进输入框。可附加 PDF、Word（`.docx`）、TXT、Markdown、CSV 等文本文件，以及 PNG、JPG、WebP 图片。每条消息最多 5 个附件，单个最多 5 MB，合计最多 10 MB。
- 新添加的 PDF、Word 和文本文件通过 Responses 接口按原文件发送，由服务商处理。支持的格式和扫描页、图表识别能力取决于网关和模型。图片需要模型及 API 支持图片输入。
- 已发送的附件保存在当前浏览器，刷新后可以继续追问。每次请求都会发送该对话的上下文，包括此前的附件。旧版已发送的文档以当时保存的文字继续参与对话，如需发送原件，可以重新添加。删除对话时会删除它的本地附件。
