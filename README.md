# 智能页面翻译 (Smart Page Translator)

一键翻译整个网页，支持 Edge 和 Google 翻译引擎。

## 功能

- 一键翻译整个网页
- 支持 Edge翻译 (推荐) 和 Google翻译
- 自动检测页面语言
- 缓存翻译结果
- 支持懒加载内容翻译

## 安装

### 开发者模式安装

1. 打开 Chrome，进入 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」

## 使用方法

1. 点击浏览器工具栏的插件图标
2. 选择目标语言
3. 选择翻译引擎 (Edge/Google)
4. 点击「翻译」按钮
5. 翻译完成后，点击「恢复原文」可还原

## 项目结构

```
smart-page-translator/
├── manifest.json      # 插件配置
├── background.js      # 后台服务 (翻译API)
├── content.js        # 内容脚本 (页面处理)
├── popup.html        # 弹窗界面
├── popup.js          # 弹窗逻辑
├── style.css         # 样式
├── icons/            # 图标 (16/32/48/128px)
├── .gitignore         # Git忽略配置
└── README.md          # 项目文档
```
