# 博物馆数字图像色彩转换工具

面向馆藏数字影像的色彩管理工具。核心原则：**“给图像指定配置”与“实际转换像素”是两种独立操作**，
界面分区呈现，绝不靠只改元数据标签冒充颜色转换。

## 架构

| 层 | 文件 | 职责 |
|---|---|---|
| 原生色彩引擎 | `addon/lcms_native.cpp` | 封装系统 LittleCMS2（liblcms2 2.14）：像素变换、Lab、超色域判定、ICC 生成 |
| 图像色管内核 | `src/color-kernel.js` | 唯一业务入口。两操作分离、配置身份、审计、色差统计、结构化错误、独立验收证据 |
| 独立参考引擎 | `src/ref-engine.js` | 纯 JS 手写 ICC matrix-shaper 解析、TRC、3×3 矩阵、Bradford、Lab、CIEDE2000，**不依赖 lcms**；可独立推导相对/绝对色度转换与超色域判定 |
| 独立校验 | `src/color-verify.js` | 把实际输出像素与上述独立模型逐采样比对，产出色彩/透明/配置身份三类执行证据（不调用 lcms） |
| 受控 ICC 生成 | `src/profile-fixture.js` | 由显式参数（白点/原色/TRC/gamma）构造 ICC v4 matrix-shaper 字节，参数即事实来源 |
| 受控样例 | `test/fixtures.js` `testdata/controlled/` | 已知颜色补丁 + 受控 ICC 资料，确定性生成，随测试一同入库 |
| 容器处理 | `src/png-encode.js` `src/png-icc.js` `src/jpeg-icc.js` | 自有 8/16 位 PNG 编码、iCCP / JPEG APP2 手工嵌入，避免图像库自动改像素 |
| Web 服务 | `src/server.js` | HTTP 编排，控件选项全部来自内核 `capabilities()`，错误回传界面；提供受控样例列表与图形入口 |
| 校正界面 | `web/index.html` `web/app.js` | 两操作分区、配置切换比对、转换前后数值与色差、独立验收证据、受控样例载入 |

sharp/libvips 仅用于 JPEG 编解码与图像元信息；所有 ICC 标签由本工具手工写入容器，
因为 sharp 在嵌入非 sRGB 配置时会自动做色彩变换，会破坏已经算好的像素。

## 如何启动界面

```bash
# 1. 安装依赖（需要 gcc/g++、make、系统 liblcms2 与头文件 lcms2.h）
npm install

# 2. 编译 lcms2 原生扩展（生成 build/Release/lcms_native.node）
npm run build

# 3. 生成自制测试图像（色块/渐变/暗部/超色域/透明/无标签，输出到 testdata/）
npm run gen:images
#    生成受控色管验证样例（已知补丁 + 显式参数 ICC，输出到 testdata/controlled/）
npm run gen:fixtures

# 4. 启动影像校正界面
npm start
# 控制台打印：博物馆图像色管界面已启动: http://localhost:8080
```

浏览器打开 `http://localhost:8080`（这是图像色管的**图形入口**，命令行仅用于构建、生成样例与自动验收）。
界面分四块：

1. **选择图像并读取配置身份**——显示嵌入 ICC 的描述与 SHA-256 指纹；无嵌入时明确报缺失。
   同一区域提供**受控色管验证样例**下拉与“载入样例”按钮：已知颜色补丁与受控 ICC 可直接从界面打开，
   手动切换目标配置并比对第③/④块数值。
2. **②-A 指定配置（仅元数据）** 与 **②-B 转换到目标配置（真实像素变换）** 两个独立卡片。
3. **结果区**——转换前后采样点的 RGB 编码值与 D50 Lab、源/目标配置指纹、CIEDE2000 色差、超色域占比，并提供文件下载。
4. **独立验收证据**——纯 JS 参考引擎对本次实际输出逐采样推导的 ΔE2000、透明通道逐像素比对结果、
   实际采用的源/目标配置 SHA-256 与期望身份是否一致；失败以红色徽标与失败项列出，异常由界面提示。

## 可解释的色彩设置

- **渲染意图**：感知 / 相对色度 / 饱和度 / 绝对色度，界面在每个选项下给出适用场景与后果说明。
- **黑点补偿（BPC）**：独立开关；与绝对色度互斥，内核直接拒绝该组合（`BAD_COMBINATION`）。
- **超色域处理**：
  - `clip` 按意图裁剪到边界；
  - `gamut-check` 超界像素用品红 `(255,0,255)` 明确标记；
  - `softproof` 正常转换并统计超色域数量、占比与色差。

## 关键约束的落实方式

- **源配置缺失不自动假设色域**：无嵌入 ICC 时内核返回 `SOURCE_PROFILE_MISSING`；
  使用者必须选择一个假设配置并填写依据，假设与警告写入审计记录。
- **高位深保留精度**：16 位 PNG 经自有编码器原样落盘，像素以 `TYPE_RGB_16` 直通 lcms2，
  测试断言输出含 8 位容器无法表示的采样值。
- **透明通道不作为颜色参与变换**：原生层先把 RGB 与 alpha 拆开，RGB 过引擎、alpha 逐字节装回，
  内核再做全量不变量校验。
- **判定不依赖肉眼/显示器**：准确性以 Lab 与 CIEDE2000、配置指纹为准；浏览器显示差异不归咎于文件计算。

## 自动化核对（独立引擎 + 参考值）

```bash
npm run check       # 53 项，基础数值核对
npm run check:e2e   # 76 项，受控样例的色管端到端验收（变换语义）
npm test            # 依次执行以上两套
```

`npm run check` 覆盖：纯 JS 参考引擎与 lcms2 的 Lab 一致性（ΔE2000 < 0.5）、assign 像素逐字节不变、
convert 像素确实改变且嵌入目标配置、超色域检出与品红警报、黑点补偿暗部阶调、
16 位精度、alpha 逐字节保持、缺失源配置拒绝/假设记录、结构化错误码、JPEG APP2 往返。

`npm run check:e2e` 使用 `testdata/controlled/` 中确定性生成、随仓库入库的已知颜色补丁与受控 ICC，
把变换语义写成可执行验收：

- **期望值独立推导**：`src/ref-engine.js` 只手写解析 ICC 的 TRC / 3×3 / Bradford / Lab / CIEDE2000，
  不调用 lcms；`src/color-verify.js` 逐采样把内核实际输出与独立模型比对。相对/绝对色度可独立推导，
  感知/饱和度意图明确标记为“无独立推导”，不以默认值当成通过。
- **配置身份**：每份 ICC 生成时记录 SHA-256 与参数；断言同时核对数值和实际采用的源/目标配置身份，
  故意把 sRGB 编码内容标成 P3 再“P3→P3”变换时，同库反向往返字节完全相同（自洽但盲），
  而独立模型给出 ΔE≈7，捕获错误源空间。
- **正反例**：域外颜色用于验证超色域判定与品红警报一致性；无配置图先验断言 `SOURCE_PROFILE_MISSING`，
  再以显式 `assumeIcc` 构造可执行的正面流程。透明通道按源缓冲逐字节比对（8/16 位分别覆盖）。
- **受控错误注入**：篡改输出像素、篡改 alpha、擦除品红警报、替换目标配置，分别触发
  `color-delta-exceeds-tolerance` / `alpha-not-preserved` / `gamut-alarm-inconsistent` /
  `destination-profile-mismatch`；对照组保持通过，证明证据确实暴露坏结果而非恒真。
- 旧 `testdata/` 图像全部跑到完成为止，并附带独立验收结论，不因新验收而跳过。

命令行（`gen:images` / `gen:fixtures` / `check` / `check:e2e`）只辅助图像色管：生成样例、自动验收与构建。
日常的图像色管操作入口是上文的浏览器界面，受控样例也可在其中载入并手动切换配置比对。

## 输出文件

转换结果为真实写出的文件（PNG 8/16 位或 JPEG），嵌入目标 ICC 且像素为实际引擎计算结果，
通过界面下载链接或服务端 `/download/...` 获取。
