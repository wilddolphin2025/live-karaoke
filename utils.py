"""Ellipsis Health DSA prep: 12 commented Python solutions.
Run: python3 ellipsis_dsa_prep.py  (runs quick self-tests at bottom)
"""
import asyncio, heapq, random, time
from collections import OrderedDict, deque, defaultdict


# 1. Linked-list cycle detection (Floyd) -- O(n) time, O(1) space
class Node:
    def __init__(self, val, nxt=None):
        self.val, self.next = val, nxt

def cycle_start(head):
    slow = fast = head
    while fast and fast.next:
        slow, fast = slow.next, fast.next.next   # fast moves 2x
        if slow is fast:                          # they met inside the cycle
            # Reset one pointer to head; moving both 1 step, they meet at cycle start
            slow = head
            while slow is not fast:
                slow, fast = slow.next, fast.next
            return slow
    return None                                   # fast hit the end: no cycle


# 2. Ring buffer for audio frames -- overwrite oldest when full (real-time: never block)
class RingBuffer:
    def __init__(self, capacity):
        self.buf = [None] * capacity
        self.cap, self.head, self.size = capacity, 0, 0   # head = oldest item index

    def push(self, frame):
        tail = (self.head + self.size) % self.cap
        self.buf[tail] = frame
        if self.size == self.cap:
            self.head = (self.head + 1) % self.cap        # full: drop oldest
        else:
            self.size += 1

    def pop(self):
        if self.size == 0:
            return None
        frame = self.buf[self.head]
        self.head = (self.head + 1) % self.cap
        self.size -= 1
        return frame


# 3. Jitter buffer -- reorder RTP-like packets by 16-bit sequence number
SEQ_MOD = 1 << 16

def seq_newer(a, b):
    """True if seq a is after b, handling wraparound (RFC 1982 style)."""
    return 0 < ((a - b) % SEQ_MOD) < SEQ_MOD // 2

class JitterBuffer:
    def __init__(self, depth=3):
        self.depth = depth          # packets to hold before releasing (latency vs. reorder tolerance)
        self.pending = {}           # seq -> payload
        self.next_seq = None        # next seq we expect to play

    def push(self, seq, payload):
        if self.next_seq is None:
            self.next_seq = seq
        if seq != self.next_seq and not seq_newer(seq, self.next_seq):
            return                  # late packet, already played past it: drop
        self.pending[seq] = payload

    def pop_ready(self):
        out = []
        # Release in order; if we're holding too many, skip a missing packet (packet loss)
        while self.pending:
            if self.next_seq in self.pending:
                out.append(self.pending.pop(self.next_seq))
            elif len(self.pending) >= self.depth:
                out.append(None)    # gap -> caller can do packet-loss concealment
            else:
                break
            self.next_seq = (self.next_seq + 1) % SEQ_MOD
        return out


# 4. Rechunk arbitrary byte chunks into fixed 20 ms PCM frames
def frame_bytes(sample_rate=16000, channels=1, sample_width=2, ms=20):
    return sample_rate * channels * sample_width * ms // 1000   # 16kHz mono s16 -> 640 bytes

class Rechunker:
    def __init__(self, size):
        self.size, self.carry = size, bytearray()

    def feed(self, chunk):
        self.carry += chunk
        frames = []
        while len(self.carry) >= self.size:
            frames.append(bytes(self.carry[:self.size]))
            del self.carry[:self.size]   # keep remainder for next call
        return frames


# 5. Merge overlapping intervals (e.g. VAD speech segments) -- O(n log n)
def merge_intervals(segs):
    out = []
    for s, e in sorted(segs):
        if out and s <= out[-1][1]:          # overlaps previous
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


# 6a. Sliding-window rate limiter: at most `limit` events per `window` seconds
class SlidingWindowLimiter:
    def __init__(self, limit, window):
        self.limit, self.window, self.events = limit, window, deque()

    def allow(self, now=None):
        now = time.monotonic() if now is None else now
        while self.events and now - self.events[0] >= self.window:
            self.events.popleft()            # evict expired timestamps
        if len(self.events) < self.limit:
            self.events.append(now)
            return True
        return False

# 6b. Token bucket: allows bursts up to capacity, refills at rate/sec
class TokenBucket:
    def __init__(self, rate, capacity):
        self.rate, self.cap = rate, capacity
        self.tokens, self.last = capacity, time.monotonic()

    def allow(self, cost=1):
        now = time.monotonic()
        self.tokens = min(self.cap, self.tokens + (now - self.last) * self.rate)
        self.last = now
        if self.tokens >= cost:
            self.tokens -= cost
            return True
        return False


# 7. LRU cache with TTL -- O(1) get/put using OrderedDict
class LRUTTLCache:
    def __init__(self, capacity, ttl):
        self.cap, self.ttl, self.d = capacity, ttl, OrderedDict()  # key -> (value, expires_at)

    def get(self, key, now=None):
        now = time.monotonic() if now is None else now
        item = self.d.get(key)
        if item is None:
            return None
        value, exp = item
        if now >= exp:                     # expired: lazy delete
            del self.d[key]
            return None
        self.d.move_to_end(key)            # mark most recently used
        return value

    def put(self, key, value, now=None):
        now = time.monotonic() if now is None else now
        self.d[key] = (value, now + self.ttl)
        self.d.move_to_end(key)
        if len(self.d) > self.cap:
            self.d.popitem(last=False)     # evict least recently used


# 8a. Top-K frequent items -- size-K min-heap, O(n log k)
def top_k(items, k):
    counts = defaultdict(int)
    for x in items:
        counts[x] += 1
    return [x for _, x in heapq.nlargest(k, ((c, x) for x, c in counts.items()))]

# 8b. Streaming median (p50) with two heaps -- O(log n) insert, O(1) query
class RunningMedian:
    def __init__(self):
        self.lo, self.hi = [], []          # lo = max-heap (negated), hi = min-heap

    def add(self, x):
        heapq.heappush(self.lo, -x)
        heapq.heappush(self.hi, -heapq.heappop(self.lo))   # keep lo <= hi
        if len(self.hi) > len(self.lo):                   # rebalance sizes
            heapq.heappush(self.lo, -heapq.heappop(self.hi))

    def median(self):
        if len(self.lo) > len(self.hi):
            return -self.lo[0]
        return (-self.lo[0] + self.hi[0]) / 2
# (For p99 in production: fixed-bucket histogram or t-digest, not exact heaps.)


# 9. Merge K sorted streams (e.g. timestamped events from pipeline stages)
def merge_k(streams):
    heap = []
    iters = [iter(s) for s in streams]
    for i, it in enumerate(iters):
        first = next(it, None)
        if first is not None:
            heapq.heappush(heap, (first, i))   # i breaks ties, keeps it stable
    while heap:
        val, i = heapq.heappop(heap)
        yield val
        nxt = next(iters[i], None)
        if nxt is not None:
            heapq.heappush(heap, (nxt, i))


# 10. Topological sort (Kahn) -- startup order of pipeline stages; detects cycles
def topo_order(deps):
    """deps: {node: [nodes it depends on]}"""
    indeg, children = defaultdict(int), defaultdict(list)
    nodes = set(deps)
    for n, reqs in deps.items():
        for r in reqs:
            nodes.add(r)
            children[r].append(n)
            indeg[n] += 1
    q = deque(n for n in nodes if indeg[n] == 0)
    order = []
    while q:
        n = q.popleft()
        order.append(n)
        for c in children[n]:
            indeg[c] -= 1
            if indeg[c] == 0:
                q.append(c)
    if len(order) != len(nodes):
        raise ValueError("dependency cycle")
    return order


# 11. Retry with exponential backoff + jitter, and idempotent dedup
async def retry(fn, attempts=5, base=0.1, cap=5.0):
    for i in range(attempts):
        try:
            return await fn()
        except Exception:
            if i == attempts - 1:
                raise
            # "full jitter": random delay in [0, min(cap, base*2^i)] avoids thundering herd
            await asyncio.sleep(random.uniform(0, min(cap, base * 2 ** i)))

class Deduper:
    """Remembers message IDs for `ttl` seconds so redelivered messages are processed once."""
    def __init__(self, ttl):
        self.ttl, self.seen = ttl, OrderedDict()   # insertion order == time order

    def first_time(self, msg_id, now=None):
        now = time.monotonic() if now is None else now
        while self.seen and next(iter(self.seen.values())) <= now:
            self.seen.popitem(last=False)          # expire old IDs
        if msg_id in self.seen:
            return False
        self.seen[msg_id] = now + self.ttl
        return True


# 12. Async producer/consumer with back-pressure (bounded queue)
async def pipeline(n_frames=20):
    q = asyncio.Queue(maxsize=5)   # bound = back-pressure: producer waits when full

    async def producer():
        for i in range(n_frames):
            await q.put(i)          # blocks if consumer is slow
        await q.put(None)           # sentinel: end of stream

    async def consumer(out):
        while (item := await q.get()) is not None:
            await asyncio.sleep(0.001)   # simulate ASR work
            out.append(item)

    out = []
    await asyncio.gather(producer(), consumer(out))
    return out
# Talking point: for live audio you may prefer DROP-oldest (put_nowait + get_nowait
# on QueueFull) over blocking, since stale audio is worse than missing audio.


# ---- quick self-tests ----
if __name__ == "__main__":
.    a, b, c = Node(1), Node(2), Node(3); a.next, b.next, c.next = b, c, b
    assert cycle_start(a) is b

    rb = RingBuffer(2); [rb.push(x) for x in (1, 2, 3)]; assert rb.pop() == 2

    jb = JitterBuffer(); jb.push(65535, "a"); jb.push(1, "c"); jb.push(0, "b")
    assert jb.pop_ready() == ["a", "b", "c"]

    rc = Rechunker(frame_bytes()); assert len(rc.feed(b"\0" * 1500)) == 2 and len(rc.carry) == 220

    assert merge_intervals([(1, 3), (2, 6), (8, 10)]) == [[1, 6], [8, 10]]

    lim = SlidingWindowLimiter(2, 1.0)
    assert [lim.allow(t) for t in (0, 0.1, 0.2, 1.05)] == [True, True, False, True]

    cache = LRUTTLCache(2, ttl=10); cache.put("a", 1, 0); cache.put("b", 2, 0)
    cache.get("a", 1); cache.put("c", 3, 1); assert cache.get("b", 1) is None
    assert cache.get("a", 11) is None

    assert top_k("aabbbc", 1) == ["b"]
    rm = RunningMedian(); [rm.add(x) for x in (5, 1, 3, 2)]; assert rm.median() == 2.5

    assert list(merge_k([[1, 4], [2, 3], [0]])) == [0, 1, 2, 3, 4]
    assert topo_order({"asr": ["audio"], "llm": ["asr"], "audio": []}) == ["audio", "asr", "llm"]

    d = Deduper(5); assert d.first_time("m1", 0) and not d.first_time("m1", 1) and d.first_time("m1", 6)

    assert asyncio.run(pipeline()) == list(range(20))
    print("all tests passed")
