'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VTScheduler, pageId } = require('../index.js');

const req = (texture, mip, x, y, error = 1) => ({ texture, mip, x, y, error });

// 确定性伪随机数（LCG），用于连续多帧场景。
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('加载队列按屏幕误差降序、id 字典序决胜，且与声明顺序无关', () => {
  const requests = [
    req('t', 0, 0, 0, 5),
    req('t', 0, 1, 0, 20),
    req('t', 0, 2, 0, 10),
    req('t', 0, 3, 0, 10), // 与上一个同优先级，按 id 决胜
  ];
  const shuffled = [requests[2], requests[3], requests[0], requests[1]];

  const run = (input) => {
    const s = new VTScheduler({ pageBudget: 16, ioPerFrame: 8, mipDependency: false });
    return s.update(0, input);
  };

  const a = run(requests);
  const b = run(shuffled);
  assert.deepEqual(a, b);
  assert.deepEqual(a.load, [
    pageId('t', 0, 1, 0), // error 20
    pageId('t', 0, 2, 0), // error 10，id 较小
    pageId('t', 0, 3, 0), // error 10
    pageId('t', 0, 0, 0), // error 5
  ]);
});

test('同一 tile 自动生成父 mip 依赖链，子级优先于父级', () => {
  const s = new VTScheduler({
    pageBudget: 16,
    ioPerFrame: 8,
    maxInFlight: 8,
    maxMip: 2,
  });
  const plan = s.update(0, [req('t', 0, 3, 5, 10)]);
  assert.deepEqual(plan.load, [
    pageId('t', 0, 3, 5), // error 10
    pageId('t', 1, 1, 2), // 依赖，error 9
    pageId('t', 2, 0, 1), // 依赖的依赖，error 8
  ]);
  // 依赖页同样计入内存预算约束。
  assert.ok(plan.stats.inFlight <= plan.stats.budget);
});

test('重复请求被去重，并保留最高优先级', () => {
  const s = new VTScheduler({ pageBudget: 8, ioPerFrame: 4, mipDependency: false });
  const plan = s.update(0, [
    req('t', 0, 0, 0, 3),
    req('t', 0, 0, 0, 9),
    req('t', 0, 0, 0, 1),
  ]);
  assert.deepEqual(plan.load, [pageId('t', 0, 0, 0)]);
  assert.equal(plan.stats.inFlight, 1);
});

test('内存吃紧时按 LRU 淘汰，且绝不淘汰当前帧引用的页', () => {
  const s = new VTScheduler({
    pageBudget: 3,
    ioPerFrame: 3,
    maxInFlight: 3,
    mipDependency: false,
  });
  // 第 0 帧：A、B、C 全部加载并常驻。
  const p0 = s.update(0, [req('t', 0, 0, 0, 5), req('t', 0, 1, 0, 5), req('t', 0, 2, 0, 5)]);
  for (const id of p0.load) s.resolve(id, true);
  assert.equal(s.update(1, [req('t', 0, 0, 0, 5), req('t', 0, 1, 0, 5), req('t', 0, 2, 0, 5)]).stats.resident, 3);

  // 第 2 帧：保留 A，新请求 D、E → B、C 按 LRU 被淘汰，A 保留。
  const p2 = s.update(2, [req('t', 0, 0, 0, 5), req('t', 0, 3, 0, 5), req('t', 0, 4, 0, 5)]);
  assert.deepEqual(p2.evict, [pageId('t', 0, 1, 0), pageId('t', 0, 2, 0)]);
  assert.deepEqual(p2.load, [pageId('t', 0, 3, 0), pageId('t', 0, 4, 0)]);
  assert.ok(!p2.evict.includes(pageId('t', 0, 0, 0)));
  assert.ok(p2.stats.resident + p2.stats.inFlight <= 3);
});

test('在途占满时新请求排队等待，不超在途上限', () => {
  const s = new VTScheduler({
    pageBudget: 16,
    ioPerFrame: 8,
    maxInFlight: 1,
    mipDependency: false,
  });
  const p0 = s.update(0, [req('t', 0, 0, 0, 10), req('t', 0, 1, 0, 9)]);
  assert.deepEqual(p0.load, [pageId('t', 0, 0, 0)]);
  assert.equal(p0.stats.inFlight, 1);
  // 在途未释放前，下一帧无法发起新 I/O。
  const p1 = s.update(1, [req('t', 0, 0, 0, 10), req('t', 0, 1, 0, 9)]);
  assert.deepEqual(p1.load, []);
  s.resolve(pageId('t', 0, 0, 0), true);
  const p2 = s.update(2, [req('t', 0, 0, 0, 10), req('t', 0, 1, 0, 9)]);
  assert.deepEqual(p2.load, [pageId('t', 0, 1, 0)]);
});

test('低优先级请求经老化最终获得调度，不会无限饥饿', () => {
  const s = new VTScheduler({
    pageBudget: 4,
    ioPerFrame: 1,
    maxInFlight: 1,
    agingPerFrame: 10,
    mipDependency: false,
  });
  const low = pageId('t', 0, 99, 0);
  let issuedAt = -1;
  for (let frame = 0; frame < 20; frame++) {
    // 每帧都有新的高优先级请求（error 50）与同一个低优先级请求（error 1）竞争。
    const plan = s.update(frame, [req('t', 0, frame, 1, 50), req('t', 0, 99, 0, 1)]);
    for (const id of plan.load) s.resolve(id, true);
    if (plan.load.includes(low)) {
      issuedAt = frame;
      break;
    }
  }
  // error 差 49，aging 10/帧 → 第 5 帧有效优先级反超。
  assert.equal(issuedAt, 5);
});

test('乱序完成与重复上报：结果按 id 独立处理，重复上报视为过期', () => {
  const s = new VTScheduler({ pageBudget: 8, ioPerFrame: 4, mipDependency: false });
  const plan = s.update(0, [req('t', 0, 0, 0, 10), req('t', 0, 1, 0, 9)]);
  const [a, b] = plan.load;
  // 乱序：B 先完成，A 后完成。
  assert.equal(s.resolve(b, true).status, 'resident');
  assert.equal(s.resolve(a, true).status, 'resident');
  // 重复上报 → 过期。
  assert.equal(s.resolve(a, true).status, 'stale');
  assert.equal(s.resolve('t|0|7|7', true).status, 'stale');
  assert.ok(s.isResident(a) && s.isResident(b));
});

test('取消与过期返回：不可见请求被取消，迟到结果按过期处理', () => {
  const s = new VTScheduler({ pageBudget: 8, ioPerFrame: 2, mipDependency: false });
  const id = pageId('t', 0, 0, 0);
  const p0 = s.update(0, [req('t', 0, 0, 0, 10)]);
  assert.deepEqual(p0.load, [id]);
  // 下一帧不再可见 → 在途请求被取消。
  const p1 = s.update(1, []);
  assert.deepEqual(p1.cancel, [id]);
  // 迟到的加载结果不会进入常驻集。
  assert.equal(s.resolve(id, true).status, 'stale-cancelled');
  assert.ok(!s.isResident(id));
  assert.equal(s.stats ?? s.update(2, []).stats.resident, 0);
});

test('加载失败按有限次数重试（带退避），超限后进入结构化失败状态', () => {
  const s = new VTScheduler({
    pageBudget: 8,
    ioPerFrame: 1,
    maxRetries: 2,
    retryBackoffFrames: 1,
    mipDependency: false,
  });
  const id = pageId('t', 0, 0, 0);
  const visible = () => [req('t', 0, 0, 0, 10)];

  assert.deepEqual(s.update(0, visible()).load, [id]);
  assert.deepEqual(s.resolve(id, false), { status: 'retry', retries: 1 });

  // 退避结束（nextRetryFrame = 0 + 1*1 = 1）→ 第 1 帧重发。
  assert.deepEqual(s.update(1, visible()).load, [id]);
  assert.deepEqual(s.resolve(id, false), { status: 'retry', retries: 2 });

  // 第二次退避（nextRetryFrame = 1 + 1*2 = 3）→ 第 2 帧仍在退避。
  assert.deepEqual(s.update(2, visible()).load, []);
  assert.deepEqual(s.update(3, visible()).load, [id]);
  assert.deepEqual(s.resolve(id, false), { status: 'failed', retries: 3 });

  // 超限后进入终端失败状态，通过计划结构化输出，且不再重发。
  const p4 = s.update(4, visible());
  assert.deepEqual(p4.failed, [{ id, retries: 3 }]);
  assert.deepEqual(p4.load, []);

  // 清除失败状态后可重新调度。
  s.clearFailed(id);
  assert.deepEqual(s.update(5, visible()).load, [id]);
});

test('预算边界：恰好占满时新请求被降级，不超预算也不淘汰当前帧页', () => {
  const s = new VTScheduler({
    pageBudget: 2,
    ioPerFrame: 2,
    maxInFlight: 2,
    mipDependency: false,
  });
  const p0 = s.update(0, [req('t', 0, 0, 0, 10), req('t', 0, 1, 0, 10)]);
  for (const id of p0.load) s.resolve(id, true);

  // 两个页仍可见且恰好占满预算 → 新请求 R 被降级，无淘汰、无加载。
  const p1 = s.update(1, [req('t', 0, 0, 0, 10), req('t', 0, 1, 0, 10), req('t', 0, 2, 0, 10)]);
  assert.deepEqual(p1.load, []);
  assert.deepEqual(p1.evict, []);
  assert.deepEqual(p1.deferred, [pageId('t', 0, 2, 0)]);
  assert.equal(p1.stats.resident + p1.stats.inFlight, 2);
});

test('长期不可见的常驻页超过 maxIdleFrames 后被强制淘汰', () => {
  const s = new VTScheduler({
    pageBudget: 8,
    ioPerFrame: 2,
    maxIdleFrames: 3,
    mipDependency: false,
  });
  const id = pageId('t', 0, 0, 0);
  s.resolve(s.update(0, [req('t', 0, 0, 0, 10)]).load[0], true);
  // 帧 1..3 不可见但未超阈值，帧 4 空闲 4 帧 > 3 → 强制淘汰。
  for (let f = 1; f <= 3; f++) assert.deepEqual(s.update(f, []).evict, []);
  assert.deepEqual(s.update(4, []).evict, [id]);
});

test('连续多帧模拟：内存/在途约束始终成立，结果完全可复现', () => {
  const runSimulation = () => {
    const rand = lcg(42);
    const s = new VTScheduler({
      pageBudget: 6,
      ioPerFrame: 2,
      maxInFlight: 3,
      maxRetries: 2,
      retryBackoffFrames: 1,
      agingPerFrame: 2,
      maxMip: 2,
    });
    const plans = [];
    for (let frame = 0; frame < 30; frame++) {
      // 从 12 个页中随机选取可见子集。
      const requests = [];
      for (let i = 0; i < 12; i++) {
        if (rand() < 0.4) requests.push(req('tex' + (i % 3), i % 3, i, i * 2, Math.floor(rand() * 50)));
      }
      const plan = s.update(frame, requests);
      // 随机乱序上报在途结果（含少量失败）。
      const pending = [...s.inFlight.keys()];
      for (let i = pending.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [pending[i], pending[j]] = [pending[j], pending[i]];
      }
      for (const id of pending) s.resolve(id, rand() < 0.85);

      // 每帧不变式：占用不超预算、I/O 不超限、不淘汰当前帧引用页。
      assert.ok(plan.stats.resident + plan.stats.inFlight <= 6, `frame ${frame} 超预算`);
      assert.ok(plan.load.length <= 2, `frame ${frame} 超 I/O 上限`);
      assert.ok(plan.stats.inFlight <= 3, `frame ${frame} 超在途上限`);
      const wantedIds = new Set(plan.load);
      for (const id of plan.evict) assert.ok(!wantedIds.has(id), `frame ${frame} 淘汰在载页`);
      plans.push(plan);
    }
    return plans;
  };

  const first = runSimulation();
  const second = runSimulation();
  assert.deepEqual(first, second);
  // 模拟确实产生了淘汰、取消与失败重试，而非空转。
  assert.ok(first.some((p) => p.evict.length > 0));
  assert.ok(first.some((p) => p.cancel.length > 0));
});
