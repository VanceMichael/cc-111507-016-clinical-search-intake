# 匿名协作服务目录

该服务用于保留已获授权的来源材料及其收件证据。当前提供原始资料接收、FHIR searchset 结构化检索采集、字节摘要、来源元信息检查和收件查询。来源服务和样例均在本机运行；资料中的单位、账号及标识都是合成值。

## 环境与运行

使用 Node.js 22.23.4。依赖通过 package-lock.json 锁定。准备环境时执行 `npm ci --ignore-scripts --no-audit --no-fund`，之后运行、构建、测试和演示均不下载资源。

```sh
npm run build
npm test
npm run demo
npm start
```

`npm start` 输出本次监听地址；服务绑定回环地址，来源网关与接收端在同一进程内使用独立端口。`DATA_DIR` 指定收件目录，默认 `./var`；`SCENARIO` 选择 fixtures/scenarios.json 中的来源场景。`npm run demo` 从临时空目录启动、实际领取来源字节、执行一次结构化检索、查询收件并退出，不回放旧日志。 `PORT` 可指定接收服务端口；未设置时仍自动选择空闲端口。

## 容器

```sh
docker build -t clinical-search-intake:local .
docker run --rm --network none clinical-search-intake:local npm test
docker run --rm --network none clinical-search-intake:local npm run demo
```

镜像构建准备阶段完成依赖安装，运行不需要公网服务。接口约定见 `docs/接入约定.md`，来源格式范围见 `docs/来源格式.md`。`src/source-metadata.mjs` 只识别文件元信息，不代表已提取结构化记录。文件收件与完整业务覆盖是不同状态。

## 结构化检索

`POST /v1/intakes` 使用 `{"mode":"structured"}` 时，服务沿来源 `/fhir` 的 searchset 分页采集。只有 `entry.search.mode=match` 形成匹配资源，`include` 形成附带资源并单独计数；`outcome`/OperationOutcome 进入 issues；缺 mode 或未知 mode 记为 unknown，均不计入资源统计。资源按 `resourceType/id/meta.versionId` 去重，同一附带资源跨页重复不会变成新的服务对象。

分页严格跟随来源给出的 `Bundle.link[next]`（保留其查询上下文），只访问来源本源内链接；next 循环、重复页、局部读取失败、来源告警、未约定扩展和 total 不一致都会进入 issues/coverage.gaps，此时收件为 partial，不会宣称筛选范围完整。版本化引用只精确匹配到指定 `_history`；未指定版本的引用只有在已采集身份唯一时才解析，否则标为 ambiguous，不会任意替换成历史版本。引用依据见 `evidence.relationships` 与 record.basis。
