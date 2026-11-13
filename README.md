# vt-page-scheduler

零依赖的 Node.js 虚拟纹理（Virtual Texture）mip page 调度库。它为游戏引擎决定每一帧需要**加载、保留、取消和淘汰**哪些纹理页。库为纯调度逻辑：不访问真实 GPU 或文件系统，I/O 由调用方模拟执行并异步回报结果。

## 运行测试

```bash
npm test   # 等价于 node --test
```

要求 Node.js >= 18（使用内置 `node:test`）。

## 快速上手

```js
const { VTScheduler, pageId } = require('./index.js');

const scheduler = new VTScheduler({
  pageBudget: 256,   // 常驻 + 在途页的总内存预算
  ioPerFrame: 8,     // 每帧最多新发起的 I/O 数
  maxInFlight: 16,   // 在途请求上限（默认等于 ioPerFrame）
});

// 每帧：上报当前可见的页请求，获得调度计划
const plan = scheduler.update(frame, [
  { texture: 'albedo', mip: 0, x: 3, y: 5, error: 12.5 },
  { texture: 'albedo', mip: 1, x: 1, y: 2, error: 4.0 },
]);

// 调用方按 plan.load 模拟异步 I/O，完成后（允许乱序）回报结果：
scheduler.resolve(plan.load[0], true);   // 成功
scheduler.resolve(plan.load[1], false);  // 失败 → 自动按有限次数重试
```

## API

### `new VTScheduler(options)`

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `pageBudget` | 必填 | 常驻页 + 在途页的总预算（页数），任何情况下不会被超出 |
| `ioPerFrame` | 必填 | 每帧最多新发起的加载请求数 |
| `maxInFlight` | `ioPerFrame` | 同时在途的加载请求上限 |
| `maxRetries` | `3` | 加载失败后的最大重试次数 |
| `retryBackoffFrames` | `2` | 重试退避基数：第 n 次重试需等待 `n * retryBackoffFrames` 帧 |
| `agingPerFrame` | `1` | 排队请求每等待一帧的优先级增量（防饥饿） |
| `maxMip` | `8` | 自动父级依赖生成到的最大 mip 层级 |
| `mipDependency` | `true` | 是否为每个请求自动生成父 mip 依赖链 |
| `maxIdleFrames` | `Infinity` | 常驻页连续不可见超过该帧数后被强制淘汰 |

### `scheduler.update(frame, requests) → plan`

推进一帧。`requests` 为当前帧可见页数组：`{ texture, mip, x, y, error }`，`error` 为屏幕误差，**越大优先级越高**。返回计划：

```js
{
  frame,
  load: [...],      // 本帧应发起的加载（按有效优先级降序）
  evict: [...],     // 本帧应淘汰的常驻页（id 字典序）
  cancel: [...],    // 不再可见、应取消的排队/在途请求
  deferred: [...],  // 因 I/O、在途或内存预算不足而延后的请求
  failed: [{ id, retries }],  // 已达重试上限的终端失败页（结构化状态）
  stats: { budget, resident, inFlight, pending, ioPerFrame, maxInFlight },
}
```

### `scheduler.resolve(id, ok) → { status, retries? }`

上报一次异步加载结果，允许乱序。`status`：

- `resident`：加载成功，页已常驻
- `retry`：加载失败，已按退避策略重新排队
- `failed`：重试次数超限，进入终端失败状态（经 `plan.failed` 输出）
- `stale`：不在在途集合中的过期结果（如重复上报），直接忽略
- `stale-cancelled`：已被取消的请求的迟到结果，直接忽略

### 其他方法

- `clearFailed(id?)`：清除终端失败状态（不传 id 则全部清除），允许页被重新请求
- `isResident(id)`：查询页是否常驻
- `pageId(texture, mip, x, y)` / `parsePageId(id)`：页 id 与结构互转

## 调度规则

**优先级**：有效优先级 = 屏幕误差 + 等待帧数 × `agingPerFrame`。误差越大越优先；老化机制保证低优先级请求最终会被调度，不会无限饥饿，高优先级请求也总是先于低优先级得到满足。

**mip 依赖**：请求 `(t, m, x, y)` 自动依赖父级 `(t, m+1, x>>1, y>>1)`，直至 `maxMip`。依赖优先级逐级递减，保证子级先调度；依赖页同样受内存与在途约束，且与直接请求一样参与淘汰保护。

**淘汰**：淘汰候选仅限未被当前帧引用的常驻页，按 `最近可见帧 → 优先级 → id` 升序（LRU）选择；超过 `maxIdleFrames` 未可见的页无条件淘汰。**当前帧引用的页（含依赖）永远不会被淘汰。**

**预算不足时的降级顺序**（明确、不悄然超预算）：

1. 淘汰超过 `maxIdleFrames` 的空闲页；
2. 按 LRU 淘汰未被当前帧引用的页；
3. 仍不足时，按有效优先级从低到高将新请求放入 `deferred` 延后。

**失败重试**：失败页重新排队，第 n 次重试前退避 `n × retryBackoffFrames` 帧；超过 `maxRetries` 次后进入终端失败状态，通过 `plan.failed` 结构化输出，需 `clearFailed()` 后才能重新调度。

**确定性**：所有输出数组在生成前均按（有效优先级降序，id 字典序决胜）或纯 id 字典序排序。相同输入与相同异步完成顺序必然产生逐项一致的计划，与请求声明顺序、Map 插入/遍历顺序无关。

## 已知边界

- 页 id 为字符串 `texture|mip|x|y`，`texture` 中不得包含 `|` 字符。
- 父 mip 坐标按 2 的幂整除（`>>1`）计算，与常见的四叉树虚拟纹理一致；非 2 幂页尺寸需调用方自行映射。
- 若当前帧必需页（含依赖）本身超过 `pageBudget`，超出部分进入 `deferred`——调度器不会超预算，但也无法保证该帧完整渲染，需调用方提高预算或减少请求。
- 终端失败页在 `clearFailed()` 前即使仍可见也不会重试，避免失败风暴。
- 帧号由调用方提供，应单调递增；库不做强制校验。
