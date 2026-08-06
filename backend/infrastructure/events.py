"""EventHub — in-process topic broadcast (SSE substrate).

Generic async pub/sub used by download progress (Wave 2) and
Studio streaming (Wave 3). One hub instance lives in ServiceRegistry.
Each topic keeps a bounded replay buffer so late subscribers (e.g. an
SSE client connecting after a fast phase completed) catch up on history.
"""

import asyncio
from collections import defaultdict, deque
from contextlib import asynccontextmanager


class EventHub:
    def __init__(self, replay_size: int = 200) -> None:
        self._subscribers: dict[str, set[asyncio.Queue]] = defaultdict(set)
        self._history: dict[str, deque] = defaultdict(lambda: deque(maxlen=replay_size))

    def publish(self, topic: str, event: dict) -> None:
        """Fan out to all subscribers (non-blocking; drops full queues).

        History is only kept for topics with live subscribers — fan-out to
        per-item topics nobody subscribed to would grow memory without bound
        (AXIOM §7.3 / §19.2).
        """
        if topic in self._subscribers:
            self._history[topic].append(event)
        for q in self._subscribers.get(topic, ()):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass

    @asynccontextmanager
    async def subscribe(self, topic: str, maxsize: int = 256, replay: bool = True):
        q: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        if replay:
            for event in self._history.get(topic, ()):
                try:
                    q.put_nowait(event)
                except asyncio.QueueFull:
                    break
        self._subscribers[topic].add(q)
        try:
            yield q
        finally:
            self._subscribers[topic].discard(q)
            if not self._subscribers[topic]:
                self._subscribers.pop(topic, None)
                self._history.pop(topic, None)
