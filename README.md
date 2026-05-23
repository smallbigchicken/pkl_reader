# PKL (Pickle) Preview

用于在 VSCode 中预览 Python pickle（`.pkl`）文件：
- 侧边栏树视图：随当前选中的 `.pkl` 文件自动刷新
- 自定义只读编辑器：右键 `.pkl` → “Open with PKL Preview”

## 配置

在 VSCode Settings 中搜索 `PKL Preview`：
- `pklPreview.pythonPath`：用于解析 pickle 的 Python（默认 `python`）
- `pklPreview.maxDepth`：最大展开深度
- `pklPreview.maxChildrenPerNode`：每个容器节点最多展开多少子节点
- `pklPreview.maxStringLength`：字符串/标签最大长度
- `pklPreview.bytesPreviewLength`：bytes 预览多少字节

## 安全提示

本插件使用 Python 的 `pickle.load` 反序列化。pickle 只能用于可信来源的文件。

