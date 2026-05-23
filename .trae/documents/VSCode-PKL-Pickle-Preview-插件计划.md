## Summary

为 VSCode 制作一个用于预览 Python pickle（`.pkl`）文件的插件：
- 侧边栏提供一个“树视图”用于浏览当前选中文件的内容
- 支持“用 PKL 预览打开”的只读自定义编辑器（Custom Editor），在编辑器内同样以树结构展示
- 解析失败时清晰展示错误原因（例如缺少模块、反序列化异常）

成功标准：
- 在 VSCode 中选中/打开 `.pkl` 文件时，可稳定看到结构化树视图
- 在可配置 Python 解释器存在的情况下，可正确解析常见 pickle（至少内置类型；其他类型以降级节点展示）
- 解析失败时不崩溃，且给出可操作的错误信息

## Current State Analysis

- 工作目录 `d:\GitHub\pkl_reader` 当前为空目录，没有现有代码、构建脚本或 VSCode 插件骨架可复用。
- 因此需要从零创建 VSCode 扩展工程与解析实现。

## Proposed Changes

### 1) 创建 VSCode 扩展骨架（TypeScript）

新增/生成文件（以最终脚手架输出为准，以下为目标结构）：
- `package.json`
  - `activationEvents`：按需激活（命令/视图/自定义编辑器）
  - `contributes.viewsContainers` / `contributes.views`：注册侧边栏容器与树视图
  - `contributes.commands`：注册打开/刷新/复制路径等命令
  - `contributes.menus`：在资源管理器 `.pkl` 文件上提供“用 PKL 预览打开”
  - `contributes.customEditors`：注册只读自定义编辑器用于 `.pkl`
  - `contributes.configuration`：提供 Python 路径、深度/条目限制等设置项
- `src/extension.ts`
  - 注册 TreeDataProvider：`pklPreview.tree`
  - 监听编辑器/文件选择变化：自动刷新树视图数据源
  - 注册命令：
    - `pklPreview.openWithPreview`：以自定义编辑器打开
    - `pklPreview.refresh`：刷新当前文件解析结果
    - `pklPreview.copyJsonPath`：复制节点路径（可选，提升可用性）
  - 注册 CustomReadonlyEditorProvider：`.pkl` 只读预览编辑器

### 2) Python 解析器（独立进程）与 JSON 树协议

新增文件：
- `python/parse_pickle.py`
  - 入参：文件路径、最大深度、最大节点数（或每层最大条目）、最大字符串长度等
  - 输出：单行 JSON（stdout）
  - 行为：
    - `pickle.load` 反序列化（用户确认文件来源可信）
    - 捕获并结构化错误（ModuleNotFoundError、AttributeError、UnpicklingError 等）
    - 将对象转换为“树节点”结构（避免循环引用导致递归爆炸）

建议的树节点协议（TS 与 Python 之间的稳定接口）：
- `kind`: `"value" | "error" | "truncated" | "ref"`
- `type`: Python 类型名（例如 `dict`, `list`, `MyClass`）
- `label`: 树节点显示文本（简短）
- `path`: 稳定路径（例如 `$.foo[0].bar`，用于复制/定位）
- `children`: 子节点数组（可为空）
- `meta`: 可选信息（长度、shape、编码提示、refId 等）

约束/降级策略：
- 对 `dict/list/tuple/set` 展开为 children
- 对 `bytes/bytearray` 默认只展示长度 + 前 N 字节（hex/base64 二选一，默认 hex）
- 对不可 JSON 化对象：展示 `repr` 的截断版本，children 为空
- 对递归/重复引用：以 `ref` 节点指向 `refId`，避免无限递归

### 3) VSCode 侧边栏树视图：与当前文件联动

修改/新增内容（主要在 `src/` 下）：
- TreeDataProvider 的输入来源：
  - 优先以“当前活动编辑器对应的文件”作为预览目标
  - 若当前不是 `.pkl`，树视图显示提示节点（例如“请选择 .pkl 文件”）
- 调用 Python：
  - 使用 `child_process.spawn` 调用设置项 `pklPreview.pythonPath`（默认 `python`）
  - 将文件路径与限制参数传给 `parse_pickle.py`
  - 读取 stdout JSON，构造树结构并缓存（以文件路径 + mtime 作为 cache key）
- UX：
  - 解析中显示“Loading…”节点
  - 解析失败显示错误节点（包含异常类型与消息）

### 4) 自定义只读编辑器（Custom Editor）：树形预览

实现方式：
- 使用 `CustomReadonlyEditorProvider` 为 `.pkl` 提供“预览编辑器”
- 编辑器 UI 采用 Webview 渲染树（因为 Custom Editor 的展示载体就是 Webview）
- 该 Webview 复用与侧边栏一致的“树节点 JSON 协议”，确保两处展示一致
- 编辑器内提供：
  - 搜索（按 label/path）
  - 一键复制路径/值（可选）
  - 刷新按钮（调用 `pklPreview.refresh`）

### 5) 配置项与可观测性

在 `package.json` 增加配置：
- `pklPreview.pythonPath`：string，默认 `python`
- `pklPreview.maxDepth`：number，默认 8
- `pklPreview.maxChildrenPerNode`：number，默认 200
- `pklPreview.maxStringLength`：number，默认 2000
- `pklPreview.bytesPreviewLength`：number，默认 64

输出与排障：
- 使用 `vscode.OutputChannel`：记录 Python 启动命令（不包含敏感信息）、耗时、错误堆栈（可选）

## Assumptions & Decisions

- `.pkl` 文件为 Python pickle，且来源可信，允许执行 `pickle.load` 进行反序列化。
- 缺少依赖（例如自定义类所在模块未安装）时不做“强行提取字段”，而是清晰展示失败原因（用户选择）。
- 目标 IDE 仅 VSCode（用户选择）。
- “树视图”采用 VSCode Tree View；“打开预览”采用 Custom Editor（Webview）实现，两者共享同一解析输出协议。

## Verification Steps

本地验证（Windows + VSCode）：
- 生成若干测试 `.pkl`：
  - 内置类型：dict/list/bytes/nested
  - 大对象：验证截断/深度限制生效
  - 触发错误：pickle 引用不存在的模块/类，验证错误展示
- 在 VSCode：
  - 选中 `.pkl` 文件：侧边栏树视图自动刷新并可展开
  - 右键 `.pkl` → “用 PKL 预览打开”：打开只读预览编辑器且内容一致
  - 修改配置项（maxDepth 等）：刷新后生效

