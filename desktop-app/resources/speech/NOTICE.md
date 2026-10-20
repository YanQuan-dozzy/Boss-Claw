# 语音组件许可证与署名

本目录说明 BossClaw「模拟面试」语音能力的第三方组件与义务。语音模型**不随安装包分发**，
由用户在应用内首次使用时下载到 `<userData>/speech/models/`；本文件随应用分发，用于履行署名义务。

## 一、当前版本（P2 朗读 + P4-A 语音作答）实际使用

| 组件 | 版本 / 形态 | 许可证 | 义务 |
| --- | --- | --- | --- |
| `sherpa-onnx-node` | 1.13.8，N-API 原生插件（随安装包分发） | **Apache-2.0** | 保留版权与许可声明 |
| sherpa-onnx 运行时 | 含 `onnxruntime` 动态库（随安装包分发） | **Apache-2.0** | 保留版权与许可声明 |
| Kokoro-82M 多语言权重 v1.1 | `kokoro-multi-lang-v1_1.tar.bz2`（运行时下载） | **Apache-2.0** | 保留版权与许可声明 |
| **SenseVoice** int8 权重 | `model.int8.onnx` + `tokens.txt`（运行时下载） | **FunASR Model License v1.1**（不是 Apache-2.0） | **署名为 Alibaba Group / FunAudioLLM，保留模型名「SenseVoice」**；协议含行为终止条款，升级模型前需复核许可 |
| **ZipVoice** distill int8 权重 | `encoder.int8.onnx` + `decoder.int8.onnx` + `lexicon.txt`（运行时下载，克隆音色） | **Apache-2.0** | 保留版权与许可声明 |
| **Vocos** 24kHz 声码器 | `vocos_24khz.onnx`（运行时下载，ZipVoice 必需） | **MIT**（vocos 上游） | 保留版权与许可声明 |

ZipVoice 上游：https://github.com/k2-fsa/ZipVoice （权重：`sherpa-onnx-zipvoice-distill-int8-zh-en-emilia`）
Vocos 声码器：https://github.com/k2-fsa/sherpa-onnx/releases/tag/vocoder-models （`vocos_24khz.onnx`）

SenseVoice 上游：https://github.com/FunAudioLLM/SenseVoice （模型分发包：`csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`）

上游链接：

- sherpa-onnx：https://github.com/k2-fsa/sherpa-onnx
- Kokoro：https://github.com/hexgrad/kokoro

## 二、后续版本（尚未接入，仅登记义务）

| 组件 | 计划用途 | 许可证 | 义务 |
| --- | --- | --- | --- |
| ZipVoice distill int8 权重 | P4 音色克隆 | Apache-2.0 | 保留版权与许可声明 |
| 用户导入的音色包 | P2 音色包导入 | 由用户自行负责 | 应用只存 `license` 字段并本地展示，不托管、不分发、不推荐下载源 |

## 三、边界说明

- 语音全部在本机合成与识别，不上传题干、简历或录音。
- 作答录音只存在内存与一次 IPC 调用里，转写后立即丢弃，不落盘。
- 克隆音色的参考音频（3–10 秒）存 `<userData>/speech/voices/<voiceId>/ref.wav`，**仅本机**、不上传、不建声纹库；用户删除音色或「清空全部数据」时物理删除。当前版本没有训练或微调环节，克隆完全由参考音频在本地推理完成。
- 本应用不使用语音能力绕过任何平台限制，也不提供声纹库或音色分享功能。
