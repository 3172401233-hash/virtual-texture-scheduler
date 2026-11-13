'use strict';

/**
 * VTScheduler — 虚拟纹理 mip page 调度器。
 *
 * 纯逻辑、零依赖：不触碰真实 GPU / 文件系统，只根据调用方提供的
 * 可见请求与异步加载结果，产出每帧的加载队列、淘汰集合与取消集合。
 *
 * 确定性保证：所有输出数组的顺序只取决于输入内容与异步完成顺序，
 * 与请求声明顺序、Map 插入顺序无关。
 */

function pageId(texture, mip, x, y) {
  return `${texture}|${mip}|${x}|${y}`;
}

function parsePageId(id) {
  const [texture, mip, x, y] = id.split('|');
  return { texture, mip: Number(mip), x: Number(x), y: Number(y) };
}

function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

class VTScheduler {
  /**
   * @param {object} options
   * @param {number} options.pageBudget        常驻 + 在途页的总内存预算（页数）
   * @param {number} options.ioPerFrame        每帧最多新发起的 I/O 请求数
   * @param {number} [options.maxInFlight]     在途请求上限，默认等于 ioPerFrame
   * @param {number} [options.maxRetries]      加载失败后的最大重试次数，默认 3
   * @param {number} [options.retryBackoffFrames] 每次重试的退避帧数基数，默认 2
   * @param {number} [options.agingPerFrame]   等待请求的优先级每帧增量（防饥饿），默认 1
   * @param {number} [options.maxMip]          自动父级依赖生成到的最大 mip，默认 8
   * @param {boolean} [options.mipDependency]  是否自动生成父 mip 依赖，默认 true
   * @param {number} [options.maxIdleFrames]   超过该帧数不可见的常驻页强制淘汰，默认 Infinity
   */
  constructor(options = {}) {
    const {
      pageBudget,
      ioPerFrame,
      maxInFlight = ioPerFrame,
      maxRetries = 3,
      retryBackoffFrames = 2,
      agingPerFrame = 1,
      maxMip = 8,
      mipDependency = true,
      maxIdleFrames = Infinity,
    } = options;

    for (const [name, value] of Object.entries({ pageBudget, ioPerFrame, maxInFlight })) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive integer`);
      }
    }

    this.pageBudget = pageBudget;
    this.ioPerFrame = ioPerFrame;
    this.maxInFlight = maxInFlight;
    this.maxRetries = maxRetries;
    this.retryBackoffFrames = retryBackoffFrames;
    this.agingPerFrame = agingPerFrame;
    this.maxMip = maxMip;
    this.mipDependency = mipDependency;
    this.maxIdleFrames = maxIdleFrames;

    this.frame = -1;
    this.pages = new Map(); // resident: id -> { priority, lastUsed }
    this.pending = new Map(); // queued:  id -> { priority, firstFrame, retries, nextRetryFrame }
    this.inFlight = new Map(); // loading: id -> { priority, retries, issuedFrame }
    this.failed = new Map(); // terminal: id -> retries
    this.cancelledInFlight = new Set(); // 已取消的在途请求，迟到结果按过期处理
  }

  /**
   * 推进一帧并生成调度计划。
   * @param {number} frame 帧号（应单调递增）
   * @param {Array<{texture:string,mip:number,x:number,y:number,error?:number}>} requests
   *        当前帧可见的页请求；error 为屏幕误差，越大优先级越高。
   * @returns 调度计划（见 README）
   */
  update(frame, requests = []) {
    this.frame = frame;

    // 1. 归一化 + 去重（同一页保留最高优先级），并展开父 mip 依赖。
    const wanted = new Map(); // id -> priority
    const want = (id, priority) => {
      const prev = wanted.get(id);
      if (prev === undefined || priority > prev) wanted.set(id, priority);
    };
    for (const req of requests) {
      const { texture, mip, x, y, error = 0 } = req;
      want(pageId(texture, mip, x, y), error);
      if (this.mipDependency) {
        let level = mip;
        let px = x;
        let py = y;
        while (level < this.maxMip) {
          level += 1;
          px >>= 1;
          py >>= 1;
          // 依赖优先级逐级降低，保证子级先于父级被调度。
          want(pageId(texture, level, px, py), error - (level - mip));
        }
      }
    }

    // 2. 取消不再被引用的排队 / 在途请求。
    const cancel = [];
    for (const id of this.pending.keys()) {
      if (!wanted.has(id)) {
        this.pending.delete(id);
        cancel.push(id);
      }
    }
    for (const id of this.inFlight.keys()) {
      if (!wanted.has(id)) {
        this.inFlight.delete(id);
        this.cancelledInFlight.add(id);
        cancel.push(id);
      }
    }

    // 3. 新请求入队；刷新常驻页的最近使用时间。
    for (const [id, priority] of wanted) {
      const resident = this.pages.get(id);
      if (resident) {
        resident.lastUsed = frame;
        if (priority > resident.priority) resident.priority = priority;
        continue;
      }
      if (this.inFlight.has(id) || this.failed.has(id)) continue;
      const queued = this.pending.get(id);
      if (queued) {
        if (priority > queued.priority) queued.priority = priority;
      } else {
        this.pending.set(id, {
          priority,
          firstFrame: frame,
          retries: 0,
          nextRetryFrame: frame,
        });
      }
    }

    // 4. 候选加载列表：有效优先级 = 基础优先级 + 等待帧数 * aging（防饥饿）。
    const candidates = [];
    for (const [id, p] of this.pending) {
      if (frame < p.nextRetryFrame) continue;
      candidates.push({ id, p, eff: p.priority + (frame - p.firstFrame) * this.agingPerFrame });
    }
    candidates.sort((a, b) => b.eff - a.eff || compareIds(a.id, b.id));

    const ioSlots = Math.max(0, Math.min(this.ioPerFrame, this.maxInFlight - this.inFlight.size));
    const issueList = candidates.slice(0, ioSlots);
    const waiting = candidates.slice(ioSlots); // 受 I/O / 在途上限约束而等待

    // 5. 淘汰：先强制淘汰长期不可见页，再按 LRU 淘汰以腾出预算。
    //    永不淘汰当前帧引用的页（wanted 内的页 lastUsed 已刷新为本帧）。
    const evictSet = new Set();
    for (const [id, pg] of this.pages) {
      if (!wanted.has(id) && frame - pg.lastUsed > this.maxIdleFrames) evictSet.add(id);
    }
    const evictable = [];
    for (const [id, pg] of this.pages) {
      if (wanted.has(id) || evictSet.has(id)) continue;
      evictable.push({ id, pg });
    }
    evictable.sort(
      (a, b) =>
        a.pg.lastUsed - b.pg.lastUsed ||
        a.pg.priority - b.pg.priority ||
        compareIds(a.id, b.id),
    );

    const occupancy = () =>
      this.pages.size - evictSet.size + this.inFlight.size + issueList.length;

    for (const cand of evictable) {
      if (occupancy() <= this.pageBudget) break;
      evictSet.add(cand.id);
    }

    // 6. 预算仍不足时按优先级从低到高降级（延迟），绝不超预算。
    const deferred = waiting.map((c) => ({ id: c.id, eff: c.eff }));
    while (issueList.length > 0 && occupancy() > this.pageBudget) {
      deferred.push(issueList[issueList.length - 1]);
      issueList.pop();
    }
    deferred.sort((a, b) => b.eff - a.eff || compareIds(a.id, b.id));

    // 7. 应用状态迁移。
    const load = issueList.map((c) => c.id);
    for (const c of issueList) {
      this.pending.delete(c.id);
      this.inFlight.set(c.id, {
        priority: c.p.priority,
        retries: c.p.retries,
        issuedFrame: frame,
      });
    }
    const evict = [...evictSet].sort(compareIds);
    for (const id of evictSet) this.pages.delete(id);

    return {
      frame,
      load,
      evict,
      cancel: cancel.sort(compareIds),
      deferred: deferred.map((d) => d.id),
      failed: [...this.failed.entries()]
        .map(([id, retries]) => ({ id, retries }))
        .sort((a, b) => compareIds(a.id, b.id)),
      stats: {
        budget: this.pageBudget,
        resident: this.pages.size,
        inFlight: this.inFlight.size,
        pending: this.pending.size,
        ioPerFrame: this.ioPerFrame,
        maxInFlight: this.maxInFlight,
      },
    };
  }

  /**
   * 上报一次异步加载结果（允许乱序）。
   * @returns {{status:string, retries?:number}} status ∈
   *   'resident' | 'retry' | 'failed' | 'stale' | 'stale-cancelled'
   */
  resolve(id, ok = true) {
    if (this.cancelledInFlight.has(id)) {
      this.cancelledInFlight.delete(id);
      return { status: 'stale-cancelled' };
    }
    const req = this.inFlight.get(id);
    if (!req) return { status: 'stale' };
    this.inFlight.delete(id);

    if (ok) {
      this.pages.set(id, { priority: req.priority, lastUsed: this.frame });
      return { status: 'resident' };
    }

    const retries = req.retries + 1;
    if (retries > this.maxRetries) {
      this.failed.set(id, retries);
      return { status: 'failed', retries };
    }
    this.pending.set(id, {
      priority: req.priority,
      firstFrame: this.frame,
      retries,
      nextRetryFrame: this.frame + this.retryBackoffFrames * retries,
    });
    return { status: 'retry', retries };
  }

  /** 清除终端失败状态（不传 id 则全部清除），允许后续重新请求。 */
  clearFailed(id) {
    if (id === undefined) this.failed.clear();
    else this.failed.delete(id);
  }

  isResident(id) {
    return this.pages.has(id);
  }
}

module.exports = { VTScheduler, pageId, parsePageId };
