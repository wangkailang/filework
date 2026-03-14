# 需求文档：PPT/PPTX 文件预览

## 简介

为 Electron 桌面应用的文件预览面板添加 PPT/PPTX 文件预览支持。当前预览面板已支持代码文件（通过 shiki 高亮）、PDF（通过 iframe）和图片文件。本功能将扩展预览能力，使用户可以直接在应用内浏览 PowerPoint 演示文稿的幻灯片内容，无需打开外部应用。

## 术语表

- **FilePreviewPanel**: 文件预览面板组件，负责根据文件类型分发到对应的预览器
- **PptxViewer**: 新增的 PPTX 预览组件，负责解析和渲染 PPT/PPTX 文件内容
- **PptxParser**: 主进程中的 PPTX 解析模块，负责将 .pptx 文件解析为可渲染的幻灯片数据结构
- **SlideData**: 解析后的幻灯片数据结构，包含每张幻灯片的文本、图片、形状等元素信息
- **SlideNavigator**: 幻灯片导航控件，提供翻页、页码显示、缩略图导航等功能
- **IPC_Bridge**: 主进程与渲染进程之间的 IPC 通信桥梁，通过 preload 脚本暴露安全 API

## 需求

### 需求 1：PPTX 文件类型识别

**用户故事：** 作为用户，我希望在文件预览面板中选择 .ppt 或 .pptx 文件时，系统能自动识别并启用对应的预览器，以便我无需手动选择预览方式。

#### 验收标准

1. WHEN 用户选择一个扩展名为 `.pptx` 的文件进行预览, THE FilePreviewPanel SHALL 识别该文件为 PPTX 类型并加载 PptxViewer 组件
2. WHEN 用户选择一个扩展名为 `.ppt` 的文件进行预览, THE FilePreviewPanel SHALL 显示提示信息，说明仅支持 `.pptx` 格式，建议用户将文件转换为 `.pptx` 格式
3. THE FilePreviewPanel SHALL 在已支持的文件类型列表（代码、PDF、图片）之外，将 `.pptx` 扩展名纳入支持范围

### 需求 2：PPTX 文件解析

**用户故事：** 作为用户，我希望系统能解析 PPTX 文件的内容，以便我可以在预览面板中查看幻灯片。

#### 验收标准

1. WHEN 一个有效的 `.pptx` 文件路径被传入, THE PptxParser SHALL 在主进程中读取并解析该文件，返回 SlideData 数组
2. THE PptxParser SHALL 从每张幻灯片中提取文本内容，保留文本的基本格式信息（字号、加粗、斜体、颜色）
3. THE PptxParser SHALL 从每张幻灯片中提取嵌入的图片资源，并将图片转换为 base64 编码的数据
4. THE PptxParser SHALL 解析幻灯片中形状元素的位置（x, y 坐标）和尺寸（宽度、高度）信息
5. THE PptxParser SHALL 解析幻灯片的背景颜色或背景图片信息
6. IF 文件格式损坏或无法解析, THEN THE PptxParser SHALL 返回包含具体错误原因的错误信息

### 需求 3：幻灯片渲染

**用户故事：** 作为用户，我希望在预览面板中看到幻灯片的可视化渲染效果，以便我能直观地了解演示文稿的内容。

#### 验收标准

1. WHEN SlideData 被传入 PptxViewer, THE PptxViewer SHALL 将幻灯片内容渲染为可视化的 HTML 元素
2. THE PptxViewer SHALL 按照 SlideData 中的位置和尺寸信息，在画布区域内按比例定位各元素
3. THE PptxViewer SHALL 以 16:9 的默认宽高比渲染幻灯片画布，并根据 SlideData 中的实际尺寸信息进行调整
4. THE PptxViewer SHALL 渲染文本元素时保留字号、加粗、斜体和颜色等格式
5. THE PptxViewer SHALL 渲染嵌入的图片，并按照原始位置和尺寸进行显示
6. THE PptxViewer SHALL 渲染幻灯片的背景颜色或背景图片

### 需求 4：幻灯片导航

**用户故事：** 作为用户，我希望能在多张幻灯片之间方便地切换浏览，以便我能快速查看整个演示文稿。

#### 验收标准

1. THE SlideNavigator SHALL 显示当前幻灯片页码和总页数（格式为"第 N 页 / 共 M 页"）
2. WHEN 用户点击"上一页"按钮, THE SlideNavigator SHALL 切换到前一张幻灯片
3. WHEN 用户点击"下一页"按钮, THE SlideNavigator SHALL 切换到后一张幻灯片
4. WHILE 当前显示第一张幻灯片, THE SlideNavigator SHALL 禁用"上一页"按钮
5. WHILE 当前显示最后一张幻灯片, THE SlideNavigator SHALL 禁用"下一页"按钮
6. WHEN 用户按下键盘左方向键, THE PptxViewer SHALL 切换到前一张幻灯片
7. WHEN 用户按下键盘右方向键, THE PptxViewer SHALL 切换到后一张幻灯片

### 需求 5：缩放控制

**用户故事：** 作为用户，我希望能缩放幻灯片的显示大小，以便我能查看细节或获得整体概览。

#### 验收标准

1. THE PptxViewer SHALL 提供缩放控件，包含放大按钮、缩小按钮和当前缩放比例显示
2. WHEN 用户点击放大按钮, THE PptxViewer SHALL 将缩放比例增加 25%，最大缩放比例为 500%
3. WHEN 用户点击缩小按钮, THE PptxViewer SHALL 将缩放比例减少 25%，最小缩放比例为 25%
4. WHEN 用户点击缩放比例显示区域, THE PptxViewer SHALL 将缩放比例重置为 100%
5. WHEN 用户切换到不同的 PPTX 文件进行预览, THE PptxViewer SHALL 将缩放比例重置为 100%

### 需求 6：IPC 通信

**用户故事：** 作为开发者，我希望 PPTX 解析在主进程中执行并通过 IPC 传递数据到渲染进程，以便保持应用架构的一致性和安全性。

#### 验收标准

1. THE IPC_Bridge SHALL 注册一个新的 IPC 通道 `fs:parsePptx`，用于接收文件路径并返回解析后的 SlideData
2. THE IPC_Bridge SHALL 在 preload 脚本中暴露 `parsePptx` 方法，供渲染进程安全调用
3. WHEN 渲染进程调用 `parsePptx` 方法, THE IPC_Bridge SHALL 将请求转发到主进程的 PptxParser 进行处理
4. IF 主进程解析过程中发生错误, THEN THE IPC_Bridge SHALL 将错误信息传递回渲染进程

### 需求 7：加载状态与错误处理

**用户故事：** 作为用户，我希望在文件加载和解析过程中看到明确的状态反馈，以便我了解当前的处理进度。

#### 验收标准

1. WHILE PPTX 文件正在解析中, THE PptxViewer SHALL 显示加载动画和"解析演示文稿中..."的提示文字
2. WHEN PPTX 文件解析成功完成, THE PptxViewer SHALL 隐藏加载状态并显示第一张幻灯片
3. IF PPTX 文件解析失败, THEN THE PptxViewer SHALL 显示错误信息，包含具体的失败原因
4. IF PPTX 文件大小超过 100MB, THEN THE PptxViewer SHALL 显示警告信息，提示文件过大可能影响性能，并询问用户是否继续加载

### 需求 8：国际化支持

**用户故事：** 作为用户，我希望 PPTX 预览相关的界面文本支持多语言，以便不同语言的用户都能正常使用。

#### 验收标准

1. THE PptxViewer SHALL 使用 typesafe-i18n 框架管理所有界面文本
2. THE PptxViewer SHALL 提供中文、日文和英文三种语言的翻译文本
3. THE PptxViewer SHALL 对以下文本提供国际化支持：页码显示、加载提示、错误信息、不支持格式提示、文件过大警告
