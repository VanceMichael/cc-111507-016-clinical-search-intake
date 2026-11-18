# 匿名协作服务目录

该服务用于保留已获授权的来源材料及其收件证据。当前提供原始资料接收、FHIR R4 searchset 检索采集、字节摘要、来源元信息检查和收件查询。来源服务和样例均在本机运行；资料中的单位、账号及标识都是合成值，只用于本地匿名合成资料的随访联络准备，不涉及临床判断。

结构化采集区分来源 Bundle 中的 match（有明确匹配依据）与 include（为引用补带的资源），outcome 只进入 issues，分页严格按来源 next 链接的查询上下文继续。跨页重复的附带资源按 `resourceType/id/meta.versionId` 合并，不计作新增服务对象。版本化引用精确匹配版本，缺少版本的引用在存在多个版本时不自动选取。页面读取失败、来源告警与未完成分页都会保留在收件中，不会因为取得若干页就宣称筛选范围完整。

## 环境与运行

使用 Node.js 22.23.4。依赖通过 package-lock.json 锁定。准备环境时执行 `npm ci --ignore-scripts --no-audit --no-fund`，之后运行、构建、测试和演示均不下载资源。

```sh
npm run build
npm test
npm run demo
npm start
```

`npm start` 输出本次监听地址；服务绑定回环地址，来源网关与接收端在同一进程内使用独立端口。`DATA_DIR` 指定收件目录，默认 `./var`；`SCENARIO` 选择 fixtures/scenarios.json 中的来源场景。`npm run demo` 从临时空目录启动、实际领取来源字节、查询收件并退出，不回放旧日志。 `PORT` 可指定接收服务端口；未设置时仍自动选择空闲端口。

## 容器

```sh
docker build -t clinical-search-intake:local .
docker run --rm --network none clinical-search-intake:local npm test
docker run --rm --network none clinical-search-intake:local npm run demo
```

镜像构建准备阶段完成依赖安装，运行不需要公网服务。接口约定见 `docs/接入约定.md`，来源格式范围见 `docs/来源格式.md`。`src/source-metadata.mjs` 只识别文件元信息，不代表已提取结构化记录。文件收件与完整业务覆盖是不同状态。

## 结构化方式检查

`npm test` 默认运行原始资料收件、启动入口与结构化采集检查；结构化用例覆盖命中/附带区分、跨页去重、分页上下文、版本化与无版本引用、来源告警、读取中断和重启后查询。该检查的领域字段约定见接入文档，不以测试代替支持范围说明。
